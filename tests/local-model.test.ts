import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { callLocalModel, localModelUrl } from '../src/services/local-model.ts';

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3000,
  pollIntervalMs = 50,
): Promise<void> {
  if (predicate()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Condition not met within ${timeoutMs}ms`));
      }
    }, pollIntervalMs);
    timer.unref?.();
  });
}

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

test('default node:http path succeeds after 1.5s delay under 30s timeout', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"delayed":"ok"}' } }] }));
    }, 1500);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callLocalModel(
      [{ role: 'user', content: 'hello' }],
      {
        FORGE_LOCAL_MODEL_URL: `http://127.0.0.1:${port}`,
        FORGE_LOCAL_MODEL_TIMEOUT_S: '30',
      },
    );
    assert.equal(res.success, true);
    assert.equal(res.text, '{"delayed":"ok"}');
  } finally {
    server.close();
  }
});

test('default node:http path times out around 30s when server accepts and never responds', { timeout: 60000 }, async () => {
  const sockets = new Set<Socket>();
  let closedCount = 0;

  const server = http.createServer((req) => {
    req.resume();
    // Intentionally accept and never respond.
  });
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => {
      closedCount += 1;
      sockets.delete(sock);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const startedAt = Date.now();

  try {
    const res = await callLocalModel(
      [{ role: 'user', content: 'hello' }],
      {
        FORGE_LOCAL_MODEL_URL: `http://127.0.0.1:${port}`,
        FORGE_LOCAL_MODEL_TIMEOUT_S: '30',
      },
    );
    const elapsedMs = Date.now() - startedAt;
    console.log('30s timeout error message:', res.error);
    console.log('30s timeout elapsed (ms):', elapsedMs);

    assert.equal(res.success, false);
    assert.ok(typeof res.error === 'string' && res.error.length > 0);
    assert.ok(elapsedMs >= 29_000 && elapsedMs <= 40_000, `Expected elapsed between 29s and 40s, got ${elapsedMs}ms`);

    try {
      await waitForCondition(() => closedCount >= 1, 3000, 50);
    } catch {
      // Fall through to the explicit assertion so failure reports closedCount clearly.
    }
    assert.ok(closedCount >= 1, `Expected server to observe connection close, saw ${closedCount}`);
  } finally {
    for (const sock of sockets) {
      sock.destroy();
    }
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('default node:http path refuses 302 redirect responses', async () => {
  const target = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"redirected":true}' } }] }));
  });
  const redirector = http.createServer((req, res) => {
    req.resume();
    const targetPort = (target.address() as AddressInfo).port;
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/v1/chat/completions` });
    res.end();
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const port = (redirector.address() as AddressInfo).port;
  try {
    const res = await callLocalModel(
      [{ role: 'user', content: 'hello' }],
      { FORGE_LOCAL_MODEL_URL: `http://127.0.0.1:${port}` },
    );
    assert.equal(res.success, false);
    assert.ok(res.error && res.error.length > 0);
  } finally {
    redirector.close();
    target.close();
  }
});
