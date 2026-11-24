import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanJsonWithSalvage, repairTruncatedJson } from '../src/agent/plan-salvage.ts';
import { validateModelPlanShape, selectSalvagedPlan, buildSalvagePartialBlockerReason } from '../src/agent/forge.ts';

test('clean JSON passes through without salvage', () => {
  const text = JSON.stringify({ requirements: [], changes: [{ path: 'a.ts', action: 'create', content: 'x' }] });
  const result = parsePlanJsonWithSalvage(text);
  assert.equal(result.salvaged, false);
  assert.deepEqual((result.plan as any).changes[0].path, 'a.ts');
});

test('markdown-fence-wrapped valid JSON passes through without salvage', () => {
  const text = '```json\n{"requirements":[],"changes":[{"path":"a.ts","action":"create","content":"x"}]}\n```';
  const result = parsePlanJsonWithSalvage(text);
  assert.equal(result.salvaged, false);
  assert.equal((result.plan as any).changes.length, 1);
});

test('truncation mid-string recovers the completed changes only', () => {
  const text = JSON.stringify({
    requirements: [{ id: 'REQ-1', description: 'add sum' }],
    changes: [
      { path: 'sum.js', action: 'create', content: 'export const sum=(a,b)=>a+b;' },
      { path: 'mul.js', action: 'create', content: 'export const mul=(a,b)=>a*b;' },
    ],
  });
  // Cut inside the second change's content string.
  const cutPoint = text.indexOf('mul=(a,b)') + 3;
  const truncated = text.slice(0, cutPoint);
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  const shape = validateModelPlanShape(result.plan);
  assert.equal(shape.ok, true);
  assert.equal(shape.changes.length, 1);
  assert.equal(shape.changes[0].path, 'sum.js');
  assert.equal(shape.requirements.length, 1);
});

test('truncation after a comma strands no comma and closes containers', () => {
  const truncated = '{"requirements":[],"changes":[{"path":"a.ts","action":"create","content":"x"}],';
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  assert.deepEqual(result.plan, { requirements: [], changes: [{ path: 'a.ts', action: 'create', content: 'x' }] });
});

test('a dangling key is never kept: cut backs up to the last completed value', () => {
  const truncated = '{"summary":"stage 1","changes":[{"path":"a.ts","action":"create","content":"x"}],"rea';
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  assert.deepEqual(result.plan, { summary: 'stage 1', changes: [{ path: 'a.ts', action: 'create', content: 'x' }] });
});

test('truncation mid-number drops the whole containing object, never the partial number', () => {
  // "maxFiles": 12 could be the start of 1234; neither it nor its parent
  // object may survive: only completed containers are kept.
  const truncated = '{"changes":[],"limits":{"maxFiles":12';
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  assert.deepEqual(result.plan, { changes: [] });
});

test('fully closed nested objects survive a later truncation', () => {
  const truncated = '{"changes":[],"meta":{"maxFiles":12,"ok":true},"tail';
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  assert.deepEqual(result.plan, { changes: [], meta: { maxFiles: 12, ok: true } });
});

test('a partial array item is dropped, completed siblings are kept', () => {
  const truncated = '{"edits":[{"find":"a","replace":"b"},{"find":"c","repl';
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  assert.deepEqual(result.plan, { edits: [{ find: 'a', replace: 'b' }] });
});

test('escaped quotes near the cut are handled', () => {
  const truncated = '{"changes":[{"path":"a.ts","action":"create","content":"he said \\"hi\\" ok"}],"note":"abc';
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  assert.equal((result.plan as any).changes[0].content, 'he said "hi" ok');
});

test('fence-wrapped truncation salvages after unwrapping', () => {
  const truncated = '```json\n{"requirements":[],"changes":[{"path":"a.ts","action":"create","content":"x"}],"summ';
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  assert.equal((result.plan as any).changes.length, 1);
});

test('non-JSON garbage cannot be salvaged', () => {
  const result = parsePlanJsonWithSalvage('I cannot help with that request.');
  assert.equal(result.plan, null);
  assert.equal(result.salvaged, false);
});

test('complete JSON followed by trailing prose is not treated as truncation', () => {
  const result = parsePlanJsonWithSalvage('{"changes":[]} trailing words');
  assert.equal(result.plan, null);
});

test('truncation before any completed value recovers nothing', () => {
  const result = parsePlanJsonWithSalvage('{"changes":[{"pat');
  assert.equal(result.plan, null);
});

test('mismatched closers are rejected', () => {
  assert.equal(repairTruncatedJson('{"a": [1, 2}'), null);
});

test('salvaged plan still passes shape validation for a realistic large-mission cut', () => {
  const plan = {
    summary: 'stage 1 of 3',
    requirements: [
      { id: 'REQ-1', description: 'add multiply', acceptanceCriteria: 'npm test passes', checkCommands: ['npm test'] },
      { id: 'REQ-2', description: 'wire multiply into cli', acceptanceCriteria: 'cli prints product' },
    ],
    changes: [
      { path: 'multiply.js', action: 'create', rationale: 'new util', content: 'export function multiply(a,b){return a*b;}' },
      { path: 'multiply.test.js', action: 'create', rationale: 'cover util', content: 'import {multiply} from "./multiply.js"; console.assert(multiply(3,4)===12);' },
      { path: 'cli.js', action: 'modify', edits: [{ find: 'const args = process.argv;', replace: 'import { multiply } from "./multiply.js";\nconst args = process.argv;' }] },
    ],
  };
  const full = JSON.stringify(plan);
  // Cut deep inside the third change (the modify), mid-find-string.
  const cutPoint = full.indexOf('process.argv') + 5;
  const truncated = full.slice(0, cutPoint);
  const result = parsePlanJsonWithSalvage(truncated);
  assert.equal(result.salvaged, true);
  const shape = validateModelPlanShape(result.plan);
  assert.equal(shape.ok, true);
  assert.equal(shape.changes.length, 2);
  assert.equal(shape.changes[1].path, 'multiply.test.js');
  assert.equal(shape.requirements.length, 2);
});

test('a multi-file plan that loses its last file is a partial stage, never completion', () => {
  const plan = {
    summary: 'stage 1 of 2',
    requirements: [{ id: 'REQ-1', description: 'add sum and multiply utils' }],
    changes: [
      { path: 'sum.js', action: 'create', content: 'export const sum=(a,b)=>a+b;' },
      { path: 'multiply.js', action: 'create', content: 'export const multiply=(a,b)=>a*b;' },
    ],
  };
  // Truncate so the last file (multiply.js) is lost mid-content.
  const full = JSON.stringify(plan);
  const truncated = full.slice(0, full.indexOf('multiply=(a,b)') + 5);
  const selected = selectSalvagedPlan(truncated);
  assert.ok(selected, 'salvage should still be accepted');
  assert.equal(selected.changes, 1, 'only the complete file survives');
  // Acceptance must carry an explicit partial outcome: the blocker reason the
  // mission returns names the partial stage and the replan, not completion.
  const reason = buildSalvagePartialBlockerReason(selected.changes);
  assert.match(reason, /partial stage/i);
  assert.match(reason, /replan/i);
  assert.match(reason, /1 complete file change/);
  assert.doesNotMatch(reason, /completed mission\./);
});

test('selectSalvagedPlan rejects an empty salvage and non-salvaged input', () => {
  assert.equal(selectSalvagedPlan('{"changes":[]'), null);
  assert.equal(selectSalvagedPlan('{"changes":[{"path":"a.ts","action":"create","content":"x"}]}'), null);
});
