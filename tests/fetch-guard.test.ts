import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildForgeTools } from '../src/agent/tools.ts';
import type { AgentTool, LoopContext } from '../src/agent/loop.ts';

// The fetch_url guard is exercised against a real local HTTP fixture, so the
// redirect and size-cap paths run for real. Nothing here reaches the network:
// the blocked targets are IP literals the guard rejects before connecting.
//
// fetch_url blocks loopback by default. The fixture listens on 127.0.0.1, so only
// the cases that drive it opt in through FORGE_FETCH_ALLOW_LOOPBACK, and the
// opt-in is always restored afterwards.

const ENV = 'FORGE_FETCH_ALLOW_LOOPBACK';
let savedEnv: string | undefined;

/** Run fn with the loopback opt-in on, then put the environment back as it was. */
async function withLoopback<T>(fn: () => Promise<T>): Promise<T> {
  process.env[ENV] = 'true';
  try {
    return await fn();
  } finally {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  }
}

let server: Server;
let base = '';
let port = 0;

const BIG = 'x'.repeat(100_000);

function start(): Promise<void> {
  server = createServer((req, res) => {
    if (req.url === '/redirect-to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (req.url === '/redirect-to-loopback') {
      res.writeHead(302, { location: `${base}/secret` });
      res.end();
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(BIG);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url === '/secret' ? 'secret reached' : 'hello from the fixture');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
}

test.before(async () => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  await start();
});
test.after(() => new Promise<void>((resolve, reject) => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (!server?.listening) return resolve();
  server.close((error) => error ? reject(error) : resolve());
}));

const ctx: LoopContext = { goal: 'exercise the fetch guard', workspace: 'test-workspace', step: 1 };
function fetchTool(): AgentTool {
  const tool = buildForgeTools({ owner: 'o', repo: 'r' }).find((t) => t.name === 'fetch_url');
  assert.ok(tool, 'fetch_url must be registered');
  return tool;
}

test('fetch_url refuses a non-http(s) scheme', async () => {
  const result = await fetchTool().run({ url: 'file:///etc/passwd' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.output, /http\(s\)/);
});

test('fetch_url refuses the cloud metadata address', async () => {
  const result = await fetchTool().run({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.output, /blocked/);
});

test('fetch_url blocks a direct 127.0.0.1 URL when the opt-in is unset', async () => {
  const result = await fetchTool().run({ url: base }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.output, /blocked/);
});

test('fetch_url blocks a name that resolves to 127.0.0.1 when the opt-in is unset', async () => {
  // A hostname, not an IP literal, so the guard resolves it on the first hop. The
  // fixture answers on loopback, but with the opt-in unset the request is refused
  // before it is sent. This is the offline-deterministic form of "a URL that would
  // reach 127.0.0.1 is blocked": a reachable public first hop cannot be used here
  // without depending on the network, so the loopback target is reached by name.
  const result = await fetchTool().run({ url: `http://localhost:${port}/redirect-to-loopback` }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.output, /blocked/);
});

test('fetch_url re-checks the loopback opt-in on the redirect target', async () => {
  // With the opt-in on, hop one (the fixture) is allowed and its 302 to 127.0.0.1 is
  // followed. This proves the redirect target goes through the same guard, so the
  // unset case above is the guard refusing that target, not a missing redirect path.
  const result = await withLoopback(() => fetchTool().run({ url: `${base}/redirect-to-loopback` }, ctx));
  assert.equal(result.ok, true);
  assert.match(result.output, /secret reached/);
});

test('fetch_url refuses a redirect whose target is a blocked address', async () => {
  const result = await withLoopback(() => fetchTool().run({ url: `${base}/redirect-to-metadata` }, ctx));
  assert.equal(result.ok, false);
  assert.match(result.output, /blocked/);
});

test('fetch_url stops after the redirect limit', async () => {
  const result = await withLoopback(() => fetchTool().run({ url: `${base}/loop` }, ctx));
  assert.equal(result.ok, false);
  assert.match(result.output, /Too many redirects/);
});

test('fetch_url caps a large body instead of buffering it all', async () => {
  const result = await withLoopback(() => fetchTool().run({ url: `${base}/big` }, ctx));
  assert.equal(result.ok, true);
  assert.match(result.output, /HTTP 200/);
  assert.ok(result.output.length < 25_000, `body was not capped: ${result.output.length}`);
});

test('fetch_url still reads an ordinary local response when the opt-in is on', async () => {
  const result = await withLoopback(() => fetchTool().run({ url: base }, ctx));
  assert.equal(result.ok, true);
  assert.match(result.output, /HTTP 200/);
  assert.match(result.output, /hello from the fixture/);
});
