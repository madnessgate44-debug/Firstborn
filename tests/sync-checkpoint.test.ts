import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCheckpoint,
  planBatch,
  advanceCheckpoint,
  lagSeconds,
} from '../src/sync/checkpoint.ts';
import type { TranscriptMessage } from '../src/sync/types.ts';

// Pure tests for the correctness core: batching must be idempotent, must resume
// exactly from the checkpoint's message id, and must raise a gap (never guess)
// when the source diverges from what was archived.

function msg(id: string, timestamp: string, text = `body-${id}`): TranscriptMessage {
  return { id, speaker: 'user', timestamp, text };
}

const MANIFEST = [msg('m1', '2026-01-01T00:00:00Z'), msg('m2', '2026-01-01T00:01:00Z'), msg('m3', '2026-01-01T00:02:00Z')];

test('checkpoint: a fresh checkpoint batches the whole manifest in order', () => {
  const plan = planBatch(MANIFEST, emptyCheckpoint('openhands', 'c1'));
  assert.deepEqual(plan.batch.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.equal(plan.noop, false);
  assert.equal(plan.gap, null);
});

test('checkpoint: re-planning the same manifest after writing is a no-op', () => {
  const cp = advanceCheckpoint(emptyCheckpoint('openhands', 'c1'), MANIFEST, '2026-01-01T00:05:00Z');
  const plan = planBatch(MANIFEST, cp);
  assert.equal(plan.noop, true);
  assert.deepEqual(plan.batch, []);
});

test('checkpoint: only messages after the checkpoint are new (idempotent resume)', () => {
  const cp = advanceCheckpoint(emptyCheckpoint('openhands', 'c1'), MANIFEST.slice(0, 2), '2026-01-01T00:05:00Z');
  const extended = [...MANIFEST, msg('m4', '2026-01-01T00:03:00Z')];
  const plan = planBatch(extended, cp);
  assert.deepEqual(plan.batch.map((m) => m.id), ['m3', 'm4']);
  // The already-written prefix is reported, never re-emitted.
  assert.deepEqual(plan.duplicates, ['m1', 'm2']);
});

test('checkpoint: a mid-batch failure resumes without losing or duplicating', () => {
  // The source grew to 4 messages, but the first run only committed 2 before dying.
  const cp = advanceCheckpoint(emptyCheckpoint('openhands', 'c1'), MANIFEST.slice(0, 2), '2026-01-01T00:05:00Z');
  const full = [...MANIFEST, msg('m4', '2026-01-01T00:03:00Z')];
  const first = planBatch(full, cp);
  // First attempt writes only m3 (simulating a partial commit of the batch).
  const afterPartial = advanceCheckpoint(cp, first.batch.slice(0, 1), '2026-01-01T00:06:00Z');
  const second = planBatch(full, afterPartial);
  assert.deepEqual(second.batch.map((m) => m.id), ['m4']);
  assert.equal(afterPartial.syncedCount, 3);
  assert.equal(advanceCheckpoint(afterPartial, second.batch, '2026-01-01T00:07:00Z').syncedCount, 4);
});

test('checkpoint: a vanished checkpoint message raises a gap instead of guessing', () => {
  const cp = advanceCheckpoint(emptyCheckpoint('openhands', 'c1'), MANIFEST, '2026-01-01T00:05:00Z');
  // The source no longer contains m3 (edited away / different conversation).
  const diverged = MANIFEST.slice(0, 2);
  const plan = planBatch(diverged, cp);
  assert.equal(plan.noop, true);
  assert.ok(plan.gap);
  assert.match(plan.gap!.reason, /no longer present/);
});

test('checkpoint: a source reporting more messages than are visible raises a gap', () => {
  const plan = planBatch(MANIFEST, emptyCheckpoint('openhands', 'c1'), { expectedCount: 5 });
  assert.ok(plan.gap);
  assert.match(plan.gap!.reason, /only 3 are visible/);
  // The visible messages are still batched; the gap is reported alongside.
  assert.deepEqual(plan.batch.map((m) => m.id), ['m1', 'm2', 'm3']);
});

test('checkpoint: lag is measured from the last message, never negative', () => {
  assert.equal(lagSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'), 60);
  assert.equal(lagSeconds(null, '2026-01-01T00:01:00Z'), null);
  // A clock skew that puts the message ahead of now clamps to zero.
  assert.equal(lagSeconds('2026-01-01T00:02:00Z', '2026-01-01T00:01:00Z'), 0);
});
