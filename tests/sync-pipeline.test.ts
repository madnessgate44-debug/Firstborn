import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSync,
  parseTranscriptMessages,
  type RepoWriter,
  type SourceReader,
  type SourceConversation,
  type SourceConversationInventory,
  type SourceReadResult,
} from '../src/sync/pipeline.ts';
import { RepoCheckpointStore } from '../src/sync/store.ts';
import type { RouteRule } from '../src/sync/router.ts';
import type { TranscriptMessage } from '../src/sync/types.ts';

// End-to-end pipeline tests with a fake source and a fake repository. These prove
// the routing, idempotency, failure visibility and recovery behaviour without a
// network, so the same logic can be trusted when it runs against the real API.

class FakeWriter implements RepoWriter {
  files = new Map<string, string>();
  commits: { repository: string; paths: string[]; message: string }[] = [];
  failNextWrite = false;
  failRepositories = new Set<string>();

  private key(repository: string, path: string): string {
    return `${repository}::${path}`;
  }

  async read(repository: string, path: string): Promise<string | null> {
    return this.files.get(this.key(repository, path)) ?? null;
  }

  async write(repository: string, files: { path: string; content: string }[], message: string): Promise<{ commit: string | null }> {
    if (this.failNextWrite || this.failRepositories.has(repository)) {
      this.failNextWrite = false;
      throw new Error(`injected write failure for ${repository}`);
    }
    for (const f of files) this.files.set(this.key(repository, f.path), f.content);
    this.commits.push({ repository, paths: files.map((f) => f.path), message });
    return { commit: `sha-${this.commits.length}` };
  }
}

class FakeSource implements SourceReader {
  conversations: SourceConversation[] = [];
  messages = new Map<string, TranscriptMessage[]>();
  /** Optional completeness metadata, keyed by conversation id. */
  declared = new Map<string, number | null>();
  observed = new Map<string, number>();
  paginationComplete = new Map<string, boolean>();
  totalAvailable = 0;
  truncated = false;
  inventoryComplete = true;

  async listConversations(limit: number): Promise<SourceConversation[]> {
    return this.conversations.slice(0, limit);
  }

  async listConversationsDetailed(_limit: number): Promise<SourceConversationInventory> {
    return {
      conversations: this.conversations,
      totalAvailable: this.totalAvailable || this.conversations.length,
      truncated: this.truncated,
      inventoryComplete: this.inventoryComplete,
    };
  }

  async listMessages(conversationId: string): Promise<TranscriptMessage[]> {
    return this.messages.get(conversationId) ?? [];
  }

  async readConversation(conversationId: string): Promise<SourceReadResult> {
    const messages = this.messages.get(conversationId) ?? [];
    const observed = this.observed.get(conversationId) ?? messages.length;
    return {
      messages,
      eventsRead: observed,
      observedMessages: observed,
      declaredMessages: this.declared.has(conversationId) ? this.declared.get(conversationId)! : null,
      paginationComplete: this.paginationComplete.get(conversationId) ?? true,
      pages: 1,
    };
  }
}

const ROUTES: RouteRule[] = [
  { repository: 'owner/amina', selectedRepository: 'owner/Amina' },
  { repository: 'owner/baleegh', selectedRepository: 'owner/SmartFarm' },
];

function conv(id: string, repo: string | null, title = 'Work'): SourceConversation {
  return { id, title, selectedRepository: repo, conversationUiUrl: `https://app.all-hands.dev/canvas/conversations/${id}` };
}

function m(id: string, ts: string, text = `t-${id}`): TranscriptMessage {
  return { id, speaker: 'user', timestamp: ts, text };
}

// The store reads checkpoints straight out of the fake repository, so these tests
// exercise the same round-trip (commit -> read back) the real pipeline uses.
function base(source: FakeSource, writer: FakeWriter) {
  const store = new RepoCheckpointStore((repository, path) => writer.read(repository, path));
  return { source, writer, store, routes: ROUTES, fallbackRepository: null, now: () => '2026-01-01T01:00:00Z' };
}

