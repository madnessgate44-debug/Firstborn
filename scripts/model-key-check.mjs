// Report which model providers are configured and prove each one answers.
// Never prints a key. Comma-join several keys in one env var to rotate them,
// e.g. GROQ_API_KEY="key1,key2" — freelm splits on commas.
import { FreeLLM, PROVIDER_ENV, envKeys } from 'freelm';

const keylessOnly = process.env.FIRSTBORN_KEYLESS_ONLY === 'true';

console.log('Configured providers (keys are never printed):');
let keyed = 0;
for (const spec of PROVIDER_ENV) {
  const count = keylessOnly ? 0 : envKeys(spec).length;
  if (count > 0) {
    keyed += count;
    console.log(`  ${spec.cls.providerName.padEnd(12)} ${count} key(s) via ${spec.keyVars.join(' / ')}`);
  }
}
if (keyed === 0) {
  console.log('  (none) — running keyless-only (Kilo + OVHcloud, low rate limits)');
}
console.log(`\nTotal configured keys: ${keyed}${keylessOnly ? ' (FIRSTBORN_KEYLESS_ONLY=true forces keyless)' : ''}\n`);

const llm = FreeLLM.fromEnv({ keyless: true, maxAttempts: 6, timeout: 25, hedge: false });

// One minimal call per concrete model in the chain production would use, so an
// exhausted key or model is visible per model rather than as one opaque failure.
const hasProviderKeys = PROVIDER_ENV.some((spec) => envKeys(spec).length > 0);
const keyedChain = [
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'Mistral-Small-3.2-24B-Instruct-2506',
];
const keylessChain = [
  'Mistral-Small-3.2-24B-Instruct-2506',
  'Meta-Llama-3_3-70B-Instruct',
  'Qwen3.8-27B',
];
const chain = (process.env.FORGE_MODEL_CHAIN?.split(',').map((s) => s.trim()).filter(Boolean))
  ?? (hasProviderKeys ? keyedChain : keylessChain);
console.log(`Chain probed (${hasProviderKeys && !keylessOnly ? 'keyed' : 'keyless'}):\n`);

let ok = 0;
for (const model of chain) {
  const t0 = Date.now();
  try {
    const r = await llm.chat(
      [{ role: 'user', content: 'Reply with the single word OK.' }],
      { model, max_tokens: 1024, signal: AbortSignal.timeout(25000) }
    );
    const text = (r.text ?? '').trim();
    const ms = Date.now() - t0;
    if (text) {
      ok += 1;
      console.log(`PASS  ${model.padEnd(40)} ${String(ms).padStart(6)}ms  via ${r.provider} (${r.model})`);
    } else {
      console.log(`EMPTY ${model.padEnd(40)} ${String(ms).padStart(6)}ms  via ${r.provider} — thinking-only, no answer`);
    }
  } catch (err) {
    console.log(`FAIL  ${model.padEnd(40)} ${String(Date.now() - t0).padStart(6)}ms  ${(err.message || String(err)).slice(0, 90)}`);
  }
}

console.log(`\n${ok}/${chain.length} models answered.`);
process.exit(ok > 0 ? 0 : 1);
