import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLocalModel, localModelUrl } from '../src/services/local-model.ts';

test('local model route is off unless configured and is loopback-only', () => {
  assert.equal(localModelUrl({}), null);
  assert.equal(localModelUrl({ FORGE_LOCAL_MODEL_URL: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080/v1/chat/completions');
  for (const bad of ['https://127.0.0.1:8080', 'http://localhost:8080', 'http://example.com', 'http://10.0.0.5:8080', 'http://u:p@127.0.0.1:8080', 'not a url']) {
    assert.throws(() => localModelUrl({ FORGE_LOCAL_MODEL_URL: bad }), /FORGE_LOCAL_MODEL_URL/, bad);
  }
});

test('callLocalModel posts JSON to the loopback endpoint and returns the text', async () => {
  let seen: { url: string; body: any } | null = null;
  const fake = (async (url: string, init: any) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await callLocalModel([{ role: 'user', content: 'hi' }], { FORGE_LOCAL_MODEL_URL: 'http://127.0.0.1:9999', FORGE_LOCAL_MODEL_NAME: 'm' }, fake);
  assert.equal(r.success, true);
  assert.equal(r.text, '{"ok":true}');
  assert.equal(seen!.url, 'http://127.0.0.1:9999/v1/chat/completions');
  assert.equal(seen!.body.model, 'm');
});

test('callLocalModel reports failure instead of falling back', async () => {
  const fail = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  const r = await callLocalModel([{ role: 'user', content: 'hi' }], { FORGE_LOCAL_MODEL_URL: 'http://127.0.0.1:9999' }, fail);
  assert.equal(r.success, false);
  assert.match(r.error || '', /HTTP 500/);
  const empty = (async () => new Response(JSON.stringify({ choices: [{ message: { content: ' ' } }] }), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await callLocalModel([{ role: 'user', content: 'x' }], { FORGE_LOCAL_MODEL_URL: 'http://127.0.0.1:9999' }, empty)).success, false);
});
