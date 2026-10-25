/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live, controlled end-to-end verification of the unattended conversation sync.
 *
 *   SYNC_E2E_NEW_CONVERSATION=<id> SYNC_E2E_FAULT_CONVERSATION=<id> \
 *     OPENHANDS_API_KEY=... GITHUB_TOKEN=... npx tsx scripts/sync-e2e.ts --phase=all
 *
 * This is the follow-up verification the reviewer asked for. It runs the *real*
 * pipeline (`runSync` + `OpenHandsSourceReader` + `GitHubRepoWriter`) against a
 * real OpenHands Cloud session and a real GitHub branch, and prints raw evidence:
 *
 *   new   — a controlled source event is archived to GitHub; the committed
 *           transcript reads back message-for-message against the source.
 *   new2  — a second run of the same source produces no new transcript commit
 *           (the already-synced event is not duplicated).
 *   fault — a write failure injected *after* the source read leaves the committed
 *           checkpoint unadvanced and the run failed; a retry then archives the
 *           same event exactly once.
 *
 * Scope is restricted to the named controlled conversations so the run is
 * bounded and cannot touch unrelated transcripts. The destination is a dedicated
 * `conversation-sync-e2e` branch — never `main`, never the production
 * `conversation-sync` branch. No credential value is ever printed.
 *
 * A phase that cannot prove its assertion exits non-zero, so a green run means
 * the evidence was actually observed.
 */

import { readFileSync } from 'node:fs';
import { OpenHandsClient } from '../src/sync/openhands-client.ts';
import { OpenHandsSourceReader } from '../src/sync/openhands-source.ts';
import { GitHubRepoWriter, DEFAULT_SYNC_BRANCH } from '../src/sync/github-writer.ts';
import {
  runSync,
  parseTranscriptMessages,
  type RepoWriter,
  type SourceConversation,
  type SourceConversationInventory,
  type SourceReader,
  type SourceReadResult,
} from '../src/sync/pipeline.ts';
import { RepoCheckpointStore, CHECKPOINT_PATH } from '../src/sync/store.ts';
import { DEFAULT_ROUTES_PATH, parseRoutes } from '../src/sync/routes.ts';
import { transcriptPath } from '../src/sync/router.ts';
import { GitHubService } from '../src/services/github.ts';
import type { TranscriptMessage } from '../src/sync/types.ts';

const E2E_BRANCH = process.env.SYNC_E2E_BRANCH || 'conversation-sync-e2e';
const E2E_REPO = process.env.SYNC_E2E_REPO || 'madnessgate44-debug/Firstborn';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[e2e] ${tag} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Restrict the source to the named controlled conversations only. */
class RestrictedSource implements SourceReader {
  private readonly reader: OpenHandsSourceReader;
  private readonly ids: string[];

  constructor(client: OpenHandsClient, ids: string[]) {
    this.reader = new OpenHandsSourceReader(client);
    this.ids = ids;
  }

  private async all(): Promise<SourceConversation[]> {
    const inv = await this.reader.listConversationsDetailed(2000);
    return inv.conversations.filter((c) => this.ids.includes(c.id));
  }

  async listConversations(limit: number): Promise<SourceConversation[]> {
    return (await this.all()).slice(0, limit);
  }

  async listConversationsDetailed(limit: number): Promise<SourceConversationInventory> {
    const conversations = (await this.all()).slice(0, limit);
    return {
      conversations,
      totalAvailable: conversations.length,
      truncated: false,
      inventoryComplete: true,
    };
  }

  async listMessages(conversationId: string): Promise<TranscriptMessage[]> {
    return this.reader.listMessages(conversationId);
  }

  async readConversation(conversationId: string): Promise<SourceReadResult> {
    return this.reader.readConversation(conversationId);
  }
}

/** Wrap a real writer and fail the next transcript commit once, to model a fault. */
class FaultInjectingWriter implements RepoWriter {
  constructor(private readonly inner: RepoWriter) {}
  failNextArchive = false;

  async read(repository: string, path: string): Promise<string | null> {
    return this.inner.read(repository, path);
  }

  async write(
    repository: string,
    files: { path: string; content: string }[],
    message: string
  ): Promise<{ commit: string | null }> {
    const isArchive = message.includes('archive');
    if (this.failNextArchive && isArchive) {
      this.failNextArchive = false;
      throw new Error('injected write failure (test): the transcript commit was refused');
    }
    return this.inner.write(repository, files, message);
  }
}