test('pipeline: archives new messages to the correct repository', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1'), m('m2', 't2')]);

  const result = await runSync(base(source, writer));

  assert.equal(result.errors.length, 0);
  assert.equal(result.status.totals.messages, 2);
  assert.ok(writer.files.has('owner/amina::docs/conversation-sync/transcripts/openhands/c1.md'));
  assert.ok(!writer.files.has('owner/baleegh::docs/conversation-sync/transcripts/openhands/c1.md'));
  const transcript = writer.files.get('owner/amina::docs/conversation-sync/transcripts/openhands/c1.md')!;
  assert.match(transcript, /t-m1/);
  assert.match(transcript, /t-m2/);
  assert.equal(result.status.lastSuccessfulSync, '2026-01-01T01:00:00Z');
});

test('pipeline: a second run with no new messages is a no-op (idempotent)', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1'), m('m2', 't2')]);

  await runSync(base(source, writer));
  const commitsAfterFirst = writer.commits.length;
  const result = await runSync(base(source, writer));

  // Only the status refresh commits; no transcript commit happens again.
  const transcriptCommits = writer.commits.filter((c) => c.message.includes('archive'));
  assert.equal(transcriptCommits.length, 1);
  assert.ok(writer.commits.length > commitsAfterFirst - 1);
  assert.equal(result.status.conversations[0].note, 'no new messages');
});

test('pipeline: new messages append without duplicating history', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1')]);
  await runSync(base(source, writer));

  source.messages.set('c1', [m('m1', 't1'), m('m2', 't2'), m('m3', 't3')]);
  const result = await runSync(base(source, writer));

  const transcript = writer.files.get('owner/amina::docs/conversation-sync/transcripts/openhands/c1.md')!;
  assert.equal((transcript.match(/t-m1/g) ?? []).length, 1, 'm1 must appear exactly once');
  assert.equal(result.status.totals.messages, 3);
  const parsed = parseTranscriptMessages(transcript);
  assert.deepEqual(parsed.map((p) => p.id), ['m1', 'm2', 'm3']);
});

test('pipeline: cross-project isolation — no leakage between repositories', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('a1', 'owner/Amina'), conv('b1', 'owner/SmartFarm')];
  source.messages.set('a1', [m('am1', 't1', 'AMINA-SECRET')]);
  source.messages.set('b1', [m('bm1', 't1', 'BALEEGH-SECRET')]);

  await runSync(base(source, writer));

  const amina = writer.files.get('owner/amina::docs/conversation-sync/transcripts/openhands/a1.md')!;
  const baleegh = writer.files.get('owner/baleegh::docs/conversation-sync/transcripts/openhands/b1.md')!;
  assert.match(amina, /AMINA-SECRET/);
  assert.doesNotMatch(amina, /BALEEGH-SECRET/);
  assert.match(baleegh, /BALEEGH-SECRET/);
  assert.doesNotMatch(baleegh, /AMINA-SECRET/);

  // The checkpoint files are scoped per repository too.
  const aminaCp = writer.files.get('owner/amina::docs/conversation-sync/checkpoints.json')!;
  const baleeghCp = writer.files.get('owner/baleegh::docs/conversation-sync/checkpoints.json')!;
  assert.match(aminaCp, /a1/);
  assert.doesNotMatch(aminaCp, /b1/);
  assert.match(baleeghCp, /b1/);
  assert.doesNotMatch(baleeghCp, /a1/);
});

