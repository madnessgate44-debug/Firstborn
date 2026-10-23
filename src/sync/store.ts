/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checkpoint persistence.
 *
 * Checkpoints are scoped per repository: each project's `checkpoints.json` lives
 * in that project's repository and lists only that project's conversations. The
 * store is read-only — the pipeline writes the checkpoint file as one of the
 * files in the same atomic commit as the transcripts, so a checkpoint can never
 * advance ahead of the messages it covers.
 */

import type { Checkpoint, SourceKind } from './types.ts';

export const CHECKPOINT_PATH = 'docs/conversation-sync/checkpoints.json';

export interface CheckpointStore {
  /** Load the checkpoints already committed in a repository. */
  load(repository: string): Promise<Checkpoint[]>;
}

interface CheckpointFile {
  version: number;
  checkpoints: Checkpoint[];
}

/** In-memory store used by tests and dry runs. */
export class MemoryCheckpointStore implements CheckpointStore {
  private byRepo = new Map<string, Checkpoint[]>();

  constructor(initial: Record<string, Checkpoint[]> = {}) {
    for (const [repo, list] of Object.entries(initial)) {
      this.byRepo.set(repo, list.map((c) => ({ ...c })));
    }
  }

  async load(repository: string): Promise<Checkpoint[]> {
    return (this.byRepo.get(repository) ?? []).map((c) => ({ ...c }));
  }

  /** Test helper: seed a repository's checkpoints directly. */
  seed(repository: string, checkpoints: Checkpoint[]): void {
    this.byRepo.set(repository, checkpoints.map((c) => ({ ...c })));
  }
}

/** A store backed by reading the checkpoint file out of each repository. */
export class RepoCheckpointStore implements CheckpointStore {
  constructor(private readonly read: (repository: string, path: string) => Promise<string | null>) {}

  async load(repository: string): Promise<Checkpoint[]> {
    const text = await this.read(repository, CHECKPOINT_PATH);
    return parseCheckpoints(text ?? '');
  }
}

export function serializeCheckpoints(checkpoints: Checkpoint[]): string {
  const file: CheckpointFile = { version: 1, checkpoints };
  return JSON.stringify(file, null, 2) + '\n';
}

export function parseCheckpoints(text: string): Checkpoint[] {
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [];
    return list.filter(
      (c: any) =>
        c &&
        typeof c.conversationId === 'string' &&
        typeof c.lastMessageId !== 'undefined' &&
        typeof c.syncedCount === 'number'
    );
  } catch {
    return [];
  }
}

export function findCheckpoint(
  checkpoints: Checkpoint[],
  source: SourceKind,
  conversationId: string
): Checkpoint | undefined {
  return checkpoints.find((c) => c.source === source && c.conversationId === conversationId);
}

export function upsertCheckpoint(checkpoints: Checkpoint[], next: Checkpoint): Checkpoint[] {
  const out = checkpoints.filter((c) => !(c.source === next.source && c.conversationId === next.conversationId));
  out.push(next);
  out.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
  return out;
}
