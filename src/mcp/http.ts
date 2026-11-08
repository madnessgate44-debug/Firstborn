/**
 * Streamable HTTP transport for the Forreyra MCP server.
 *
 * ChatGPT (and any other remote MCP client) reaches the browser tool over a
 * single authenticated URL. Differences from the stdio entrypoint:
 *  - Bearer-token auth, fail-closed: if no token is configured the endpoint
 *    answers 503 rather than serving anonymously.
 *  - Read-only by default: click/type/Enter are refused unless writes are
 *    explicitly enabled.
 *  - One shared BrowserService and audit log across requests, so the page a
 *    client opened is still there for its next call.
 *
 * This is a general browser surface, not OpenHands-specific.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BrowserService } from '../services/browser.ts';
import { createForreyraServer, type AuditReceipt } from './forreyra-server.ts';

export interface McpHttpOptions {
  /** Required bearer token. Empty/undefined => the endpoint fails closed (503). */
  token?: string;
  /** Allow state-changing actions. Default false (read-only). */
  allowConsequential?: boolean;
  /** Redact credential-shaped substrings from results. Default true. */
  redact?: boolean;
}

/** An Express handler that also owns the browser it lazily launched. */
export interface McpHttpHandler extends RequestHandler {
  /** Close the shared browser. Call on shutdown so the process can exit. */
  dispose(): Promise<void>;
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build the Express handler that serves the MCP endpoint. */
export function createMcpHttpHandler(options: McpHttpOptions = {}): McpHttpHandler {
  const token = options.token;
  const allowConsequential = options.allowConsequential ?? false;
  const browser = new BrowserService();
  const history: AuditReceipt[] = [];

  const handler = async (req: Request, res: Response): Promise<void> => {
    if (!token) {
      res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP endpoint is not configured (no token set).' }, id: null });
      return;
    }
    const header = req.header('authorization') ?? '';
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!presented || !tokenMatches(presented, token)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }

    const server = createForreyraServer({ browser, history, allowConsequential, redact: options.redact });
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id. The shared browser/history carry continuity.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const wrapped = ((req: Request, res: Response, next: (err?: unknown) => void) => {
    handler(req, res).catch(next);
  }) as McpHttpHandler;
  wrapped.dispose = () => browser.close();
  return wrapped;
}
