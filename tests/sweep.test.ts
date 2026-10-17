import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelResult } from '../src/company/model.ts';
import {
  splitFile,
  planSweep,
  computeCoverage,
  runSweep,
  renderFullAuditMarkdown,
  runFullCoverageAudit,
  buildSweepPrompt,
  DEFAULT_MAX_CHARS_PER_SEGMENT,
  type SweepModel,
} from '../src/company/sweep.ts';

// A structural double at the model boundary, typed against the generic
// `completeJson<T>` signature so the double matches the real interface.
function stubModel(handler: () => { value: any; result: ModelResult }): SweepModel {
  return { completeJson: async <T,>() => handler() as { value: T | null; result: ModelResult } };
}

// The sweep is the guarantee that a full audit really covers 100% of a repo.
// The pure planner/coverage logic is proven here with no network; the runner is
// proven with a structural double at the model boundary.

test('sweep: splitFile keeps a small file whole and splits a large one at line boundaries', () => {
  assert.deepEqual(splitFile('a\nb\nc', 1000), ['a\nb\nc']);
  const big = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  const parts = splitFile(big, 50);
  assert.ok(parts.length > 1, 'a file larger than the cap must be split');
  // No content is lost: rejoining the parts restores the original exactly.
  assert.equal(parts.join('\n'), big);
});

test('sweep: splitFile keeps a single over-long line intact rather than corrupting it', () => {
  const oneLine = 'x'.repeat(500);
  const parts = splitFile(oneLine, 100);
  assert.deepEqual(parts, [oneLine]);
});

test('sweep: planSweep covers every file exactly once (no file dropped, no file duplicated)', () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 60; i += 1) corpus[`src/f${String(i).padStart(2, '0')}.ts`] = 'y'.repeat(3000);
  const plan = planSweep(corpus, { maxCharsPerSegment: 2000, maxCharsPerChunk: 4000 });
  assert.deepEqual(plan.files, Object.keys(corpus).sort());
  const seen = new Map<string, number>();
  for (const chunk of plan.chunks) {
    for (const segment of chunk.segments) seen.set(segment.path, (seen.get(segment.path) ?? 0) + 1);
  }
  assert.equal(seen.size, plan.files.length, 'every file appears in the plan');
  for (const path of plan.files) assert.ok((seen.get(path) ?? 0) >= 1, `${path} must be planned`);
});

