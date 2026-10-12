const routes = [
  {
    base: (process.env.FREE_MODEL_BASE_URL || 'https://api.murakumo.cloud/v1').replace(/\\/+$/, ''),
    model: process.env.FREE_MODEL_NAME || 'murakumo-main',
    provider: 'Murakumo anonymous inference',
    authorization: '',
  },
  {
    base: 'https://api.llmfaucet.dev/v1',
    model: 'auto:coding',
    provider: 'llmfaucet anonymous gateway',
    authorization: 'Bearer free',
  },
];

const failures = [];
for (const route of routes) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (route.authorization) headers.Authorization = route.authorization;
    const response = await fetch(`${route.base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: route.model,
        messages: [
          { role: 'system', content: 'Reply with a short plain-text answer.' },
          { role: 'user', content: 'Reply with exactly: FIRSTBORN_MODEL_ROUTE_OK' },
        ],
        temperature: 0,
        max_tokens: 40,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      failures.push(`${route.provider}: HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`);
      continue;
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      failures.push(`${route.provider}: empty response content`);
      continue;
    }

    console.log(JSON.stringify({
      status: 'PASS',
      provider: route.provider,
      requestedModel: route.model,
      actualModel: data.model || 'not-reported',
      responseReceived: true,
    }, null, 2));
    process.exit(0);
  } catch (error) {
    failures.push(`${route.provider}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.error('All keyless model routes failed:', failures.join(' | '));
process.exit(1);
