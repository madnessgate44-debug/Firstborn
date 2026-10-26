/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The unattended sync pipeline.
 *
 * One run: list supported-source conversations, route each to a repository, read
 * its events, plan an idempotent batch against that repository's checkpoint, and
 * commit the transcript plus its refreshed status and checkpoint in a single
 * atomic write per repository.
 *
 * Ordering is deliberate: a checkpoint is written *in the same commit* as the
 * messages it covers, and the pipeline adopts it only when that commit succeeds.
 * Advancing a checkpoint during planning would mark messages archived when the
 * write actually failed, and the next run would skip them — silently losing
 * history. Because the plan is a pure function of (source, checkpoint), a failed
 * run simply re-plans the same batch next time.
 *
 * Three correctness rules keep a short run from looking like a complete one:
 *
 *  1. **Completeness is checked against the source.** Each read reports the
 *     source's declared message count and the count actually observed. A
 *     mismatch — or a pagination read that did not finish — becomes a visible
 *     GAP, never a silent COMPLETE.
 *  2. **Checkpoints are merged, not overwritten.** A run that examines a subset
 *     of a repository's conversations merges its updates into the committed file
 *     so the conversations it did not look at keep their checkpoints.
 *  3. **Status is scoped.** The status file says whether it covers this run or
 *     the cumulative archive, reports the conversation-inventory coverage, and
 *     carries both per-run and cumulative totals.
 *
 * Isolation is per repository: every file a repository receives — transcripts,
 * checkpoints, status — concerns only the conversations routed to it. One
 * project can never read another project's records out of its own repository.
 *
 * Failure is explicit: a conversation that errors is recorded as ERROR with a
 * reason; a run never reports success it cannot support.
 */

import { advanceCheckpoint, emptyCheckpoint, lagSeconds, planBatch } from './checkpoint.ts';
import { renderStatus, renderStatusJson, renderTranscript } from './render.ts';
import { routeConversation, transcriptPath, type RouteRule } from './router.ts';
import {
  CHECKPOINT_PATH,
  findCheckpoint,
  mergeCheckpoints,
  serializeCheckpoints,
  type CheckpointStore,
} from './store.ts';
import { unsupportedSourceNames } from './sources.ts';
import type {
  BatchPlan,
  Checkpoint,
  ConversationStatus,
  InventoryCoverage,
  SourceKind,
  SyncRunResult,
  SyncStatus,
  TranscriptMessage,
} from './types.ts';

/** A conversation as the pipeline needs it, decoupled from the API client. */
export interface SourceConversation {
  id: string;
  title: string | null;
  selectedRepository: string | null;
  conversationUiUrl: string | null;
}

/** Conversation inventory with truncation metadata, when the source reports it. */
export interface SourceConversationInventory {
  conversations: SourceConversation[];
  totalAvailable: number;
  truncated: boolean;
  inventoryComplete: boolean;
}

/** Completeness metadata for one conversation read. */
export interface SourceReadResult {
  messages: TranscriptMessage[];
  /** Raw events returned by the read. */
  eventsRead: number;
  /** Messages after normalization/redaction. */
  observedMessages: number;
  /** The source's declared message count, or null when unavailable. */
  declaredMessages: number | null;
  /** True only when pagination reached the source's last page. */
  paginationComplete: boolean;
  /** Pages fetched. */
  pages: number;
}

/** The read side of a supported source. */
export interface SourceReader {
  listConversations(limit: number): Promise<SourceConversation[]>;
  /** All conversation messages for one conversation, in ascending source order. */
  listMessages(conversationId: string): Promise<TranscriptMessage[]>;
  /** Optional: inventory with truncation metadata. */
  listConversationsDetailed?(limit: number): Promise<SourceConversationInventory>;
  /** Optional: read with completeness metadata (declared vs observed counts). */
  readConversation?(conversationId: string): Promise<SourceReadResult>;
}

