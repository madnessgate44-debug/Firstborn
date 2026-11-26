import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/util/clamp.ts';

// Test cases

test('value inside range', () => {
  assert.strictEqual(clamp(5, 1, 10), 5);
});

test('below min', () => {
  assert.strictEqual(clamp(0, 1, 10), 1);
});

test('above max', () => {
  assert.strictEqual(clamp(11, 1, 10), 10);
});

test('value equal to min', () => {
  assert.strictEqual(clamp(1, 1, 10), 1);
});

test('value equal to max', () => {
  assert.strictEqual(clamp(10, 1, 10), 10);
});

test('min greater than max (RangeError)', () => {
  assert.throws(() => clamp(5, 10, 1), RangeError);
});

test('NaN or Infinity arguments (TypeError)', () => {
  assert.throws(() => clamp(NaN, 1, 10), TypeError);
  assert.throws(() => clamp(5, Infinity, 10), TypeError);
  assert.throws(() => clamp(5, 1, -Infinity), TypeError);
  assert.throws(() => clamp(5, NaN, 10), TypeError);
  assert.throws(() => clamp(5, 1, NaN), TypeError);
  assert.throws(() => clamp(5, Infinity, Infinity), TypeError);
  assert.throws(() => clamp(5, -Infinity, -Infinity), TypeError);
});
