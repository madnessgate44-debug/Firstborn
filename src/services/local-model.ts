import http from 'node:http';

/**
 * Optional local OpenAI-compatible model route (e.g. llama.cpp's llama-server).
 *
 * When FORGE_LOCAL_MODEL_URL is set, Forge uses ONLY this route: no freelm providers,
 * no keyless endpoints, no Gemini. The URL must be loopback (http://127.0.0.1:PORT),
 * so prompts never leave the machine and no credential is involved.
 */
export interface LocalChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface LocalModelResult { text: string; model: string; provider: string; success: boolean; error?: string }

export function localModelUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.FORGE_LOCAL_MODEL_URL || '').trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('FORGE_LOCAL_MODEL_URL is not a valid URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('FORGE_LOCAL_MODEL_URL must be http://127.0.0.1:PORT (loopback only, no credentials)');
  }
  return `${url.origin}/v1/chat/completions`;
}

function postLoopbackJson(endpoint: string, payload: string, timeoutMs: number): Promise<string> {
  const parsed = new URL(endpoint);
  return new Promise<string>((resolve, reject) => {
    const controller = new AbortController();
    let req!: http.ClientRequest;

    const timer = setTimeout(() => {
      const timeoutErr = new Error(`local model timed out after ${timeoutMs}ms`);
      controller.abort(timeoutErr);
      req.destroy(timeoutErr);
    }, timeoutMs);

    const cleanup = () => clearTimeout(timer);

    req = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload, 'utf8'),
        },
        signal: controller.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          cleanup();
          reject(new Error(`local model HTTP ${status} (redirect refused)`));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          cleanup();
          reject(new Error(`local model HTTP ${status}`));
          return;
        }
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          cleanup();
          resolve(body);
        });
        res.on('error', (err) => {
          cleanup();
          reject(err);
        });
      },
    );

    req.on('error', (err) => {
      cleanup();
      reject(controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : err);
    });

    req.write(payload);
    req.end();
  });
}

export async function callLocalModel(
  messages: LocalChatMessage[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalModelResult> {
  const endpoint = localModelUrl(env);
  if (!endpoint) throw new Error('local model route is not configured');
  const model = (env.FORGE_LOCAL_MODEL_NAME || 'local-model').trim();
  const timeoutMs = Math.min(Math.max(Number(env.FORGE_LOCAL_MODEL_TIMEOUT_S || 900), 30), 1800) * 1000;
  const maxTokens = Math.min(Math.max(Number(env.FORGE_LOCAL_MODEL_MAX_TOKENS || 4096), 256), 8192);
  try {
    const requestBody = JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    });
    let rawText: string;
    if (fetchImpl === fetch) {
      rawText = await postLoopbackJson(endpoint, requestBody, timeoutMs);
    } else {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`local model HTTP ${response.status}`);
      rawText = await response.text();
    }
    const data = JSON.parse(rawText) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new Error('local model returned no content');
    return { text, model, provider: 'local OpenAI-compatible (loopback)', success: true };
  } catch (err) {
    return { text: '', model, provider: 'local OpenAI-compatible (loopback)', success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