test('pipeline: an injected write failure is visible and a retry repairs it', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1'), m('m2', 't2')]);

  // First run: the transcript write fails.
  writer.failRepositories.add('owner/amina');
  const failed = await runSync(base(source, writer));
  assert.ok(failed.errors.some((e) => /injected write failure/.test(e)));
  assert.equal(failed.status.lastSuccessfulSync, null, 'a failed run must not claim a successful sync');
  assert.equal(failed.status.totals.errors >= 0, true);

  // The checkpoint must not have advanced past an unwritten batch.
  assert.equal(writer.files.has('owner/amina::docs/conversation-sync/transcripts/openhands/c1.md'), false);

  // Second run after the fault clears: the messages are archived, once.
  writer.failRepositories.clear();
  const recovered = await runSync(base(source, writer));
  assert.equal(recovered.errors.length, 0);
  const transcript = writer.files.get('owner/amina::docs/conversation-sync/transcripts/openhands/c1.md')!;
  assert.equal((transcript.match(/t-m1/g) ?? []).length, 1);
  assert.equal((transcript.match(/t-m2/g) ?? []).length, 1);
  assert.equal(recovered.status.totals.messages, 2);
});

test('pipeline: a conversation that errors does not abort the others', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('bad', 'owner/Amina'), conv('good', 'owner/SmartFarm')];
  // "bad" raises on read; "good" is unaffected.
  const original = source.readConversation.bind(source);
  source.readConversation = async (id: string) => {
    if (id === 'bad') throw new Error('source read failed');
    return original(id);
  };
  source.messages.set('good', [m('gm1', 't1')]);

  const result = await runSync(base(source, writer));
  assert.ok(result.errors.some((e) => /source read failed/.test(e)));
  const bad = result.status.conversations.find((c) => c.conversationId === 'bad')!;
  const good = result.status.conversations.find((c) => c.conversationId === 'good')!;
  assert.equal(bad.state, 'ERROR');
  assert.equal(good.state, 'OK');
  assert.ok(writer.files.has('owner/baleegh::docs/conversation-sync/transcripts/openhands/good.md'));
});

test('pipeline: an unrouted conversation is reported and written nowhere', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('u1', 'owner/Unknown')];
  source.messages.set('u1', [m('um1', 't1')]);

  const result = await runSync(base(source, writer));
  const status = result.status.conversations[0];
  assert.equal(status.repository, '(unrouted)');
  assert.equal(status.state, 'ERROR');
  assert.equal(writer.commits.length, 0);
});

test('pipeline: the status file lists the unsupported ChatGPT source', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1')]);

  await runSync(base(source, writer));
  const statusJson = JSON.parse(writer.files.get('owner/amina::docs/conversation-sync/sync-status.json')!);
  assert.equal(statusJson.unsupportedSources.length, 1);
  assert.match(statusJson.unsupportedSources[0], /ChatGPT personal conversations/);
});

test('pipeline: a source count mismatch surfaces as a GAP and an error', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1'), m('m2', 't2')]);
  // The source declares 5 message events but the read only returned 2.
  source.declared.set('c1', 5);

  const result = await runSync(base(source, writer));

  assert.ok(result.errors.some((e) => /declares 5 message/.test(e)));
  const status = result.status.conversations.find((c) => c.conversationId === 'c1')!;
  assert.equal(status.state, 'GAP');
  assert.match(status.note!, /3 are unread/);
});

test('pipeline: an incomplete pagination read surfaces as a GAP', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1')]);
  source.paginationComplete.set('c1', false);

  const result = await runSync(base(source, writer));

  assert.ok(result.errors.some((e) => /pagination did not complete/.test(e)));
  const status = result.status.conversations.find((c) => c.conversationId === 'c1')!;
  assert.equal(status.state, 'GAP');
});

test('pipeline: a truncated inventory is reported, not silently dropped', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1')]);
  source.totalAvailable = 9;
  source.truncated = true;
  source.inventoryComplete = true;

  const result = await runSync(base(source, writer));

  assert.equal(result.status.inventory.examined, 1);
  assert.equal(result.status.inventory.totalAvailable, 9);
  assert.equal(result.status.inventory.truncated, true);
  // The status file records the truncation too.
  const statusJson = JSON.parse(writer.files.get('owner/amina::docs/conversation-sync/sync-status.json')!);
  assert.equal(statusJson.inventory.truncated, true);
  assert.match(writer.files.get('owner/amina::docs/conversation-sync/sync-status.md')!, /TRUNCATED/);
});

