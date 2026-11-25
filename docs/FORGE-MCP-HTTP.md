# Forreyra over Streamable HTTP — ChatGPT connector

Forreyra is Forge's real-browser tool. This document is the interface contract for a
**remote** MCP client (ChatGPT, Claude, Cursor, …). The same tool set is also served over
stdio for local clients (`npm run forreyra:mcp`).

## Endpoint

```
POST <server>/mcp      # JSON-RPC over Streamable HTTP (also accepts GET for SSE, DELETE to end)
```

The Express server mounts it from `src/mcp/http.ts` (`createMcpHttpHandler`). It is a
**general browser surface**, not OpenHands-specific.

## Authentication

- Required: `Authorization: Bearer <token>`.
- The token is read from the server environment `FORGE_MCP_TOKEN` (a secret). It is never
  sent to the browser, logged, or included in any tool result.
- **Fail-closed:** if `FORGE_MCP_TOKEN` is unset the endpoint answers `503`. A wrong or
  missing token answers `401`. Comparison is constant-time.

## Safety defaults

- **Read-only by default.** `browser_click`, `browser_type`, and `browser_press` with
  `Enter` can change external state and are refused unless the server sets
  `FORGE_BROWSER_ALLOW_WRITES=1`. A refused action is still recorded in the audit log.
- **Redaction.** Results (page text, extract, query) are scanned for credential shapes
  (`sk-…`, GitHub tokens, `AIza…`, JWTs, `Bearer …`, `key=value` pairs) and replaced with
  stable placeholders before they leave the tool (`src/services/redact.ts`).
- **Audit receipts.** Every result is prefixed with `[receipt] <action> ok=<bool> …`, and
  the append-only log is available through the `browser_history` tool.

## Tools

`browser_open`, `browser_view`, `browser_click`, `browser_type`, `browser_press`,
`browser_scroll`, `browser_extract`, `browser_query`, `browser_screenshot`,
`browser_history`, `browser_close`.

Elements are index-addressed against the most recent `browser_view` / `browser_open`
result: read the page, then act on `[i]`.

## Example call (raw JSON-RPC)

```bash
curl -sS -X POST "$URL/mcp" \
  -H "Authorization: Bearer $FORGE_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"browser_open","arguments":{"url":"https://example.com"}}}'
```

## Wiring it into ChatGPT

ChatGPT cannot reach a private/loopback address. The endpoint must be reachable at a
**public HTTPS URL**, then registered as a custom connector:

1. Deploy the server so `https://<host>/mcp` is reachable (set `FORGE_MCP_TOKEN`).
2. ChatGPT → Settings → **Connectors** → **Advanced / Developer mode** → **Add** a custom
   connector with the MCP server URL `https://<host>/mcp` and the bearer token.
3. In a chat, enable the connector; ChatGPT's tool list will include the `browser_*` tools.

Steps 2–3 are ChatGPT-side actions performed by the Owner; Forge supplies the URL and token
model. The endpoint existing is **not** proof that ChatGPT can call it — that requires the
connector registration and a live invocation.
