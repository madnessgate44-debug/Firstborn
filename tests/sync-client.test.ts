import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenHandsClient, type FetchLike } from '../src/sync/openhands-client.ts';
import { OpenHandsSourceReader, toSourceConversation } from '../src/sync/openhands-source.ts';
import { parseRoutes, DEFAULT_ROUTES } from '../src/sync/routes.ts';

// Client tests drive the real request/response handling against a scripted fetch:
// pagination must follow the cursor to the end, transient failures must be
// retried, and a permanent failure must surface rather than be swallowed.

interface ScriptedResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: { get(name: string): string | null };
}

function scriptedFetch(script: (url: string, call: number) => ScriptedResponse): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const r = script((url), n++);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.body ?? {})),
      headers: r.headers,
    };
  };
  return { fetch: fetchImpl, calls };
}

// Pacing is disabled in tests so they stay fast; the throttle is exercised by
// its own dedicated test below.
const NO_THROTTLE = { minIntervalMs: 0, maxRequestsPerMinute: 1_000_000, sleep: async () => {} };

test('client: paginates the event stream via next_page_id until it is null', async () => {
  const pages: Record<string, unknown> = {
    p1: { items: [{ id: 'a', timestamp: 't1', source: 'user' }], next_page_id: 'p2' },
    p2: { items: [{ id: 'b', timestamp: 't2', source: 'user' }], next_page_id: null },
  };
  const { fetch, calls } = scriptedFetch((url) => {
    const pageId = new URL(url).searchParams.get('page_id') ?? 'p1';
    return { body: pages[pageId] };
  });
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  const events = await client.listEvents('conv1');
  assert.deepEqual(events.map((e) => e.id), ['a', 'b']);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /page_id=p2/);
});

test('client: paginates conversation search via next_page_id', async () => {
  const { fetch } = scriptedFetch((url) => {
    const pageId = new URL(url).searchParams.get('page_id');
    if (!pageId) {
      return { body: { items: [{ id: 'c1', selected_repository: 'o/r' }], next_page_id: 'x' } };
    }
    return { body: { items: [{ id: 'c2', selected_repository: 'o/r' }], next_page_id: null } };
  });
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  const convs = await client.listConversations(10);
  assert.deepEqual(convs.map((c) => c.id), ['c1', 'c2']);
  assert.equal(convs[0].selectedRepository, 'o/r');
});

test('client: retries a transient 503 and succeeds', async () => {
  const { fetch, calls } = scriptedFetch((_url, call) => {
    if (call === 0) return { status: 503, text: 'unavailable' };
    return { body: { items: [], next_page_id: null } };
  });
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  const events = await client.listEvents('c');
  assert.deepEqual(events, []);
  assert.equal(calls.length, 2);
});

test('client: a permanent 404 surfaces as an error, not an empty result', async () => {
  const { fetch } = scriptedFetch(() => ({ status: 404, text: 'not found' }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  await assert.rejects(() => client.listEvents('missing'), /HTTP 404/);
});

test('client: retries a 429 and honours Retry-After without consuming the transient budget', async () => {
  const sleeps: number[] = [];
  const { fetch, calls } = scriptedFetch((_url, call) => {
    if (call === 0) return { status: 429, text: 'rate limited', headers: { get: () => '2' } };
    return { body: { items: [{ id: 'a', timestamp: 't', source: 'user' }], next_page_id: null } };
  });
  const client = new OpenHandsClient({
    apiKey: 'k',
    fetchImpl: fetch,
    retry: { sleep: async (ms) => { sleeps.push(ms); } },
    throttle: NO_THROTTLE,
  });
  const events = await client.listEvents('c');
  assert.deepEqual(events.map((e) => e.id), ['a']);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000], 'Retry-After: 2 must be honoured in milliseconds');
});

test('client: a 429 that never clears fails loudly with the rate-limit count', async () => {
  const { fetch } = scriptedFetch(() => ({ status: 429, text: 'rate limited' }));
  const client = new OpenHandsClient({
    apiKey: 'k',
    fetchImpl: fetch,
    retry: { rateLimitAttempts: 2, sleep: async () => {} },
    throttle: NO_THROTTLE,
  });
  await assert.rejects(() => client.listEvents('c'), /rate-limited 3x/);
});

test('client: pacing keeps a burst of requests under the rolling-minute cap', async () => {
  // A deterministic clock plus a recorded sleep lets us prove the throttle waits
  // rather than actually waiting.
  let clock = 0;
  const sleeps: number[] = [];
  const { fetch } = scriptedFetch(() => ({ body: { items: [{ id: 'a', timestamp: 't', source: 'user' }], next_page_id: null } }));
  const client = new OpenHandsClient({
    apiKey: 'k',
    fetchImpl: fetch,
    throttle: {
      minIntervalMs: 0,
      maxRequestsPerMinute: 2,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    },
  });
  await client.countEvents('c');
  await client.countEvents('c');
  await client.countEvents('c'); // the third must wait for the window to slide
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 60_001, 'the third request waits for the oldest to age out');
});

