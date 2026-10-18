import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { BrowserService } from '../src/services/browser.ts';

// Item 4: the browser must refuse internal addresses both when asked to open one
// and when a page tries to fetch one itself. A real Chromium and a real local
// fixture are used; the blocked target is an IP literal, so nothing leaves the box.

let server: Server;
let base = '';

function start(): Promise<void> {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Guard fixture</title></head><body>
      <h1>Guard fixture</h1>
      <p id="out">idle</p>
      <script>
        fetch('http://169.254.169.254/latest/meta-data/')
          .then(() => { document.getElementById('out').textContent = 'metadata fetched'; })
          .catch(() => { document.getElementById('out').textContent = 'metadata blocked'; });
      </script>
    </body></html>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
      resolve();
    });
  });
}

test.before(async () => { await start(); });
test.after(() => new Promise<void>((resolve, reject) => {
  if (!server?.listening) return resolve();
  server.close((error) => error ? reject(error) : resolve());
}));

test('browser_open refuses the cloud metadata address', async () => {
  const browser = new BrowserService();
  try {
    await assert.rejects(
      () => browser.open('http://169.254.169.254/latest/meta-data/'),
      /blocked/
    );
  } finally {
    await browser.close();
  }
});

test('browser_open still reaches a local dev server', async () => {
  const browser = new BrowserService();
  try {
    const snap = await browser.open(base);
    assert.match(snap.title, /Guard fixture/);
  } finally {
    await browser.close();
  }
});

test('the browser blocks a page request to an internal address', async () => {
  const browser = new BrowserService();
  try {
    await browser.open(base);
    // The page's own fetch to the metadata address must be aborted, so the text
    // stays "metadata fetched" only if the guard failed.
    const deadline = Date.now() + 5_000;
    let text = '';
    while (Date.now() < deadline) {
      const snap = await browser.view();
      text = snap.text;
      if (text.includes('metadata blocked') || text.includes('metadata fetched')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(text, /metadata blocked/);
  } finally {
    await browser.close();
  }
});