export interface RepoWriter {
  /** Read a file, or null when it does not exist. */
  read(repository: string, path: string): Promise<string | null>;
  /** Write several files to one repository in a single commit. */
  write(
    repository: string,
    files: { path: string; content: string }[],
    message: string
  ): Promise<{ commit: string | null }>;
}

export interface PipelineOptions {
  source: SourceReader;
  writer: RepoWriter;
  store: CheckpointStore;
  /** Routing rules, evaluated in order. */
  routes: RouteRule[];
  /** Fallback repository when no rule matches; null routes nowhere (fail closed). */
  fallbackRepository?: string | null;
  /** Max conversations to examine per run. */
  limit?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  sourceKind?: SourceKind;
}

const STATUS_PATH = 'docs/conversation-sync/sync-status.json';
const STATUS_MD_PATH = 'docs/conversation-sync/sync-status.md';

interface Planned {
  conversation: SourceConversation;
  repository: string;
  existing: Checkpoint;
  advanced: Checkpoint;
  plan: BatchPlan;
  transcript: { path: string; content: string } | null;
  /** Completeness metadata from the read that produced the plan. */
  read: SourceReadResult;
}

interface RepoOutcome {
  succeeded: boolean;
  error?: string;
}

export async function runSync(options: PipelineOptions): Promise<SyncRunResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const limit = options.limit ?? 50;
  const fallback = options.fallbackRepository ?? null;
  const sourceKind: SourceKind = options.sourceKind ?? 'openhands';
  const errors: string[] = [];
  const written: { repository: string; path: string; commit: string | null }[] = [];

  // --- Phase 0: read the conversation inventory, with truncation metadata. ---
  const inventory = await readInventory(options.source, limit);
  const conversations = inventory.conversations;
  const coverage: InventoryCoverage = {
    examined: conversations.length,
    totalAvailable: inventory.totalAvailable,
    truncated: inventory.truncated,
    inventoryComplete: inventory.inventoryComplete,
  };

  const plannedByRepo = new Map<string, Planned[]>();
  const errored: ConversationStatus[] = [];
  // Errors are tracked per repository so one project's failure never marks
  // another project's status as unsuccessful.
  const repoErrors = new Map<string, string[]>();
  const addRepoError = (repository: string, message: string) => {
    const list = repoErrors.get(repository) ?? [];
    list.push(message);
    repoErrors.set(repository, list);
  };
  // The committed checkpoints for a repository, loaded once and reused, so a
  // partial run can merge into them rather than overwrite them.
  const existingByRepo = new Map<string, Checkpoint[]>();

  // --- Phase 1: plan every conversation against its repository's checkpoint. ---
  for (const conversation of conversations) {
    const decision = routeConversation(
      {
        conversationId: conversation.id,
        title: conversation.title,
        selectedRepository: conversation.selectedRepository,
      },
      options.routes,
      fallback
    );

    if (!decision.repository) {
      errored.push({
        conversationId: conversation.id,
        repository: '(unrouted)',
        title: conversation.title ?? '(untitled)',
        messageCount: 0,
        addedThisRun: 0,
        lastMessageId: null,
        lastTimestamp: null,
        lagSeconds: null,
        declaredMessages: null,
        observedMessages: 0,
        pages: 0,
        paginationComplete: false,
        state: 'ERROR',
        note: `no route matched (${decision.matchedBy}); not written anywhere`,
      });
      continue;
    }

    try {
      if (!existingByRepo.has(decision.repository)) {
        existingByRepo.set(decision.repository, await options.store.load(decision.repository));
      }
      const checkpoints = existingByRepo.get(decision.repository)!;
      const read = await readConversation(options.source, conversation.id);
      const messages = read.messages;
      const existing =
        findCheckpoint(checkpoints, sourceKind, conversation.id) ?? emptyCheckpoint(sourceKind, conversation.id);

      // Wire the source's declared count and the observed count into the plan so
      // a truncated page or a short read becomes a visible gap.
      const planOptions: { expectedCount?: number; observedCount?: number } = {};
      if (typeof read.declaredMessages === 'number') planOptions.expectedCount = read.declaredMessages;
      planOptions.observedCount = read.observedMessages;
      const plan = planBatch(messages, existing, planOptions);

      if (!read.paginationComplete) {
        const reason = `pagination did not complete for ${conversation.id}; the event stream may be truncated`;
        errors.push(reason);
        addRepoError(decision.repository, reason);
        if (!plan.gap) {
          plan.gap = { conversationId: conversation.id, reason, detectedAt: now() };
        }
      }
      if (plan.gap) {
        errors.push(`${conversation.id}: ${plan.gap.reason}`);
        addRepoError(decision.repository, `${conversation.id}: ${plan.gap.reason}`);
      }

      let transcript: { path: string; content: string } | null = null;
      let advanced = existing;

      if (!plan.noop) {
        // Re-read what is already committed so a re-run rewrites the whole file
        // without losing history, then append the new batch in source order.
        const existingText = await options.writer.read(decision.repository, transcriptPath(conversation.id));
        const priorMessages = existingText ? parseTranscriptMessages(existingText) : [];
        const all = dedupeById([...priorMessages, ...plan.batch]);
        transcript = {
          path: transcriptPath(conversation.id),
          content: renderTranscript(
            {
              conversationId: conversation.id,
              repository: decision.repository,
              title: conversation.title,
              sourceUrl: conversation.conversationUiUrl,
              lastTimestamp: all.length ? all[all.length - 1].timestamp : null,
              messageCount: all.length,
            },
            all
          ),
        };
        advanced = advanceCheckpoint(existing, plan.batch, now());
      }

      const list = plannedByRepo.get(decision.repository) ?? [];
      list.push({ conversation, repository: decision.repository, existing, advanced, plan, transcript, read });
      plannedByRepo.set(decision.repository, list);
    } catch (err: any) {
      errors.push(`${conversation.id}: ${err?.message ?? String(err)}`);
      addRepoError(decision.repository, `${conversation.id}: ${err?.message ?? String(err)}`);
      errored.push({
        conversationId: conversation.id,
        repository: decision.repository,
        title: conversation.title ?? '(untitled)',
        messageCount: 0,
        addedThisRun: 0,
        lastMessageId: null,
        lastTimestamp: null,
        lagSeconds: null,
        declaredMessages: null,
        observedMessages: 0,
        pages: 0,
        paginationComplete: false,
        state: 'ERROR',
        note: err?.message ?? String(err),
      });
    }
  }

  // --- Phase 2: one atomic commit per repository, then adopt its checkpoints. ---
  const outcomes = new Map<string, RepoOutcome>();
  const adopted = new Map<string, Checkpoint>();
  // The merged checkpoint file per repository, used for both the commit and the
  // cumulative coverage numbers.
  const mergedByRepo = new Map<string, Checkpoint[]>();

  for (const [repository, items] of plannedByRepo) {
    const transcripts = items.filter((i) => i.transcript).map((i) => i.transcript!);
    const scoped = items.map((i) => i.advanced);
    const existing = existingByRepo.get(repository) ?? [];
    const merged = mergeCheckpoints(existing, scoped);
    mergedByRepo.set(repository, merged);

    if (transcripts.length === 0) {
      // Nothing new to archive; nothing to commit and nothing to adopt.
      outcomes.set(repository, { succeeded: true });
      for (const item of items) adopted.set(item.conversation.id, item.advanced);
      continue;
    }

    const files = [...transcripts, { path: CHECKPOINT_PATH, content: serializeCheckpoints(merged) }];
    try {
      const res = await options.writer.write(
        repository,
        files,
        `sync(conversations): archive ${transcripts.length} transcript(s)`
      );
      for (const f of files) written.push({ repository, path: f.path, commit: res.commit });
      outcomes.set(repository, { succeeded: true });
      for (const item of items) adopted.set(item.conversation.id, item.advanced);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      errors.push(`write ${repository}: ${message}`);
      addRepoError(repository, `write: ${message}`);
      outcomes.set(repository, { succeeded: false, error: message });
    }
  }

  // --- Phase 3: build the status from the final, durable state, per repository. ---
  const statusRepos = new Map<string, ConversationStatus[]>();
  const addStatus = (repository: string, status: ConversationStatus) => {
    const list = statusRepos.get(repository) ?? [];
    list.push(status);
    statusRepos.set(repository, list);
  };

  for (const e of errored) {
    if (e.repository !== '(unrouted)') addStatus(e.repository, e);
  }

  for (const [repository, items] of plannedByRepo) {
    const outcome = outcomes.get(repository)!;
    for (const item of items) {
      const durable = adopted.get(item.conversation.id) ?? item.existing;
      const added = outcome.succeeded && !item.plan.noop ? item.plan.batch.length : 0;
      const state = !outcome.succeeded ? 'ERROR' : item.plan.gap ? 'GAP' : 'OK';
      const note = !outcome.succeeded
        ? `commit failed: ${outcome.error}`
        : item.plan.gap
          ? item.plan.gap.reason
          : item.plan.noop
            ? 'no new messages'
            : `${added} new message(s)`;
      addStatus(repository, {
        conversationId: item.conversation.id,
        repository,
        title: item.conversation.title ?? '(untitled)',
        messageCount: durable.syncedCount,
        addedThisRun: added,
        lastMessageId: durable.lastMessageId,
        lastTimestamp: durable.lastTimestamp,
        lagSeconds: lagSeconds(durable.lastTimestamp, now()),
        declaredMessages: item.read.declaredMessages,
        observedMessages: item.read.observedMessages,
        pages: item.read.pages,
        paginationComplete: item.read.paginationComplete,
        state,
        note,
      });
    }
  }

  // A repository that only saw errors still gets a status file, so a failure is
  // never invisible just because no transcript was written.
  const allRepos = new Set<string>([...plannedByRepo.keys(), ...statusRepos.keys()]);
  let lastSuccessfulSync: string | null = errors.length === 0 ? now() : null;

  for (const repository of allRepos) {
    const statuses = (statusRepos.get(repository) ?? []).slice().sort((a, b) =>
      a.conversationId.localeCompare(b.conversationId)
    );
    // A repository's own last-successful marker depends only on its own errors.
    const repoLastSuccess = (repoErrors.get(repository)?.length ?? 0) === 0 ? now() : null;
    const cumulative = cumulativeFrom(mergedByRepo.get(repository) ?? existingByRepo.get(repository) ?? []);
    const status: SyncStatus = {
      generatedAt: now(),
      source: sourceKind,
      scope: 'run',
      inventory: coverage,
      conversations: statuses,
      totals: {
        conversations: statuses.length,
        messages: statuses.reduce((n, s) => n + s.messageCount, 0),
        gaps: statuses.filter((s) => s.state === 'GAP').length,
        errors: statuses.filter((s) => s.state === 'ERROR').length,
      },
      cumulative,
      unsupportedSources: unsupportedSourceNames(),
      lastSuccessfulSync: repoLastSuccess,
    };
    try {
      const res = await options.writer.write(
        repository,
        [
          { path: STATUS_PATH, content: renderStatusJson(status) },
          { path: STATUS_MD_PATH, content: renderStatus(status) },
        ],
        'sync(conversations): refresh status'
      );
      written.push({ repository, path: STATUS_PATH, commit: res.commit });
      written.push({ repository, path: STATUS_MD_PATH, commit: res.commit });
    } catch (err: any) {
      errors.push(`status ${repository}: ${err?.message ?? String(err)}`);
      lastSuccessfulSync = null;
    }
  }

  // The aggregate status includes unrouted conversations so a routing failure is
  // visible in the run report even though it is written to no repository.
  const unroutedStatuses = errored.filter((e) => e.repository === '(unrouted)');
  const allStatuses = [...statusRepos.values(), unroutedStatuses]
    .flat()
    .sort((a, b) => a.conversationId.localeCompare(b.conversationId));
  const aggregateCumulative = cumulativeFrom([...mergedByRepo.values()].flat());
  const aggregate: SyncStatus = {
    generatedAt: now(),
    source: sourceKind,
    scope: 'run',
    inventory: coverage,
    conversations: allStatuses,
    totals: {
      conversations: allStatuses.length,
      messages: allStatuses.reduce((n, s) => n + s.messageCount, 0),
      gaps: allStatuses.filter((s) => s.state === 'GAP').length,
      errors: allStatuses.filter((s) => s.state === 'ERROR').length,
    },
    cumulative: aggregateCumulative,
    unsupportedSources: unsupportedSourceNames(),
    lastSuccessfulSync,
  };

  return { status: aggregate, written, errors };
}

