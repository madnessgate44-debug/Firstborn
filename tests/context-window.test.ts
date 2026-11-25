import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWindowedContext, extractTaskTerms } from '../src/agent/context-window.ts';
import { isHarnessSeparatorAnchor } from '../src/agent/forge.ts';

const big = Array.from({ length: 2000 }, (_, i) => `const filler${i} = ${i}; // padding line ${i}`);
big[1500] = "  const installCommand = runCheck('npm install', worktree);";
const BIG = big.join('\n');

test('task terms: quoted strings are strong, identifiers weak', () => {
  const t = extractTaskTerms("Change the check that runs 'npm install' in applyChangesToWorktree");
  assert.ok(t.strong.includes('npm install'));
  assert.ok(t.weak.includes('applyChangesToWorktree'));
});

test('excerpt is bounded, contains the targeted line, and marks omitted ranges', () => {
  assert.ok(BIG.length > 16000);
  const w = buildWindowedContext(BIG, "replace the 'npm install' check");
  assert.ok(w);
  assert.ok(w.excerpt.length <= 14000, `excerpt too large: ${w.excerpt.length}`);
  assert.ok(w.excerpt.includes("runCheck('npm install', worktree)"));
  assert.ok(w.excerpt.includes('<<<FORGE_OMITTED'));
  assert.ok(w.shownLines < w.totalLines);
  assert.ok(w.excerpt.startsWith('const filler0'));
});

test('no matching term means no excerpt (Forge keeps blocking instead of guessing)', () => {
  assert.equal(buildWindowedContext(BIG, 'zzzqqq nothing relevant here'), null);
});

test('the omitted-lines marker can never be used as an edit anchor', () => {
  assert.equal(isHarnessSeparatorAnchor('<<<FORGE_OMITTED 120 lines>>>'), true);
});

test('forge validates anchors against the full file, not the excerpt', () => {
  const src = readFileSync(new URL('../src/agent/forge.ts', import.meta.url), 'utf8');
  assert.match(src, /validationFiles = contextFiles\.map/);
  assert.equal((src.match(/findEditAnchorProblems\(report\.plannedChanges, validationFiles\)/g) ?? []).length, 3);
  assert.equal((src.match(/findEditAnchorProblems\(report\.plannedChanges, contextFiles\)/g) ?? []).length, 0);
});

test('real case: forge.ts itself is over the old limit and yields an excerpt around the install loop', () => {
  const src = readFileSync(new URL('../src/agent/forge.ts', import.meta.url), 'utf8');
  assert.ok(src.length > 16000);
  const w = buildWindowedContext(src, "use 'npm ci' where the first install check runs 'npm install' inside 'for (let attempt = 0; attempt < 3'");
  assert.ok(w && w.excerpt.includes("this.testRunner.runCheck('npm install', worktree)"));
});

import { applyExactEdits } from '../src/agent/stages.ts';
import { MAX_WINDOWED_FILE_CHARS } from '../src/agent/context-window.ts';

test('non-unique anchor is rejected against the full file even if the excerpt shows it once', () => {
  const lines = Array.from({ length: 1500 }, (_, i) => `const filler${i} = ${i}; // padding ${i}`);
  lines[10] = "  runCheck('npm install', worktree);";
  lines[1400] = "  runCheck('npm install', worktree);";
  const full = lines.join('\n');
  const w = buildWindowedContext(full, "change the 'npm install' call");
  assert.ok(w);
  assert.equal((w.excerpt.match(/runCheck\('npm install', worktree\)/g) ?? []).length >= 1, true);
  const res = applyExactEdits(full, [{ find: "runCheck('npm install', worktree);", replace: "runCheck('npm ci', worktree);" }]);
  assert.equal(res.ok, false);
});

test('anchor that exists only in the omitted region is rejected by the excerpt-visible rule only when absent from full file', () => {
  const lines = Array.from({ length: 1500 }, (_, i) => `const filler${i} = ${i}; // padding ${i}`);
  lines[700] = "const uniqueTarget = 'here';";
  const full = lines.join('\n');
  const ok = applyExactEdits(full, [{ find: "const uniqueTarget = 'here';", replace: "const uniqueTarget = 'there';" }]);
  assert.equal(ok.ok, true);
  const bad = applyExactEdits(full, [{ find: "const uniqueTarget = 'gone';", replace: 'x' }]);
  assert.equal(bad.ok, false);
});

test('excerpt budget is respected and total lines accounting holds', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} 'npm install' hit`);
  const w = buildWindowedContext(lines.join('\n'), "the 'npm install' call", 3000);
  assert.ok(w);
  assert.ok(w.excerpt.length <= 3000 + 3000, 'only head plus whole windows that fit the budget');
  assert.equal(w.totalLines, 5000);
  assert.ok(w.shownLines >= 30);
});

test('oversize ceiling constant is 600k and the forge guard uses it', () => {
  assert.equal(MAX_WINDOWED_FILE_CHARS, 600_000);
  const src = readFileSync(new URL('../src/agent/forge.ts', import.meta.url), 'utf8');
  assert.match(src, /file\.content\.length <= MAX_WINDOWED_FILE_CHARS/);
});
