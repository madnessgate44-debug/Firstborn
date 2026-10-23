/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checkpointing, idempotent batching, and gap detection.
 *
 * This is the correctness core of the pipeline and is intentionally pure: given
 * the source's full ordered message list and the checkpoint of what was already
 * written, it decides exactly which messages to append. Because the decision is a
 * function of (source, checkpoint) only, re-running after a failure cannot
 * duplicate a message and cannot silently skip one.
 *
 * The checkpoint is keyed on the last written *message id*, not a timestamp: two
 * messages can share a timestamp, but ids are unique, so resuming is exact.
 */

import type { BatchPlan, Checkpoint, SyncGap, TranscriptMessage } from './types.ts';

export function emptyCheckpoint(source: Checkpoint['source'], conversationId: string): Checkpoint {
  return {
    source,
    conversationId,
    lastMessageId: null,
    lastTimestamp: null,
    syncedCount: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Index of the first message the checkpoint has not yet recorded, or -1 if unknown. */
function resumeIndex(messages: TranscriptMessage[], checkpoint: Checkpoint): number {
  if (!checkpoint.lastMessageId) return 0;
  const idx = messages.findIndex((m) => m.id === checkpoint.lastMessageId);
  if (idx === -1) return -1;
  return idx + 1;
}

export interface PlanOptions {
  /**
   * Expected total event count from the source, when known. Used to detect a gap:
   * if the source reports more messages than we can see, the archive is partial
   * and must say so instead of reporting complete.
   */
  expectedCount?: number;
}

/**
 * Plan an idempotent batch.
 *
 * - Messages already at or before the checkpoint are reported as duplicates.
 * - New messages after the checkpoint form the batch, in source order.
 * - If the checkpoint's message id is not present in the source list, the source
 *   history has diverged (edited/deleted, or a different conversation) and a gap
 *   is raised rather than guessing.
 * - If `expectedCount` exceeds the number of visible messages, a gap is raised.
 */
export function planBatch(
  messages: TranscriptMessage[],
  checkpoint: Checkpoint,
  options: PlanOptions = {}
): BatchPlan {
  const duplicates: string[] = [];
  let gap: SyncGap | null = null;

  const start = resumeIndex(messages, checkpoint);

  if (start === -1) {
    gap = {
      conversationId: checkpoint.conversationId,
      reason: `checkpoint message ${checkpoint.lastMessageId} is no longer present in the source (edited, deleted, or a different conversation); refusing to guess a resume point`,
      detectedAt: new Date().toISOString(),
    };
    // Do not re-emit anything: without a known resume point, appending would risk
    // duplicating or reordering history. A human must resolve the divergence.
    return { batch: [], duplicates, noop: true, gap };
  }

  const seen = new Set(messages.slice(0, start).map((m) => m.id));
  for (const m of messages.slice(0, start)) {
    if (seen.has(m.id)) duplicates.push(m.id);
  }

  const batch = messages.slice(start);

  if (typeof options.expectedCount === 'number' && options.expectedCount > messages.length) {
    gap = {
      conversationId: checkpoint.conversationId,
      reason: `source reports ${options.expectedCount} conversation messages but only ${messages.length} are visible; ${options.expectedCount - messages.length} are unread`,
      detectedAt: new Date().toISOString(),
    };
  }

  return { batch, duplicates, noop: batch.length === 0, gap };
}

/** Advance a checkpoint by a written batch. Pure: returns a new checkpoint. */
export function advanceCheckpoint(
  checkpoint: Checkpoint,
  written: TranscriptMessage[],
  now: string
): Checkpoint {
  if (written.length === 0) return { ...checkpoint, updatedAt: now };
  const last = written[written.length - 1];
  return {
    ...checkpoint,
    lastMessageId: last.id,
    lastTimestamp: last.timestamp,
    syncedCount: checkpoint.syncedCount + written.length,
    updatedAt: now,
  };
}

/** Seconds between the newest message and `now`; null when there is no message. */
export function lagSeconds(lastTimestamp: string | null, now: string): number | null {
  if (!lastTimestamp) return null;
  const last = Date.parse(lastTimestamp);
  const current = Date.parse(now);
  if (Number.isNaN(last) || Number.isNaN(current)) return null;
  return Math.max(0, Math.round((current - last) / 1000));
}
