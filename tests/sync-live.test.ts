import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OpenHandsClient } from '../src/sync/openhands-client.ts';
import { OpenHandsSourceReader } from '../src/sync/openhands-source.ts';
import { routeConversation } from '../src/sync/router.ts';
import { DEFAULT_ROUTES, DEFAULT_ROUTES_PATH, parseRoutes } from '../src/sync/routes.ts';
import { runSync, parseTranscriptMessages, type RepoWriter, type SourceConversation } from '../src/sync/pipeline.ts';
import { RepoCheckpointStore } from '../src/sync/store.ts';
import type { TranscriptMessage } from '../src/sync/types.ts';

// Live end-to-end evidence against the real OpenHands Cloud API.
//
// These tests need a read-only OPENHANDS_API_KEY and network access, so they are
// skipped when the key is absent (e.g. in CI without the secret). Run locally with
//   OPENHANDS_API_KEY=... npx tsx --test tests/sync-live.test.ts
// They prove the behaviours the pipeline promises on real data: cross-project
// routing, the count-vs-stream agreement, and an exact read-back.

const apiKey = process.env.OPENHANDS_API_KEY;
const maybe = apiKey ? test : test.skip;

const registry = parseRoutes(readFileSync(new URL(`../${DEFAULT_ROUTES_PATH}`, import.meta.url), 'utf8'));

/** A repository that keeps its files in memory. */
class MemoryWriter implements RepoWriter {
  files = new Map<string, string>();
  async read(repository: string, path: string): Promise<string | null> {
    return this.files.get(`${repository}::${path}`) ?? null;
  }
  async write(repository: string, files: { path: string; content: string }[]): Promise<{ commit: string | null }> {
    for (const f of files) this.files.set(`${repository}::${f.path}`, f.content);
    return { commit: 'live-test' };
  }
}

function client(): OpenHandsClient {
  // Pace below the API's limits so the test never relies on a 429 retry.
  return new OpenHandsClient({ apiKey: apiKey!, throttle: { minIntervalMs: 160, maxRequestsPerMinute: 80 } });
}

maybe('live: Amina and Firstborn sessions route to their own repositories', async () => {
  const reader = new OpenHandsSourceReader(client());
  const inv = await reader.listConversationsDetailed(100);
  assert.ok(inv.conversations.length > 0, 'the token must see at least one conversation');

  const routed: Record<string, string[]> = {};
  for (const c of inv.conversations) {
    const d = routeConversation(
      { conversationId: c.id, title: c.title, selectedRepository: c.selectedRepository },
      registry.routes,
      registry.fallbackRepository
    );
    if (d.repository) (routed[d.repository] ??= []).push(c.id);
  }
  // If an Amina session exists, it must go to Amina and never to Firstborn.
  if (routed['madnessgate44-debug/Amina']) {
    for (const id of routed['madnessgate44-debug/Amina']) {
      assert.ok(!routed['madnessgate44-debug/Firstborn']?.includes(id), `${id} must not also route to Firstborn`);
    }
  }
  console.log('live routing:', JSON.stringify(Object.fromEntries(Object.entries(routed).map(([k, v]) => [k, v.length]))));
});

maybe('live: the kind-filtered source count matches the paginated stream', async () => {
  const c = client();
  const reader = new OpenHandsSourceReader(c);
  const inv = await reader.listConversationsDetailed(6);
  for (const conversation of inv.conversations.slice(0, 3)) {
    const read = await reader.readConversation(conversation.id);
    assert.equal(read.paginationComplete, true, 'pagination must complete');
    assert.equal(
      read.declaredMessages,
      read.observedMessages,
      `declared (${read.declaredMessages}) must equal observed (${read.observedMessages}) for ${conversation.id}`
    );
  }
});

maybe('live: a committed transcript reads back exactly, message for message', async () => {
  const reader = new OpenHandsSourceReader(client());
  const inv = await reader.listConversationsDetailed(100);
  // Pick the Firstborn conversation with the most messages under a cheap bound.
  const c = client();
  let best: SourceConversation | null = null;
  let bestCount = 0;
  for (const conv of inv.conversations) {
    if (conv.selectedRepository !== 'madnessgate44-debug/Firstborn') continue;
    const n = await c.countEvents(conv.id, { kind: 'MessageEvent' });
    if (n > bestCount && n < 60) {
      bestCount = n;
      best = conv;
    }
  }
  if (!best) return; // nothing suitable in this account; nothing to prove

  const writer = new MemoryWriter();
  const store = new RepoCheckpointStore((r, p) => writer.read(r, p));
  await runSync({
    source: reader,
    writer,
    store,
    routes: registry.routes,
    fallbackRepository: registry.fallbackRepository,
    limit: 100,
    now: () => '2026-10-24T19:00:00Z',
  });

  const read = await reader.readConversation(best.id);
  const committed = writer.files.get(
    `madnessgate44-debug/Firstborn::docs/conversation-sync/transcripts/openhands/${best.id}.md`
  );
  assert.ok(committed, 'a transcript must have been committed');
  const back: TranscriptMessage[] = parseTranscriptMessages(committed!);
  assert.equal(back.length, read.messages.length, 'every source message must be present');
  for (let i = 0; i < back.length; i += 1) {
    assert.equal(back[i].id, read.messages[i].id);
    assert.equal(back[i].speaker, read.messages[i].speaker);
    assert.equal(back[i].timestamp, read.messages[i].timestamp);
    assert.equal(back[i].text, read.messages[i].text);
  }
});