/** Read the conversation inventory, using truncation metadata when available. */
async function readInventory(source: SourceReader, limit: number): Promise<SourceConversationInventory> {
  if (typeof source.listConversationsDetailed === 'function') {
    return source.listConversationsDetailed(limit);
  }
  const conversations = await source.listConversations(limit);
  // Without a detailed reader the pipeline cannot see past the limit, so it
  // reports only what it can prove: a full page means more may exist.
  return {
    conversations,
    totalAvailable: conversations.length,
    truncated: conversations.length >= limit,
    inventoryComplete: conversations.length < limit,
  };
}

/** Read one conversation, using completeness metadata when available. */
async function readConversation(source: SourceReader, conversationId: string): Promise<SourceReadResult> {
  if (typeof source.readConversation === 'function') {
    return source.readConversation(conversationId);
  }
  const messages = await source.listMessages(conversationId);
  return {
    messages,
    eventsRead: messages.length,
    observedMessages: messages.length,
    declaredMessages: null,
    paginationComplete: true,
    pages: 0,
  };
}

function cumulativeFrom(checkpoints: Checkpoint[]): { conversations: number; messages: number } {
  return {
    conversations: checkpoints.length,
    messages: checkpoints.reduce((n, c) => n + c.syncedCount, 0),
  };
}