test('client: a non-JSON body on a 200 is an error, not silently empty', async () => {
  const { fetch } = scriptedFetch(() => ({ status: 200, text: '<html>oops</html>' }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  await assert.rejects(() => client.listEvents('c'), /non-JSON/);
});

test('client: a missing apiKey is rejected up front', () => {
  assert.throws(() => new OpenHandsClient({ apiKey: '' }), /apiKey is required/);
});

test('source adapter: maps a conversation and normalizes messages', async () => {
  const { fetch } = scriptedFetch((url) => {
    if (url.includes('/app-conversations/search')) {
      return { body: { items: [{ id: 'c1', title: 'T', selected_repository: 'o/r', conversation_ui_url: 'u' }], next_page_id: null } };
    }
    return {
      body: {
        items: [
          { id: 'e1', timestamp: 't1', source: 'user', llm_message: { content: 'hi' } },
          { id: 'e2', timestamp: 't2', source: 'environment', kind: 'ObservationEvent' },
        ],
        next_page_id: null,
      },
    };
  });
  const reader = new OpenHandsSourceReader(new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE }));
  const convs = await reader.listConversations(5);
  assert.equal(convs[0].conversationUiUrl, 'u');
  const messages = await reader.listMessages('c1');
  assert.deepEqual(messages.map((m) => m.id), ['e1']);
});

test('source adapter: toSourceConversation tolerates missing fields', () => {
  const c = toSourceConversation({ id: 'c1', title: null, selectedRepository: null, selectedBranch: null, createdAt: null, updatedAt: null, executionStatus: null, raw: {} });
  assert.equal(c.conversationUiUrl, null);
});

test('routes: a malformed routes file falls back to the safe default', () => {
  assert.deepEqual(parseRoutes('not json'), DEFAULT_ROUTES);
  assert.deepEqual(parseRoutes('{"routes":[]}'), DEFAULT_ROUTES);
  const custom = parseRoutes(JSON.stringify({ version: 1, fallbackRepository: 'a/b', routes: [{ repository: 'a/b', selectedRepository: 'a/A' }] }));
  assert.equal(custom.fallbackRepository, 'a/b');
  assert.equal(custom.routes.length, 1);
});

test('client: the event stream fails loudly when the page guard is exhausted', async () => {
  // Every page reports a next cursor with a non-empty item list, so the guard is
  // what stops the loop. It must throw, never return a silently partial result.
  let n = 0;
  const { fetch } = scriptedFetch(() => ({ body: { items: [{ id: `e${n++}`, timestamp: 't', source: 'user' }], next_page_id: `p${n}` } }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  await assert.rejects(() => client.listEventsDetailed('c', { pageGuard: 3 }), /exceeded the 3-page guard/);
});

test('client: an empty page that still reports a next cursor fails loudly', async () => {
  const { fetch } = scriptedFetch(() => ({ body: { items: [], next_page_id: 'always' } }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  await assert.rejects(() => client.listEvents('c'), /empty page but still reports a next page/);
});

test('client: countEvents filters by kind so the over-reporting unfiltered count is not used', async () => {
  const { fetch, calls } = scriptedFetch(() => ({ body: 2 }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  const n = await client.countEvents('c', { kind: 'MessageEvent' });
  assert.equal(n, 2);
  assert.match(calls[0], /kind__eq=MessageEvent/);
});

test('client: listConversationsDetailed reports truncation past the limit', async () => {
  const { fetch } = scriptedFetch((url) => {
    const pageId = new URL(url).searchParams.get('page_id');
    if (!pageId) return { body: { items: [{ id: 'c1' }, { id: 'c2' }], next_page_id: 'x' } };
    return { body: { items: [{ id: 'c3' }], next_page_id: null } };
  });
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  const inv = await client.listConversationsDetailed(2);
  assert.deepEqual(inv.conversations.map((c) => c.id), ['c1', 'c2']);
  assert.equal(inv.totalAvailable, 3);
  assert.equal(inv.truncated, true);
  assert.equal(inv.inventoryComplete, true);
});

test('client: listConversationsDetailed reports a complete inventory when under the limit', async () => {
  const { fetch } = scriptedFetch(() => ({ body: { items: [{ id: 'c1' }], next_page_id: null } }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  const inv = await client.listConversationsDetailed(50);
  assert.equal(inv.totalAvailable, 1);
  assert.equal(inv.truncated, false);
  assert.equal(inv.inventoryComplete, true);
});

test('client: listEventsDetailed reports pagination completeness', async () => {
  const { fetch } = scriptedFetch(() => ({ body: { items: [{ id: 'a', timestamp: 't', source: 'user' }], next_page_id: null } }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE });
  const read = await client.listEventsDetailed('c');
  assert.equal(read.paginationComplete, true);
  assert.equal(read.events.length, 1);
});

test('source adapter: readConversation wires declared vs observed message counts', async () => {
  const { fetch } = scriptedFetch((url) => {
    if (url.includes('/events/count')) return { body: 2 };
    return {
      body: {
        items: [
          { id: 'e1', timestamp: 't1', source: 'user', llm_message: { content: 'hi' } },
          { id: 'e2', timestamp: 't2', source: 'agent', llm_message: { content: 'yo' } },
        ],
        next_page_id: null,
      },
    };
  });
  const reader = new OpenHandsSourceReader(new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE }));
  const read = await reader.readConversation('c1');
  assert.equal(read.messages.length, 2);
  assert.equal(read.declaredMessages, 2);
  assert.equal(read.observedMessages, 2);
  assert.equal(read.paginationComplete, true);
});

test('source adapter: a failing count endpoint leaves the count unverified, not zero', async () => {
  const { fetch } = scriptedFetch((url) => {
    if (url.includes('/events/count')) return { status: 404, text: 'nope' };
    return { body: { items: [{ id: 'e1', timestamp: 't1', source: 'user', llm_message: { content: 'hi' } }], next_page_id: null } };
  });
  const reader = new OpenHandsSourceReader(new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch, throttle: NO_THROTTLE }));
  const read = await reader.readConversation('c1');
  assert.equal(read.declaredMessages, null);
  assert.equal(read.messages.length, 1);
});
