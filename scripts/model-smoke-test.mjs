const routes = [
  {
    base: (process.env.FREE_MODEL_BASE_URL || 'https://api.murakumo.cloud/v1').replace(/\\/+$/, ''),
    model: process.env.FREE_MODEL_NAME || 'murakumo/free',
    provider: process.env.FREE_MODEL_BASE_URL ? 'Configured keyless OpenAI-compatible endpoint' : 'Murakumo anonymous free model',
    authorization: '',
  },
  {
    base: 'https://api.murakumo.cloud/v1',
    model: 'mishima',
    provider: 'Murakumo anonymous fallback model',
    authorization: '',
  },
  {
    base: 'https://api.llmfaucet.dev/v1',
    model: 'auto:coding',
    provider: 'llmfaucet anonymous gateway',
    authorization: 'Bearer free',
  },
];

const expected = 'FIRSTBORN_MODEL_ROUTE_OK';
const failures = [];
for (const route of routes) {
  let routePassed = false;
  for (let attempt = 0; attempt < 2 && !routePassed; attempt += 1) {
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
            { role: 'user', content: `Reply with exactly: ${expected}` },
          ],
          temperature: 0,
          max_tokens: 64,
          reasoning: { effort: 'none' },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const failure = `${route.provider}: HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`;
        failures.push(failure);
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, response.status === 429 ? 1500 : 750));
          continue;
        }
        break;
      }

      const data = await response.json();
      const rawText = data.choices?.[0]?.message?.content;
      const text = typeof rawText === 'string'
        ? rawText
        : Array.isArray(rawText)
          ? rawText.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
          : '';
      if (!text.trim().includes(expected)) {
        failures.push(`${route.provider}: response did not contain the expected probe token (actual model: ${data.model || 'not-reported'})`);
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          continue;
        }
        break;
      }

      console.log(JSON.stringify({
        status: 'PASS',
        provider: route.provider,
        requestedModel: route.model,
        actualModel: data.model || 'not-reported',
        responseReceived: true,
        outputMatched: true,
        priorRouteFailures: failures,
      }, null, 2));
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${route.provider}: ${message}`);
      if (attempt === 0 && /timeout|aborted|fetch failed/i.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      break;
    }
  }
}

console.error('All keyless model routes failed the smoke test:', failures.join(' | '));
process.exit(1);
