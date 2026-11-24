import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionScopeDiff } from '../src/agent/scope.ts';

test('scope: planned files are in scope, tool drift is out of scope', () => {
  const p = partitionScopeDiff(['sum.js', 'sum.test.js'], ['sum.js', 'sum.test.js', 'package-lock.json']);
  assert.deepEqual(p.inScope, ['sum.js', 'sum.test.js']);
  assert.deepEqual(p.outOfScope, ['package-lock.json']);
});

test('scope: a needed dependency change is flagged, never silently dropped', () => {
  const p = partitionScopeDiff(['src/app.ts'], ['src/app.ts', 'package.json', 'package-lock.json']);
  assert.deepEqual(p.inScope, ['src/app.ts']);
  assert.deepEqual(p.outOfScope, ['package.json', 'package-lock.json']);
});

test('scope: normalized separators and ./ prefixes match planned paths', () => {
  const p = partitionScopeDiff(['src/agent/forge.ts'], ['./src/agent/forge.ts']);
  assert.deepEqual(p.inScope, ['src/agent/forge.ts']);
  assert.deepEqual(p.outOfScope, []);
});

test('scope: no planned scope means everything is drift for review', () => {
  const p = partitionScopeDiff([], ['README.md']);
  assert.deepEqual(p.inScope, []);
  assert.deepEqual(p.outOfScope, ['README.md']);
});