test('sweep: a file larger than one segment is split into numbered parts that all appear', () => {
  const corpus = { 'src/huge.ts': Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n') };
  const plan = planSweep(corpus, { maxCharsPerSegment: 100, maxCharsPerChunk: 100 });
  const segments = plan.chunks.flatMap((c) => c.segments).filter((s) => s.path === 'src/huge.ts');
  assert.ok(segments.length > 1);
  assert.deepEqual(segments.map((s) => s.part), segments.map((_, i) => i + 1));
  assert.ok(segments.every((s) => s.parts === segments.length));
});

test('sweep: coverage is 100% only when every chunk answered', () => {
  const corpus = { 'a.ts': 'x'.repeat(2000), 'b.ts': 'y'.repeat(2000), 'c.ts': 'z'.repeat(2000) };
  const plan = planSweep(corpus, { maxCharsPerSegment: 1000, maxCharsPerChunk: 1000 });
  const all = computeCoverage(plan, []);
  assert.equal(all.examinedFiles, 3);
  assert.equal(all.percent, 100);
  assert.equal(all.failedChunks, 0);

  // Failing one chunk must downgrade its files and never round up to 100%.
  const failedId = plan.chunks[0].id;
  const partial = computeCoverage(plan, [failedId]);
  assert.equal(partial.failedChunks, 1);
  assert.ok(partial.examinedFiles < 3, 'a failed chunk must reduce examined files');
  assert.ok(partial.percent < 100);
});

test('sweep: a fully unread file is reported as not examined, never as examined', () => {
  const corpus = { 'a.ts': 'x'.repeat(500) };
  const plan = planSweep(corpus, { maxCharsPerSegment: 1000, maxCharsPerChunk: 1000 });
  const cov = computeCoverage(plan, plan.chunks.map((c) => c.id));
  assert.equal(cov.examinedFiles, 0);
  assert.deepEqual(cov.notExamined, ['a.ts']);
  assert.equal(cov.percent, 0);
});

test('sweep: the prompt fences file content as untrusted and forbids inventing paths', () => {
  const plan = planSweep({ 'src/a.ts': 'const x = 1;' });
  const prompt = buildSweepPrompt({
    target: 'o/r', commit: 'abc', chunk: plan.chunks[0], chunkIndex: 1, chunkCount: 1, fileCount: 1, maxFindings: 5,
  });
  assert.match(prompt, /UNTRUSTED INPUT/);
  assert.match(prompt, /Never invent paths/i);
  assert.match(prompt, /--- FILE: src\/a\.ts ---/);
});

test('sweep: runSweep accepts findings that cite a real file and drops invented paths', async () => {
  const corpus = { 'src/a.ts': 'const x = 1;' };
  const plan = planSweep(corpus);
  const model = stubModel(() => ({
    value: {
      summary: 's',
      findings: [
        { severity: 'HIGH', title: 'real', paths: ['src/a.ts'], basis: 'observed', evidence: 'e', recommendation: 'r' },
        { severity: 'HIGH', title: 'invented', paths: ['src/nope.ts'], basis: 'observed', evidence: 'e', recommendation: 'r' },
      ],
    },
    result: { text: '{}', model: 'm', provider: 'p', success: true },
  }));
  const result = await runSweep({ model, plan, target: 'o/r', commit: 'abc' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'real');
  assert.equal(result.coverage.percent, 100);
});

test('sweep: a failed chunk is recorded and its files are not counted as examined', async () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 4; i += 1) corpus[`f${i}.ts`] = 'x'.repeat(1500);
  const plan = planSweep(corpus, { maxCharsPerSegment: 800, maxCharsPerChunk: 800 });
  let calls = 0;
  const model = stubModel(() => {
    calls += 1;
    if (calls === 1) return { value: null, result: { text: '', model: 'm', provider: 'p', success: false, error: 'boom' } };
    return { value: { findings: [] }, result: { text: '{}', model: 'm', provider: 'p', success: true } };
  });
  const result = await runSweep({ model, plan, target: 'o/r', commit: 'abc' });
  assert.equal(result.coverage.failedChunks, 1);
  assert.ok(result.coverage.percent < 100);
  assert.equal(result.chunkNotes.filter((n) => !n.ok).length, 1);
});

test('sweep: runFullCoverageAudit reports 100% coverage and renders the ledger', async () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 20; i += 1) corpus[`src/f${i}.ts`] = 'y'.repeat(2000);
  const model = stubModel(() => ({
    value: { findings: [{ severity: 'LOW', title: 't', paths: ['src/f0.ts'], basis: 'observed', evidence: 'e', recommendation: 'r' }] },
    result: { text: '{}', model: 'm', provider: 'p', success: true },
  }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, sweep: { maxCharsPerSegment: 1000, maxCharsPerChunk: 4000 } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.coverage.percent, 100);
  assert.equal(result.coverage.examinedFiles, 20);
  assert.match(result.markdown, /Files examined: 20\/20 \(100%\)/);
  assert.match(result.markdown, /## Guarantees/);
});

test('sweep: runFullCoverageAudit is BLOCKED (not a clean pass) when the corpus is empty', async () => {
  const model = stubModel(() => ({ value: { findings: [] }, result: { text: '{}', model: 'm', provider: 'p', success: true } }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus: null });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /could not read the target corpus/);
  assert.equal(result.findings.length, 0);
});

test('sweep: the rendered report names unexamined files instead of implying full coverage', () => {
  const md = renderFullAuditMarkdown({
    target: 'o/r',
    commit: 'abc',
    fileCount: 2,
    findings: [],
    coverage: { totalFiles: 2, examinedFiles: 1, percent: 50, totalChunks: 2, succeededChunks: 1, failedChunks: 1, partialFiles: [], notExamined: ['b.ts'] },
    chunkNotes: [],
    route: { provider: 'p', model: 'm' },
    status: 'COMPLETED',
    reason: 'r',
  });
  assert.match(md, /Files examined: 1\/2 \(50%\)/);
  assert.match(md, /NOT examined: b\.ts/);
});

test('sweep: the default segment cap is a positive, usable number', () => {
  assert.ok(DEFAULT_MAX_CHARS_PER_SEGMENT >= 4000);
});
