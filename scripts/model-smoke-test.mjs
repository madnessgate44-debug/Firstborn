// Prove the genuinely keyless path: deliberately remove all provider credentials
// from this process so a configured Gemini/Groq/etc. key cannot make the test pass.
const credentialNames = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ZAI_API_KEY', 'COHERE_API_KEY',
  'CO_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'NIM_API_KEY',
  'KILO_API_KEY', 'FREELM_GOOGLE_KEYS', 'FREELM_GROQ_KEYS', 'FREELM_OPENROUTER_KEYS',
  'FREELM_CLOUDFLARE_KEYS', 'FREELM_ZAI_KEYS', 'FREELM_COHERE_KEYS',
  'FREELM_CEREBRAS_KEYS', 'FREELM_MISTRAL_KEYS', 'FREELM_NIM_KEYS', 'FREELM_KILO_KEYS',
];
for (const name of credentialNames) delete process.env[name];
process.env.FREELM_KEYLESS = '1';

const { FreeLLM } = await import('freelm');
const failures = [];
const events = [];
try {
  const llm = FreeLLM.fromEnv({
    keyless: true,
    maxAttempts: 12,
    timeout: 75,
    hedge: true,
    onEvent: (event) => {
      events.push(event);
      if (event.kind === 'error') {
        failures.push(`${event.provider || 'unknown provider'} / ${event.model || 'unknown model'}: ${event.error || `HTTP ${event.status ?? 'unknown'}`}`);
      }
    },
  });
  const response = await llm.chat([
    { role: 'system', content: 'Reply with exactly the requested token and no other text.' },
    { role: 'user', content: 'Reply with exactly: FIRSTBORN_KEYLESS_ROUTE_OK' },
  ], {
    model: 'chat:fast',
    temperature: 0,
    max_tokens: 64,
    signal: AbortSignal.timeout(80000),
  });
  const text = response.text.trim();
  if (!text.includes('FIRSTBORN_KEYLESS_ROUTE_OK')) {
    throw new Error(`Model returned unexpected text: ${text.slice(0, 200) || '(empty)'}`);
  }
  const provider = response.provider || 'not-reported';
  if (!/kilo|ovh|keyless|anonymous/i.test(provider)) {
    throw new Error(`Response succeeded but provider does not prove a keyless endpoint: ${provider}`);
  }
  console.log(JSON.stringify({
    status: 'PASS',
    mode: 'keyless-only (all provider credentials removed)',
    provider,
    actualModel: response.model || 'not-reported',
    responseReceived: true,
    responseValidated: true,
    priorRouteFailures: failures,
    attemptCount: events.filter((event) => event.kind === 'attempt').length,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    mode: 'keyless-only (all provider credentials removed)',
    error: error instanceof Error ? error.message : String(error),
    routeFailures: failures,
    events: events.map(({ kind, provider, model, status, error: message }) => ({ kind, provider, model, status, error: message })),
  }, null, 2));
  process.exit(1);
}
