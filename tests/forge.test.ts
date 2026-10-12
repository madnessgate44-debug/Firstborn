import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetBranch, evaluateRequirementEvidence, validatePatchSubstance, validateAllowedPaths, validateTestStructure } from '../src/agent/forge.ts';
import { isKeylessOnly } from '../src/services/model.ts';

test('resolveTargetBranch: explicit non-default branch wins', () => {
  assert.equal(resolveTargetBranch('release/2.0', 'main'), 'release/2.0');
});

test('resolveTargetBranch: default branch falls back to itself', () => {
  assert.equal(resolveTargetBranch('main', 'main'), 'main');
});

test('resolveTargetBranch: undefined or empty falls back to default', () => {
  assert.equal(resolveTargetBranch(undefined, 'main'), 'main');
  assert.equal(resolveTargetBranch('', 'main'), 'main');
  assert.equal(resolveTargetBranch('   ', 'main'), 'main');
});

test('resolveTargetBranch: surrounding whitespace is trimmed', () => {
  assert.equal(resolveTargetBranch('  develop  ', 'main'), 'develop');
});

const passing = { command: 'npm run lint', status: 'PASSED', exitCode: 0 };
const failing = { command: 'npm run lint', status: 'FAILED', exitCode: 1 };

test('evidence: PASS only when the criterion names a passing check', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'npm run lint exits with code 0' },
    [passing]
  );
  assert.equal(result.status, 'PASS');
  assert.match(result.evidence, /npm run lint=0/);
});

test('evidence: unrelated passing checks cannot produce a false PASS', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'the new endpoint returns HTTP 200 for valid input' },
    [passing]
  );
  assert.equal(result.status, 'PENDING');
  assert.match(result.evidence, /No criterion-specific passing check/);
});

test('evidence: a named but failing check yields FAIL, never PASS', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'npm run lint must pass' },
    [failing]
  );
  assert.equal(result.status, 'FAIL');
  assert.match(result.evidence, /Criterion-named check failed/);
});

test('evidence: explicit checkCommands bind evidence even when prose does not name it', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'the health endpoint responds', checkCommands: ['npm run build'] },
    [{ command: 'npm run build', status: 'PASSED', exitCode: 0 }]
  );
  assert.equal(result.status, 'PASS');
});

test('evidence: a manualReviewNote is surfaced when no check applies', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'the wording reads clearly', manualReviewNote: 'requires human proofreading' },
    [passing]
  );
  assert.equal(result.status, 'PENDING');
  assert.match(result.evidence, /requires human proofreading/);
});

test('evidence: criterion in description is also honored', () => {
  const result = evaluateRequirementEvidence(
    { description: 'ensure npm run build succeeds' },
    [{ command: 'npm run build', status: 'PASSED', exitCode: 0 }]
  );
  assert.equal(result.status, 'PASS');
});

test('evidence: missing acceptance criteria yields PENDING', () => {
  const result = evaluateRequirementEvidence({}, [passing]);
  assert.equal(result.status, 'PENDING');
});

test('patch substance: rejects a TODO-only newly created file', () => {
  const result = validatePatchSubstance([{
    path: 'tests/model.test.ts',
    action: 'create',
    rationale: 'Regression test for placeholder-only patches',
    content: '// TODO: implement test for isKeylessOnly helper',
  }]);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /Placeholder-only patch rejected/);
});

test('patch substance: rejects a TODO-only edit replacement', () => {
  const result = validatePatchSubstance([{
    path: 'tests/model.test.ts',
    action: 'modify',
    rationale: 'Regression test for placeholder-only patches',
    edits: [{ find: 'old test', replace: '// TODO: implement test' }],
  }]);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /Placeholder-only patch rejected/);
});

test('patch substance: accepts executable implementation or assertions', () => {
  const result = validatePatchSubstance([{
    path: 'tests/model.test.ts',
    action: 'create',
    rationale: 'Ensure substantive code is accepted',
    content: "import assert from 'node:assert/strict';\nassert.equal(1, 1);",
  }]);
  assert.equal(result.valid, true);
});

test('isKeylessOnly: explicit environment values are normalized without global mutation', () => {
  for (const value of ['true', 'TRUE', ' True ']) {
    assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: value } as NodeJS.ProcessEnv), true, value);
  }
  for (const value of [undefined, '', 'false']) {
    assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: value } as NodeJS.ProcessEnv), false, String(value));
  }
});

test('allowed paths: rejects any model-selected file outside the explicit scope', () => {
  const result = validateAllowedPaths([
    { path: 'tests/mission-trace.test.ts', action: 'modify', rationale: 'wrong target', edits: [{ find: 'x', replace: 'y' }] },
  ], ['tests/forge.test.ts']);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /outside the allowed file scope/);
});

test('allowed paths: accepts a change within the explicit scope', () => {
  const result = validateAllowedPaths([
    { path: 'tests/forge.test.ts', action: 'modify', rationale: 'expected target', edits: [{ find: 'x', replace: 'y' }] },
  ], ['tests/forge.test.ts']);
  assert.equal(result.valid, true);
});

test('test structure: rejects nested node:test declarations', () => {
  const result = validateTestStructure('tests/example.test.ts', `import { test } from 'node:test';
test('outer', () => {
  test('inner', () => {});
});`);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /Nested test declaration rejected/);
});

test('test structure: accepts sibling node:test declarations', () => {
  const result = validateTestStructure('tests/example.test.ts', `import { test } from 'node:test';
test('first', () => {});
test('second', () => {});`);
  assert.equal(result.valid, true);
});

test('test structure: rejects syntax errors before running checks', () => {
  const result = validateTestStructure('tests/example.test.ts', `test('unfinished', () => {`);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /syntax error|unclosed|mismatched delimiter/);
});
