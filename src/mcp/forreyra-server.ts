/**
 * Forreyra MCP server.
 *
 * Exposes the Forreyra browser over the Model Context Protocol, so any MCP
 * client (Claude Desktop, Cursor, VS Code, the OpenHands agent, and — over the
 * Streamable HTTP transport — a remote controller such as ChatGPT) can drive a
 * real Chromium session with the same look-then-act model as the CLI and the
 * agent tools.
 *
 * Two transports, one tool set:
 *  - stdio  (this file's `main`): the client spawns this process. Local/trusted.
 *  - HTTP   (`createForreyraServer` + `src/mcp/http.ts`): mounted on the Express
 *    server for remote clients. Read-only by default; writes are opt-in.
 *
 * Every result is redacted and carries a one-line receipt; the full redacted
 * action history is available through `browser_history`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserService, isConsequential, type BrowserActionKind } from '../services/browser.ts';
import { renderSnapshot } from '../agent/tools.ts';
import { renderQueryResult } from '../services/query.ts';
import { redactSecrets } from '../services/redact.ts';

export interface ForreyraOptions {
  /** Allow actions that can change external state (click/type/Enter). Default false. */
  allowConsequential?: boolean;
  /** Redact credential-shaped substrings from results. Default true. */
  redact?: boolean;
  /** Max retained audit receipts. Default 100. */
  historyLimit?: number;
  /**
   * Share a browser across server instances. The HTTP endpoint builds one
   * server per request but must keep the same browser and audit log, so the
   * page opened by one call is still there for the next.
   */
  browser?: BrowserService;
  history?: AuditReceipt[];
}

