import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `/api/coordination` serves a repository file, so it is gated like the other
// /api routes. The no-token branch answers 401 before any GitHub call, so this
// test is deterministic and needs no network.
test('GET /api/coordination is refused without a token', async () => {
  const port = 34118;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npm, ['start'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });

  const killTree = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  };

  try {
    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) up = true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(up, 'server did not become healthy');

    const res = await fetch(`http://127.0.0.1:${port}/api/coordination`);
    assert.equal(res.status, 401, 'unauthenticated coordination read must be refused');
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /token/i);
  } finally {
    killTree();
  }
});

// The UI must keep working: it has to send the same token the guarded routes expect.
test('the client sends the token when it reads the coordination doc', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('const fetchCoordinationDoc');
  assert.ok(start >= 0, 'fetchCoordinationDoc not found');
  const body = app.slice(start, start + 600);
  assert.match(body, /fetch\('\/api\/coordination', \{ headers \}\)/, 'coordination fetch must pass headers');
  assert.match(body, /Authorization/, 'coordination fetch must send an Authorization header');
});
