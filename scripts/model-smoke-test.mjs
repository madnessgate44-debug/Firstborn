const base = (process.env.FREE_MODEL_BASE_URL || 'https://api.llmfaucet.dev/v1').replace(/\/+$/, '');
const model = process.env.FREE_MODEL_NAME || 'auto:coding';

const response = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer free',
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'Reply with a short plain-text answer.' },
      { role: 'user', content: 'Reply with exactly: FIRSTBORN_MODEL_ROUTE_OK' },
    ],
    temperature: 0,
    max_tokens: 40,
  }),
  signal: AbortSignal.timeout(45000),
});

if (!response.ok) {
  const detail = (await response.text()).slice(0, 500);
  console.error(`Keyless model route failed: HTTP ${response.status}: ${detail}`);
  process.exit(1);
}

const data = await response.json();
const text = data.choices?.[0]?.message?.content;
if (typeof text !== 'string' || !text.trim()) {
  console.error('Keyless model route returned no message content.');
  process.exit(1);
}

console.log(JSON.stringify({
  status: 'PASS',
  provider: 'llmfaucet anonymous gateway',
  requestedModel: model,
  actualModel: data.model || 'not-reported',
  responseReceived: true,
  routedVia: response.headers.get('x-routed-via') || 'not-reported',
}, null, 2));
