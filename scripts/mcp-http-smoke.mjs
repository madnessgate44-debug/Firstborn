/**
 * Remote Forreyra MCP smoke test — the ChatGPT-connector path.
 *
 * Talks to the Streamable HTTP MCP endpoint with the official MCP client SDK,
 * exactly as a remote controller (ChatGPT, Claude, Cursor) does, and drives a
 * real page. Use it to prove a deployment works before registering it.
 *
 *   FORGE_MCP_TOKEN=… node scripts/mcp-http-smoke.mjs https://host/mcp https://example.com
 *
 * Evidence printed: server name, tool count, and the page title read back. No
 * secret is ever printed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || process.env.FORGE_MCP_URL;
const page = process.argv[3] || 'https://example.com';
const token = process.env.FORGE_MCP_TOKEN;

if (!url) {
  console.error('usage: FORGE_MCP_TOKEN=… node scripts/mcp-http-smoke.mjs <mcp-url> [page-url]');
  process.exit(2);
}
if (!token) {
  console.error('FORGE_MCP_TOKEN is required (the endpoint fails closed without it).');
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'forge-http-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log('connected:', client.getServerVersion()?.name, 'over', url);

  const { tools } = await client.listTools();
  console.log('tools:', tools.length, '-', tools.map((t) => t.name).sort().join(', '));

  // Step 1: open the page.
  const res = await client.callTool({ name: 'browser_open', arguments: { url: page } });
  if (res.isError) throw new Error('browser_open returned an error');
  const text = res.content[0]?.text ?? '';
  const title = /title: (.*)/.exec(text)?.[1] ?? '(no title)';
  console.log('step 1 - page title:', title);

  // Step 2: wait for the page to settle, then read it back (follow-up driven by
  // the first result). This is a real two-step loop, not a one-shot screenshot.
  const waited = await client.callTool({ name: 'browser_wait', arguments: { timeoutMs: 8000 } });
  if (waited.isError) throw new Error('browser_wait returned an error');
  const waitedTitle = /title: (.*)/.exec(waited.content[0]?.text ?? '')?.[1] ?? '(no title)';
  console.log('step 2 - after wait, title:', waitedTitle);
  if (waitedTitle !== title) throw new Error(`title changed across the wait: ${title} -> ${waitedTitle}`);

  const hist = await client.callTool({ name: 'browser_history', arguments: {} });
  const lines = (hist.content[0]?.text ?? '').trim().split('\n').length;
  console.log('audit receipts:', lines);

  console.log('HTTP MCP ROUND TRIP OK');
  await client.callTool({ name: 'browser_close', arguments: {} });
} catch (err) {
  console.error('HTTP MCP smoke FAILED:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