function printStatus(result: Awaited<ReturnType<typeof runSync>>): void {
  console.log(
    JSON.stringify(
      result.status.conversations.map((c) => ({
        conversationId: c.conversationId,
        repository: c.repository,
        messageCount: c.messageCount,
        addedThisRun: c.addedThisRun,
        declared: c.declaredMessages,
        observed: c.observedMessages,
        pages: c.pages,
        paginationComplete: c.paginationComplete,
        state: c.state,
        note: c.note,
      })),
      null,
      2
    )
  );
  console.log('[e2e] inventory', JSON.stringify(result.status.inventory));
  console.log('[e2e] errors', JSON.stringify(result.errors));
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENHANDS_API_KEY;
  const token = process.env.GITHUB_TOKEN;
  const phase = (process.argv.find((a) => a.startsWith('--phase='))?.split('=')[1] ?? 'all') as
    | 'new'
    | 'new2'
    | 'fault'
    | 'all';
  if (!apiKey || !token) {
    console.error('[e2e] OPENHANDS_API_KEY and GITHUB_TOKEN are required');
    process.exitCode = 2;
    return;
  }
  if (E2E_BRANCH === DEFAULT_SYNC_BRANCH || E2E_BRANCH === 'main' || E2E_BRANCH === 'master') {
    console.error(`[e2e] refusing to use branch "${E2E_BRANCH}" for a controlled run`);
    process.exitCode = 2;
    return;
  }

  const newId = process.env.SYNC_E2E_NEW_CONVERSATION;
  const faultId = process.env.SYNC_E2E_FAULT_CONVERSATION;
  if (!newId || !faultId) {
    console.error('[e2e] SYNC_E2E_NEW_CONVERSATION and SYNC_E2E_FAULT_CONVERSATION are required');
    process.exitCode = 2;
    return;
  }

  const routes = parseRoutes(readFileSync(new URL(`../${DEFAULT_ROUTES_PATH}`, import.meta.url), 'utf8'));
  const client = new OpenHandsClient({ apiKey, throttle: { minIntervalMs: 160, maxRequestsPerMinute: 80 } });
  // Scope each phase to its own conversation so a phase never advances another
  // phase's checkpoint (which would turn the fault phase into a false no-op).
  const sourceFor = (id: string) => new RestrictedSource(client, [id]);
  const realWriter = new GitHubRepoWriter({ token, branch: E2E_BRANCH });
  const writer = new FaultInjectingWriter(realWriter);
  const store = new RepoCheckpointStore((r, p) => writer.read(r, p));
  const inspector = new GitHubService(token);
  const now = () => new Date().toISOString();
  const [owner, repo] = E2E_REPO.split('/');

  console.log(`[e2e] destination ${E2E_REPO}@${E2E_BRANCH} (isolated; never main, never ${DEFAULT_SYNC_BRANCH})`);
  console.log(`[e2e] controlled conversations: new=${newId} fault=${faultId}`);

  // --- Phase "new": a new source event is archived and reads back exactly. ---
  if (phase === 'new' || phase === 'all') {
    console.log('\n=== PHASE new: archive a controlled new source event ===');
    const source = sourceFor(newId);
    const src = await source.readConversation(newId);
    console.log('[e2e] source read:', JSON.stringify({
      messages: src.messages.length,
      declared: src.declaredMessages,
      observed: src.observedMessages,
      pages: src.pages,
      paginationComplete: src.paginationComplete,
    }));
    for (const m of src.messages) {
      console.log(`[e2e] source event id=${m.id} speaker=${m.speaker} ts=${m.timestamp} text=${JSON.stringify(m.text.slice(0, 120))}`);
    }

    const before = await inspector.fetchFile(owner, repo, transcriptPath(newId), E2E_BRANCH);
    const result = await runSync({
      source,
      writer,
      store,
      routes: routes.routes,
      fallbackRepository: routes.fallbackRepository,
      limit: 10,
      now,
    });
    printStatus(result);
    check('new: run produced no errors', result.errors.length === 0, result.errors.join('; '));

    const file = await inspector.fetchFile(owner, repo, transcriptPath(newId), E2E_BRANCH);
    check('new: transcript was committed to GitHub', !!file, file?.path ?? 'missing');
    const after = file?.content ?? '';
    const back = parseTranscriptMessages(after);
    check('new: committed transcript is new (not the pre-run state)', before?.content !== after);
    check(
      'new: read-back matches source message-for-message',
      back.length === src.messages.length &&
        back.every(
          (b, i) =>
            b.id === src.messages[i].id &&
            b.speaker === src.messages[i].speaker &&
            b.timestamp === src.messages[i].timestamp &&
            b.text === src.messages[i].text
        ),
      `${back.length} archived vs ${src.messages.length} source`
    );
    const firstText = back[0]?.text ?? '';
    check('new: archived text contains the source marker verbatim', firstText.includes('SYNC-E2E'));
    console.log(`[e2e] read-back ids: ${back.map((b) => b.id).join(', ')}`);
  }

  // --- Phase "new2": a second run does not duplicate the synced event. ---
  if (phase === 'new2' || phase === 'all') {
    console.log('\n=== PHASE new2: re-run the same source; no duplicate ===');
    const source = sourceFor(newId);
    const beforeFile = await inspector.fetchFile(owner, repo, transcriptPath(newId), E2E_BRANCH);
    const beforeCp = await inspector.fetchFile(owner, repo, CHECKPOINT_PATH, E2E_BRANCH);
    const result = await runSync({
      source,
      writer,
      store,
      routes: routes.routes,
      fallbackRepository: routes.fallbackRepository,
      limit: 10,
      now,
    });
    printStatus(result);
    const afterFile = await inspector.fetchFile(owner, repo, transcriptPath(newId), E2E_BRANCH);
    check(
      'new2: transcript blob is byte-identical (no duplicate write)',
      beforeFile?.sha === afterFile?.sha,
      `${beforeFile?.sha?.slice(0, 12)} -> ${afterFile?.sha?.slice(0, 12)}`
    );
    const st = result.status.conversations.find((c) => c.conversationId === newId);
    check('new2: addedThisRun is 0 for the already-synced conversation', st?.addedThisRun === 0, String(st?.addedThisRun));
    const afterCp = await inspector.fetchFile(owner, repo, CHECKPOINT_PATH, E2E_BRANCH);
    check('new2: checkpoint file is unchanged', beforeCp?.sha === afterCp?.sha);
    const back = parseTranscriptMessages(afterFile?.content ?? '');
    const srcNow = await source.readConversation(newId);
    check('new2: still exactly one archived copy of every source event', back.length === srcNow.messages.length);
  }

  // --- Phase "fault": a write failure must not advance the checkpoint. ---
  if (phase === 'fault' || phase === 'all') {
    console.log('\n=== PHASE fault: injected write failure after source read ===');
    const source = sourceFor(faultId);
    const src = await source.readConversation(faultId);
    console.log('[e2e] source read:', JSON.stringify({
      messages: src.messages.length,
      declared: src.declaredMessages,
      observed: src.observedMessages,
      pages: src.pages,
      paginationComplete: src.paginationComplete,
    }));
    for (const m of src.messages) {
      console.log(`[e2e] source event id=${m.id} speaker=${m.speaker} ts=${m.timestamp} text=${JSON.stringify(m.text.slice(0, 120))}`);
    }

    const beforeCp = await inspector.fetchFile(owner, repo, CHECKPOINT_PATH, E2E_BRANCH);
    const beforeText = (beforeCp?.content ?? '').includes(faultId);

    writer.failNextArchive = true;
    const failed = await runSync({
      source,
      writer,
      store,
      routes: routes.routes,
      fallbackRepository: routes.fallbackRepository,
      limit: 10,
      now,
    });
    printStatus(failed);
    check('fault: the run reported the injected failure', failed.errors.some((e) => /injected write failure/.test(e)));
    const st = failed.status.conversations.find((c) => c.conversationId === faultId);
    check('fault: the conversation is marked ERROR', st?.state === 'ERROR', st?.note);
    check('fault: the failed run does not claim a successful sync', failed.status.lastSuccessfulSync === null);

    const afterFailCp = await inspector.fetchFile(owner, repo, CHECKPOINT_PATH, E2E_BRANCH);
    const afterFailText = (afterFailCp?.content ?? '').includes(faultId);
    check(
      'fault: the committed checkpoint did not advance for the failed conversation',
      beforeText === afterFailText && afterFailText === false,
      `checkpoint contains ${faultId}: ${beforeText} -> ${afterFailText}`
    );
    const noTranscript = await inspector.fetchFile(owner, repo, transcriptPath(faultId), E2E_BRANCH);
    check('fault: no transcript was committed for the failed conversation', noTranscript === null);

    // Retry: the same event must now be archived exactly once.
    console.log('\n=== PHASE fault (retry): the same event is archived exactly once ===');
    const retry = await runSync({
      source,
      writer,
      store,
      routes: routes.routes,
      fallbackRepository: routes.fallbackRepository,
      limit: 10,
      now,
    });
    printStatus(retry);
    check('retry: the run has no errors', retry.errors.length === 0, retry.errors.join('; '));
    const file = await inspector.fetchFile(owner, repo, transcriptPath(faultId), E2E_BRANCH);
    check('retry: the transcript is now committed', !!file);
    const back = parseTranscriptMessages(file?.content ?? '');
    const srcNow = await source.readConversation(faultId);
    check(
      'retry: read-back matches source message-for-message',
      back.length === srcNow.messages.length &&
        back.every(
          (b, i) =>
            b.id === srcNow.messages[i].id &&
            b.speaker === srcNow.messages[i].speaker &&
            b.timestamp === srcNow.messages[i].timestamp &&
            b.text === srcNow.messages[i].text
        ),
      `${back.length} archived vs ${srcNow.messages.length} source`
    );
    const cpNow = await inspector.fetchFile(owner, repo, CHECKPOINT_PATH, E2E_BRANCH);
    const parsed = JSON.parse(cpNow?.content ?? '{"checkpoints":[]}');
    const cp = (parsed.checkpoints as any[]).find((c) => c.conversationId === faultId);
    check('retry: the checkpoint advanced exactly to the source message count', cp?.syncedCount === srcNow.messages.length, `syncedCount=${cp?.syncedCount}`);
    check('retry: the archived event appears exactly once', back.filter((b) => b.id === srcNow.messages[0]?.id).length === 1);
  }

  console.log(`\n[e2e] failures: ${failures}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[e2e] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