export interface AuditReceipt {
  at: string;
  action: BrowserActionKind;
  detail: string;
  ok: boolean;
  url?: string;
  note?: string;
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * Build the Forreyra MCP server with the full browser tool set. Reused by both
 * the stdio entrypoint and the HTTP endpoint so the tools cannot drift.
 */
export function createForreyraServer(options: ForreyraOptions = {}): McpServer {
  const allowConsequential = options.allowConsequential ?? false;
  const redact = options.redact ?? true;
  const historyLimit = options.historyLimit ?? 100;

  const browser = options.browser ?? new BrowserService();
  const history: AuditReceipt[] = options.history ?? [];

  const clean = (text: string): string => (redact ? redactSecrets(text) : text);

  const record = (receipt: AuditReceipt): void => {
    history.push(receipt);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
  };

  const ok = (text: string, receipt: AuditReceipt): Result => {
    record(receipt);
    const line = `[receipt] ${receipt.action} ok=${receipt.ok} ${receipt.detail}${receipt.url ? ` url=${receipt.url}` : ''}`;
    return { content: [{ type: 'text', text: `${line}\n${clean(text)}` }] };
  };

  const fail = (err: unknown, receipt: AuditReceipt): Result => {
    record({ ...receipt, ok: false, note: err instanceof Error ? err.message : String(err) });
    return {
      content: [{ type: 'text', text: `Forreyra error: ${clean(err instanceof Error ? err.message : String(err))}` }],
      isError: true,
    };
  };

  /** Refuse a consequential action when the surface is read-only. */
  const gate = (kind: BrowserActionKind, detail: string, key?: string): Result | undefined => {
    if (!isConsequential(kind, key) || allowConsequential) return undefined;
    const receipt: AuditReceipt = { at: new Date().toISOString(), action: kind, detail, ok: false, note: 'read-only' };
    record(receipt);
    return {
      content: [
        {
          type: 'text',
          text: `Forreyra is read-only: "${kind}" can change external state and is blocked. Re-run the server with writes enabled (FORGE_BROWSER_ALLOW_WRITES=1) to allow it.`,
        },
      ],
      isError: true,
    };
  };

  const server = new McpServer({ name: 'forreyra', version: '1.1.0' });

  server.registerTool(
    'browser_open',
    {
      title: 'Open a URL',
      description:
        'Open a URL in a real browser and return the page title, its interactive elements (numbered [i]) and visible text. Use the [i] index with browser_click / browser_type.',
      inputSchema: { url: z.string().describe('The URL to open, e.g. https://example.com') },
    },
    async ({ url }): Promise<Result> => {
      try {
        const snap = await browser.open(url);
        return ok(renderSnapshot(snap), { at: new Date().toISOString(), action: 'open', detail: url, ok: true, url: snap.url });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'open', detail: url, ok: false });
      }
    }
  );

  server.registerTool(
    'browser_view',
    {
      title: 'View the current page',
      description: 'Re-read the current page: url, title, interactive elements (with [i] indices) and visible text.',
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const snap = await browser.view();
        return ok(renderSnapshot(snap), { at: new Date().toISOString(), action: 'view', detail: snap.title, ok: true, url: snap.url });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'view', detail: '', ok: false });
      }
    }
  );

  server.registerTool(
    'browser_click',
    {
      title: 'Click an element',
      description: 'Click the interactive element at an index from the latest view.',
      inputSchema: { index: z.number().int().nonnegative().describe('Element index [i] from the latest view') },
    },
    async ({ index }): Promise<Result> => {
      const blocked = gate('click', `index=${index}`);
      if (blocked) return blocked;
      try {
        const snap = await browser.click(index);
        return ok(renderSnapshot(snap), { at: new Date().toISOString(), action: 'click', detail: `index=${index}`, ok: true, url: snap.url });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'click', detail: `index=${index}`, ok: false });
      }
    }
  );

  server.registerTool(
    'browser_type',
    {
      title: 'Type into an element',
      description: 'Type text into the element at an index from the latest view.',
      inputSchema: {
        index: z.number().int().nonnegative().describe('Element index [i] from the latest view'),
        text: z.string().describe('The text to type'),
      },
    },
    async ({ index, text }): Promise<Result> => {
      const blocked = gate('type', `index=${index} len=${text.length}`);
      if (blocked) return blocked;
      try {
        const snap = await browser.type(index, text);
        return ok(renderSnapshot(snap), { at: new Date().toISOString(), action: 'type', detail: `index=${index} len=${text.length}`, ok: true, url: snap.url });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'type', detail: `index=${index}`, ok: false });
      }
    }
  );

  server.registerTool(
    'browser_press',
    {
      title: 'Press a key',
      description: 'Press a keyboard key on the focused element, e.g. Enter.',
      inputSchema: { key: z.string().default('Enter').describe('Key name, e.g. Enter, Tab, Escape') },
    },
    async ({ key }): Promise<Result> => {
      const name = key || 'Enter';
      const blocked = gate('press', `key=${name}`, name);
      if (blocked) return blocked;
      try {
        const snap = await browser.press(name);
        return ok(renderSnapshot(snap), { at: new Date().toISOString(), action: 'press', detail: `key=${name}`, ok: true, url: snap.url });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'press', detail: `key=${name}`, ok: false });
      }
    }
  );

  server.registerTool(
    'browser_scroll',
    {
      title: 'Scroll the page',
      description: 'Scroll the page by one screen.',
      inputSchema: { direction: z.enum(['up', 'down']).default('down').describe('Scroll direction') },
    },
    async ({ direction }): Promise<Result> => {
      try {
        const snap = await browser.scroll(direction === 'up' ? 'up' : 'down');
        return ok(renderSnapshot(snap), { at: new Date().toISOString(), action: 'scroll', detail: direction, ok: true, url: snap.url });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'scroll', detail: direction, ok: false });
      }
    }
  );

  server.registerTool(
    'browser_extract',
    {
      title: 'Extract page text',
      description: 'Return the visible text of the current page, optionally only sentences matching a regular expression.',
      inputSchema: { pattern: z.string().optional().describe('Optional regex; only matching sentences are returned') },
    },
    async ({ pattern }): Promise<Result> => {
      try {
        return ok(await browser.extract(pattern || undefined), { at: new Date().toISOString(), action: 'extract', detail: pattern || '', ok: true });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'extract', detail: pattern || '', ok: false });
      }
    }
  );

  server.registerTool(
    'browser_query',
    {
      title: 'Query the page in plain English',
      description:
        'Answer a plain-English question about the current page with structured data, without a regex. Handles titles, headings, links, emails, phone numbers, prices, table rows, counts, and labelled values. Examples: "what is the title", "list the links about docs", "how many rows are in the table", "what is the price".',
      inputSchema: { question: z.string().describe('The plain-English question, e.g. "what is the price"') },
    },
    async ({ question }): Promise<Result> => {
      try {
        return ok(renderQueryResult(await browser.query(question)), { at: new Date().toISOString(), action: 'query', detail: question, ok: true });
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'query', detail: question, ok: false });
      }
    }
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot the page',
      description: 'Capture a PNG screenshot of the current viewport and return it as an image.',
      inputSchema: {},
    },
    async () => {
      try {
        const png = await browser.capture();
        record({ at: new Date().toISOString(), action: 'screenshot', detail: `${png.length} bytes`, ok: true });
        return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] };
      } catch (err) {
        return fail(err, { at: new Date().toISOString(), action: 'screenshot', detail: '', ok: false });
      }
    }
  );

  server.registerTool(
    'browser_history',
    {
      title: 'Browser action history',
      description:
        'Return the redacted, append-only audit receipt log of every browser action this session (what was attempted, whether it changed state, and any failure).',
      inputSchema: {},
    },
    async (): Promise<Result> => {
      const body = history.length
        ? history.map((r) => `${r.at} ${r.action} ok=${r.ok} ${r.detail}${r.note ? ` note=${r.note}` : ''}${r.url ? ` url=${r.url}` : ''}`).join('\n')
        : 'No browser actions recorded yet.';
      return { content: [{ type: 'text', text: clean(body) }] };
    }
  );

  server.registerTool(
    'browser_close',
    {
      title: 'Close the browser',
      description: 'Close the browser session and free its resources.',
      inputSchema: {},
    },
    async (): Promise<Result> => {
      await browser.close();
      return ok('Browser closed.', { at: new Date().toISOString(), action: 'close', detail: '', ok: true });
    }
  );

  return server;
}

async function main(): Promise<void> {
  // stdio is spawned by a local, trusted client, so writes are allowed by
  // default to preserve existing behaviour; FORGE_BROWSER_READONLY=1 opts out.
  const readOnly = process.env.FORGE_BROWSER_READONLY === '1';
  const server = createForreyraServer({ allowConsequential: !readOnly });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun = Boolean(process.argv[1]) && /forreyra-server\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`Forreyra MCP failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