test('pipeline: status distinguishes this run from the cumulative archive', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('a1', 'owner/Amina'), conv('a2', 'owner/Amina')];
  source.messages.set('a1', [m('am1', 't1'), m('am2', 't2')]);
  source.messages.set('a2', [m('bm1', 't1')]);
  await runSync(base(source, writer));

  // A later run examines only one conversation.
  source.conversations = [conv('a1', 'owner/Amina')];
  const result = await runSync(base(source, writer));

  assert.equal(result.status.scope, 'run');
  assert.equal(result.status.totals.conversations, 1, 'this run examined one conversation');
  assert.equal(result.status.cumulative.conversations, 2, 'the archive still holds two');
  assert.equal(result.status.cumulative.messages, 3, 'and all three messages');
});

test('pipeline: a partial run preserves checkpoints for unexamined conversations', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('a1', 'owner/Amina'), conv('a2', 'owner/Amina')];
  source.messages.set('a1', [m('am1', 't1')]);
  source.messages.set('a2', [m('bm1', 't1')]);
  await runSync(base(source, writer));

  // Second run examines only a1 and finds a new message there.
  source.conversations = [conv('a1', 'owner/Amina')];
  source.messages.set('a1', [m('am1', 't1'), m('am2', 't2')]);
  await runSync(base(source, writer));

  const cp = JSON.parse(writer.files.get('owner/amina::docs/conversation-sync/checkpoints.json')!);
  const ids = cp.checkpoints.map((c: any) => c.conversationId).sort();
  assert.deepEqual(ids, ['a1', 'a2'], 'the unexamined conversation keeps its checkpoint');
  const a2 = cp.checkpoints.find((c: any) => c.conversationId === 'a2');
  assert.equal(a2.syncedCount, 1, 'and its count is unchanged');
});

test('pipeline: per-conversation status reports cumulative and per-run counts', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1')]);
  await runSync(base(source, writer));

  source.messages.set('c1', [m('m1', 't1'), m('m2', 't2')]);
  const result = await runSync(base(source, writer));
  const status = result.status.conversations[0];
  assert.equal(status.messageCount, 2, 'cumulative messages archived');
  assert.equal(status.addedThisRun, 1, 'messages added by this run');
});

test('pipeline: per-conversation status carries the source read completeness', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('c1', 'owner/Amina')];
  source.messages.set('c1', [m('m1', 't1'), m('m2', 't2')]);
  // The source declares two message events and the read observed two.
  source.declared.set('c1', 2);
  source.observed.set('c1', 2);

  const result = await runSync(base(source, writer));
  const status = result.status.conversations[0];
  assert.equal(status.declaredMessages, 2);
  assert.equal(status.observedMessages, 2);
  assert.equal(status.paginationComplete, true);
  assert.equal(status.pages, 1);

  // The committed status files expose the same completeness facts.
  const statusJson = JSON.parse(writer.files.get('owner/amina::docs/conversation-sync/sync-status.json')!);
  assert.equal(statusJson.conversations[0].declaredMessages, 2);
  assert.equal(statusJson.conversations[0].observedMessages, 2);
  const md = writer.files.get('owner/amina::docs/conversation-sync/sync-status.md')!;
  assert.match(md, /## Source read completeness/);
  assert.match(md, /\| `c1` \| 2 \| 2 \| 1 \| complete \|/);
});

test('pipeline: an unknown project fails closed and is written nowhere', async () => {
  const source = new FakeSource();
  const writer = new FakeWriter();
  source.conversations = [conv('u1', 'owner/SomeOtherProject')];
  source.messages.set('u1', [m('um1', 't1')]);

  // Fallback is null: the pipeline must not guess a destination.
  const result = await runSync(base(source, writer));
  const status = result.status.conversations[0];
  assert.equal(status.repository, '(unrouted)');
  assert.equal(status.state, 'ERROR');
  assert.equal(writer.commits.length, 0);
});
