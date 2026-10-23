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
}

function scriptedFetch(script: (url: string, call: number) => ScriptedResponse): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const r = script(url, n++);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.body ?? {})),
    };
  };
  return { fetch: fetchImpl, calls };
}

test('client: paginates the event stream via next_page_id until it is null', async () => {
  const pages: Record<string, unknown> = {
    p1: { items: [{ id: 'a', timestamp: 't1', source: 'user' }], next_page_id: 'p2' },
    p2: { items: [{ id: 'b', timestamp: 't2', source: 'user' }], next_page_id: null },
  };
  const { fetch, calls } = scriptedFetch((url) => {
    const pageId = new URL(url).searchParams.get('page_id') ?? 'p1';
    return { body: pages[pageId] };
  });
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch });
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
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch });
  const convs = await client.listConversations(10);
  assert.deepEqual(convs.map((c) => c.id), ['c1', 'c2']);
  assert.equal(convs[0].selectedRepository, 'o/r');
});

test('client: retries a transient 503 and succeeds', async () => {
  const { fetch, calls } = scriptedFetch((_url, call) => {
    if (call === 0) return { status: 503, text: 'unavailable' };
    return { body: { items: [], next_page_id: null } };
  });
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch });
  const events = await client.listEvents('c');
  assert.deepEqual(events, []);
  assert.equal(calls.length, 2);
});

test('client: a permanent 404 surfaces as an error, not an empty result', async () => {
  const { fetch } = scriptedFetch(() => ({ status: 404, text: 'not found' }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch });
  await assert.rejects(() => client.listEvents('missing'), /HTTP 404/);
});

test('client: a non-JSON body on a 200 is an error, not silently empty', async () => {
  const { fetch } = scriptedFetch(() => ({ status: 200, text: '<html>oops</html>' }));
  const client = new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch });
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
  const reader = new OpenHandsSourceReader(new OpenHandsClient({ apiKey: 'k', fetchImpl: fetch }));
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
