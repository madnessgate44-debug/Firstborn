import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAllowedPaths, validatePatchSubstance } from '../src/agent/forge.ts';

const allowedPaths = ['tests/forge.test.ts'];

function change(path: string) {
  return {
    path,
    action: 'create' as const,
    rationale: 'Exercise exact allowed-path enforcement',
    content: "import { test } from 'node:test';\ntest('example', () => {});",
  };
}

test('allowed paths: accepts equivalent relative path spellings', () => {
  for (const path of [
    './tests/forge.test.ts',
    'tests/../tests/forge.test.ts',
    'tests\\forge.test.ts',
  ]) {
    assert.equal(validateAllowedPaths([change(path)], allowedPaths).valid, true, path);
  }
});

test('allowed paths: rejects paths outside the exact allowlist', () => {
  for (const path of [
    '../tests/forge.test.ts',
    '/tests/forge.test.ts',
    'tests/../src/agent/forge.ts',
    'TESTS/forge.test.ts',
  ]) {
    const result = validateAllowedPaths([change(path)], allowedPaths);
    assert.equal(result.valid, false, path);
    assert.match(result.error ?? '', /outside the allowed file scope/, path);
  }
});

test('allowed paths: rejects the entire patch if any file is outside the allowlist', () => {
  const result = validateAllowedPaths(
    [change('tests/forge.test.ts'), change('src/agent/forge.ts')],
    allowedPaths,
  );
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /outside the allowed file scope/);
});

test('allowed paths: missing or empty allowlist preserves legacy behavior', () => {
  assert.equal(validateAllowedPaths([change('src/agent/forge.ts')]).valid, true);
  assert.equal(validateAllowedPaths([change('src/agent/forge.ts')], []).valid, true);
});

test('placeholder detection: accepts a markdown heading followed by a real paragraph', () => {
  const result = validatePatchSubstance([{
    path: 'docs/safeguard-notes.md',
    action: 'create',
    rationale: 'A real documentation paragraph is substantive content',
    content: '# Safeguard Notes\n\nThis document explains how the Forge safeguards are verified.',
  }]);
  assert.equal(result.valid, true);
});

test('placeholder detection: rejects a block comment containing only TODO', () => {
  const result = validatePatchSubstance([{
    path: 'tests/placeholder.test.ts',
    action: 'create',
    rationale: 'Ensure TODO-only files are rejected',
    content: '/* TODO: implement this test */',
  }]);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /Placeholder-only patch rejected/);
});

test('placeholder detection: rejects a # TODO line by itself', () => {
  const result = validatePatchSubstance([{
    path: 'docs/placeholder.md',
    action: 'create',
    rationale: 'Ensure heading-style TODO-only files are rejected',
    content: '# TODO',
  }]);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /Placeholder-only patch rejected/);
});

test('placeholder detection: rejects comment-only content without a placeholder keyword', {
  todo: 'comment-only without keyword is accepted',
}, () => {
  const result = validatePatchSubstance([{
    path: 'tests/placeholder.test.ts',
    action: 'create',
    rationale: 'Expose comment-only content that has no TODO keyword',
    content: '// add test here',
  }]);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /Placeholder-only patch rejected/);
});
