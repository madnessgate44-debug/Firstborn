import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpHandler, type McpHttpHandler } from '../src/mcp/http.ts';

// End-to-end over the real Streamable HTTP transport: a real MCP client talks
// real JSON-RPC to the Express endpoint, which drives a real headless Chromium
// against a real local HTTP server. Nothing is mocked.

const PAGE = `<!doctype html><html><head><title>Forreyra HTTP Page</title></head>
<body>
  <h1>Hello over HTTP</h1>
  <a href="/next">next</a>
  <p>Contact: sk-abcdef0123456789ABCDEF0123456789</p>
</body></html>`;

let page: Server;
const servers: Server[] = [];
const handlers: McpHttpHandler[] = [];
let base = '';

function startApp(token?: string, allowWrites = false): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const a = express();
    a.use(express.json());
    const handler = createMcpHttpHandler({ token, allowConsequential: allowWrites });
    handlers.push(handler);
    a.all('/mcp', handler);
    const server = a.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function connect(port: number, token: string): Promise<Client> {
  const client = new Client({ name: 'forge-http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

test.before(async () => {
  page = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/next' ? '<html><title>Next</title><body>next page</body></html>' : PAGE);
  });
  await new Promise<void>((r) => page.listen(0, () => r()));
  const addr = page.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  page.close();
  await Promise.all(handlers.map((h) => h.dispose()));
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

test('HTTP MCP: a valid token drives the browser end to end', async () => {
  const { port } = await startApp('test-token-123');
  const client = await connect(port, 'test-token-123');

  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.ok(names.includes('browser_open'));
  assert.ok(names.includes('browser_history'));
  assert.ok(names.includes('browser_wait'));

  const open = await client.callTool({ name: 'browser_open', arguments: { url: base } });
  const openText = (open.content as { type: string; text: string }[])[0].text;
  assert.match(openText, /Forreyra HTTP Page/);
  assert.match(openText, /\[receipt\] open ok=true/);

  const query = await client.callTool({ name: 'browser_query', arguments: { question: 'what is the title' } });
  assert.match((query.content as { text: string }[])[0].text, /Forreyra HTTP Page/);

  await client.close();
});

test('HTTP MCP: secret-shaped page text is redacted', async () => {
  const { port } = await startApp('tok');
  const client = await connect(port, 'tok');
  await client.callTool({ name: 'browser_open', arguments: { url: base } });
  const out = await client.callTool({ name: 'browser_extract', arguments: {} });
  const text = (out.content as { text: string }[])[0].text;
  assert.ok(!text.includes('sk-abcdef0123456789'), 'raw key must not appear');
  assert.match(text, /\[REDACTED_KEY\]/);
  await client.close();
});

test('HTTP MCP: read-only refuses click, and the refusal is audited', async () => {
  const { port } = await startApp('tok');
  const client = await connect(port, 'tok');
  await client.callTool({ name: 'browser_open', arguments: { url: base } });

  const click = await client.callTool({ name: 'browser_click', arguments: { index: 0 } });
  assert.equal(click.isError, true);
  assert.match((click.content as { text: string }[])[0].text, /read-only/);

  const hist = await client.callTool({ name: 'browser_history', arguments: {} });
  const histText = (hist.content as { text: string }[])[0].text;
  assert.match(histText, /click ok=false/);
  assert.match(histText, /note=read-only/);
  await client.close();
});

test('HTTP MCP: a wrong token is rejected with 401', async () => {
  const { port } = await startApp('right-token');
  const client = new Client({ name: 'bad', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer wrong-token' } },
  });
  await assert.rejects(() => client.connect(transport));
});

test('HTTP MCP: no token configured fails closed with 503', async () => {
  const { port } = await startApp(undefined);
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(res.status, 503);
});