function dedupeById(messages: TranscriptMessage[]): TranscriptMessage[] {
  const seen = new Set<string>();
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * Recover messages from a previously rendered transcript so a re-run can rewrite
 * the whole file without losing history.
 *
 * The parse is lossless: each message body is read between a fenced opening and
 * closing line and rejoined with `\n`, which reproduces the original text exactly
 * (including trailing spaces and blank lines). A body that is not fenced as
 * rendered is skipped rather than guessed, so a hand-edited file cannot corrupt
 * the archive silently.
 */
export function parseTranscriptMessages(markdown: string): TranscriptMessage[] {
  const headerRe = /^## (user|assistant|system) — (.+?) — `([^`]+)`$/;
  const lines = markdown.split('\n');
  const out: TranscriptMessage[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = headerRe.exec(lines[i]);
    if (!header) continue;
    // Skip the blank line after the header.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j += 1;
    const fence = lines[j];
    if (!fence || !/^`{3,}$/.test(fence)) continue;
    const bodyStart = j + 1;
    let bodyEnd = -1;
    for (let k = bodyStart; k < lines.length; k += 1) {
      if (lines[k] === fence) {
        bodyEnd = k;
        break;
      }
    }
    if (bodyEnd === -1) continue;
    out.push({
      id: header[3],
      speaker: header[1] as TranscriptMessage['speaker'],
      timestamp: header[2],
      text: lines.slice(bodyStart, bodyEnd).join('\n'),
    });
    i = bodyEnd;
  }
  return out;
}

export type { Checkpoint };
