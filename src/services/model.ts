/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';
import { FreeLLM, KEYLESS, PROVIDER_ENV, envKeys, type FreeLLMEvent } from 'freelm';

export interface ModelGenerationResult {
  text: string;
  model: string;
  provider: string;
  success: boolean;
  error?: string;
  fallbackUsed?: boolean;
  keylessRouteErrors?: string[];
  /** Which routing tier produced this answer. */
  tier?: TaskTier;
}

type ChatMessage = { role: 'system' | 'user'; content: string };

/**
 * 'free' keeps a call on the no-signup public endpoints (Kilo, OVHcloud) and
 * only escalates to configured keys if the free path cannot answer, so trivial
 * work never spends a Groq/Gemini key. 'hard' goes straight to the keyed
 * providers for speed and reliability.
 */
export type TaskTier = 'free' | 'hard';

export interface ModelGenerationOptions {
  tier?: TaskTier;
}

const KEYLESS_MODEL_CHAIN = [
  'Mistral-Small-3.2-24B-Instruct-2506', // ovh, keyless, ~1.1s
  'Meta-Llama-3_3-70B-Instruct',         // ovh, keyless, ~2.0s
  'Qwen3.8-27B',                         // ovh, keyless
  'poolside/laguna-s-2.1:free',          // kilo, keyless
];

const KEYED_MODEL_CHAIN = [
  'qwen/qwen3.8-27b',                    // groq, proven fast (~140ms in CI)
  'openai/gpt-oss-20b',                  // groq, 1000 rpd
  'openai/gpt-oss-120b',                 // groq / nim
  'gemini-3.5-flash-lite',               // gemini free, 1M ctx, non-reasoning
  'gemini-3.1-flash-lite',               // gemini free, 1M ctx
  'gemini-flash-lite-latest',            // gemini alias
  ...KEYLESS_MODEL_CHAIN,                // keyless backstop
];

interface SweepOutcome { text: string; model: string; provider: string }

/**
 * Try each model in `chain` in order on one client until one returns usable
 * text. A reasoning model can return HTTP 200 with empty content; that is
 * treated as unusable and the sweep moves on. The whole sweep is bounded by
 * `budgetMs` so a saturated free tier cannot grind for minutes.
 */
async function runSweep(
  llm: FreeLLM,
  chain: string[],
  messages: ChatMessage[],
  opts: { maxTokens: number; perCallTimeoutMs: number; budgetMs: number; errors: string[] },
): Promise<SweepOutcome | null> {
  const deadline = Date.now() + opts.budgetMs;
  for (const model of chain) {
    if (Date.now() >= deadline) {
      opts.errors.push(`model sweep budget of ${opts.budgetMs}ms exhausted on this tier`);
      break;
    }
    try {
      const response = await llm.chat(messages, {
        model,
        temperature: 0.1,
        max_tokens: opts.maxTokens,
        signal: AbortSignal.timeout(Math.min(opts.perCallTimeoutMs, Math.max(1000, deadline - Date.now()))),
      });
      const content = (response.text ?? '').trim();
      if (!content) {
        opts.errors.push(`${model} via ${response.provider || 'unknown'}: response contained no usable text`);
        continue;
      }
      return { text: content, model: response.model || model, provider: response.provider || 'free-tier router' };
    } catch (err) {
      opts.errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

const KEYLESS_CREDENTIAL_ENV_NAMES = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ZAI_API_KEY', 'COHERE_API_KEY',
  'CO_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'NIM_API_KEY',
  'KILO_API_KEY', 'FREELM_GOOGLE_KEYS', 'FREELM_GROQ_KEYS', 'FREELM_OPENROUTER_KEYS',
  'FREELM_CLOUDFLARE_KEYS', 'FREELM_ZAI_KEYS', 'FREELM_COHERE_KEYS',
  'FREELM_CEREBRAS_KEYS', 'FREELM_MISTRAL_KEYS', 'FREELM_NIM_KEYS', 'FREELM_KILO_KEYS',
];

export class ModelService {
  private readonly gemini: GoogleGenAI | null;
  private readonly geminiConfigured: boolean;

  constructor() {
    if (process.env.FIRSTBORN_KEYLESS_ONLY === 'true') {
      for (const name of KEYLESS_CREDENTIAL_ENV_NAMES) delete process.env[name];
      process.env.FREELM_KEYLESS = '1';
    }
    const key = process.env.GEMINI_API_KEY?.trim();
    this.geminiConfigured = Boolean(key && key !== 'MY_GEMINI_API_KEY');
    this.gemini = this.geminiConfigured ? new GoogleGenAI({ apiKey: key }) : null;
  }

  isConfigured(): boolean {
    // The primary public gateway is keyless; actual availability is established per request.
    return true;
  }

  getProviderInfo() {
    return {
      primaryProvider: 'freelm multi-provider free-tier router with keyless Kilo and OVHcloud fallback',
      primaryModel: 'chat',
      primaryRequiresApiKey: false,
      fallbackProvider: 'Google AI Studio / Gemini',
      fallbackModel: 'gemini-2.5-flash',
      fallbackConfigured: this.geminiConfigured && process.env.FIRSTBORN_KEYLESS_ONLY !== 'true',
      costStatus: process.env.FIRSTBORN_KEYLESS_ONLY === 'true'
        ? 'Strict keyless-only mode: provider credentials are removed and Gemini fallback is disabled.'
        : 'freelm prefers configured free-tier providers and can fall back to anonymous keyless endpoints; Gemini fallback is optional.',
    };
  }

  async generatePlanAndPatch(
    prompt: string,
    contextFiles: { path: string; content: string }[],
    options: ModelGenerationOptions = {},
  ): Promise<ModelGenerationResult> {
    // Calls that do not name a tier default to 'hard'; set FORGE_DEFAULT_TIER=free
    // to make every unspecified call try the no-signup endpoints first.
    const tier: TaskTier = options.tier ?? (process.env.FORGE_DEFAULT_TIER === 'free' ? 'free' : 'hard');
    const fileContexts = contextFiles
      .map((f) => `--- FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`)
      .join('\n\n');

    const fullPrompt = `You are Forge, the precise coding and audit agent for Firstborn.
Follow these rules:
- Inspect the supplied target-repository files; never pretend to have inspected files not supplied.
- Number requirements and give testable acceptance criteria before proposing edits.
- Make the smallest bounded changes. Do not alter unrelated files.
- Preserve syntax and scope boundaries: never insert a top-level declaration inside an interface, class, function, or other block; choose an exact anchor at the correct scope.
- Return JSON matching this schema:
{
  "summary": "Short summary",
  "requirements": [{"id":"REQ-1","description":"...","acceptanceCriteria":"...","checkCommands":["npm run lint"],"manualReviewNote":"only if no automated check applies"}],
  "changes": [
    {"path":"relative/path","action":"modify","rationale":"...","edits":[{"find":"exact unique source snippet","replace":"replacement snippet"}]}
  ],
  "suggestedChecks": ["npm run lint"]
}
STRICT OUTPUT LIMIT: return compact valid JSON only, with no markdown, well within the output budget (max_tokens=2048). For existing files, action MUST be "modify" and MUST use "edits"; never return the whole file in "content" unless explicitly asked for a full rewrite. For a new file, action MUST be "create" and use "content" instead of "edits". Prefer the smallest patch that satisfies the requirements; if the mission needs more than a bounded stage, return only the first stage and state the remaining work in summary rather than truncating the JSON. Keep each find/replace snippet minimal but exact. Every find string must occur exactly once in the supplied source file. Do not repeat unchanged source. For each requirement, list the exact checks in checkCommands that verify it, or set manualReviewNote when no automated check exists. If a safe patch cannot fit these limits, return valid JSON with an empty changes array and explain the blocker in summary. Use only paths in the supplied target repository inventory or clearly justified new paths.
Context Files:
${fileContexts}
User Task:
${prompt}
Respond only with valid JSON.`;

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a careful senior software engineer and code auditor. Return valid JSON only.' },
      { role: 'user', content: fullPrompt },
    ];

    const primaryErrors: string[] = [];

    // Tunables shared by every tier.
    const maxTokens = Number(process.env.FORGE_MAX_TOKENS ?? 2048);
    const perCallTimeoutMs = Number(process.env.FORGE_MODEL_TIMEOUT_MS ?? 20000);
    const budgetMs = Number(process.env.FORGE_MODEL_BUDGET_MS ?? 45000);
    const freeBudgetMs = Number(process.env.FORGE_FREE_BUDGET_MS ?? 15000);
    const envChain = process.env.FORGE_MODEL_CHAIN?.split(',').map((s) => s.trim()).filter(Boolean);
    const hasProviderKeys = PROVIDER_ENV.some((spec) => envKeys(spec).length > 0);
    const keylessOnly = process.env.FIRSTBORN_KEYLESS_ONLY === 'true';

    const clientOpts = {
      maxAttempts: 6,
      timeout: 30,
      hedge: false as const,
      onEvent: (event: FreeLLMEvent) => {
        if (event.kind === 'error') {
          primaryErrors.push(`${event.provider || 'unknown provider'} / ${event.model || 'unknown model'}: ${event.error || `HTTP ${event.status ?? 'unknown'}`}`);
        }
      },
    };
    // A client with ONLY the no-signup endpoints, so a free-tier call provably
    // cannot spend a Groq/Gemini key.
    const freeClient = () => new FreeLLM(KEYLESS.map((K) => new K()), clientOpts);
    const anyClient = () => FreeLLM.fromEnv({ keyless: true, ...clientOpts });

    const sweepOpts = (budget: number) => ({ maxTokens, perCallTimeoutMs, budgetMs: budget, errors: primaryErrors });

    // 1. HARD: straight to the keyed providers (and their keyless backstop) for
    //    speed/reliability. An explicit FORGE_MODEL_CHAIN overrides everything.
    if (!keylessOnly && (tier === 'hard' || envChain?.length)) {
      const chain = envChain?.length ? envChain : KEYED_MODEL_CHAIN;
      const out = await runSweep(anyClient(), chain, messages, sweepOpts(budgetMs));
      if (out) return { ...out, success: true, fallbackUsed: false, tier: 'hard', keylessRouteErrors: [...primaryErrors] };
    }

    // 2. FREE: keep trivial/easy work on the no-signup endpoints. Escalate to the
    //    keyed providers only if the free path cannot answer.
    if (!keylessOnly) {
      const freeOut = await runSweep(freeClient(), envChain?.length ? envChain : KEYLESS_MODEL_CHAIN, messages, sweepOpts(freeBudgetMs));
      if (freeOut) return { ...freeOut, success: true, fallbackUsed: false, tier: 'free', keylessRouteErrors: [...primaryErrors] };
      const hardOut = await runSweep(anyClient(), envChain?.length ? envChain : KEYED_MODEL_CHAIN, messages, sweepOpts(budgetMs));
      if (hardOut) return { ...hardOut, success: true, fallbackUsed: true, tier: 'hard', keylessRouteErrors: [...primaryErrors] };
    } else {
      // Strict keyless-only: never touch a key, by construction.
      const out = await runSweep(freeClient(), envChain?.length ? envChain : KEYLESS_MODEL_CHAIN, messages, sweepOpts(budgetMs));
      if (out) return { ...out, success: true, fallbackUsed: false, tier: 'free', keylessRouteErrors: [...primaryErrors] };
    }

    const primaryError = primaryErrors.join(' | ') || 'free-tier router returned no usable text without a reported provider error';

    if (this.gemini && !keylessOnly) {
      try {
        const response = await this.gemini.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: fullPrompt,
          config: { responseMimeType: 'application/json' },
        });
        if (!response.text) throw new Error('Gemini returned no message content.');
        return {
          text: response.text,
          model: 'gemini-2.5-flash',
          provider: 'Google AI Studio / Gemini',
          success: true,
          fallbackUsed: true,
          tier: 'hard',
          keylessRouteErrors: [...primaryErrors],
        };
      } catch (err) {
        const fallbackError = err instanceof Error ? err.message : String(err);
        return {
          text: '',
          model: 'auto:coding -> gemini-2.5-flash',
          provider: 'free-tier routes + Gemini fallback',
          success: false,
          error: `Free/keyed routes failed: ${primaryError}; Gemini fallback failed: ${fallbackError}`,
          fallbackUsed: true,
          keylessRouteErrors: [...primaryErrors],
        };
      }
    }

    return {
      text: '',
      model: 'chat:large',
      provider: 'model routes unavailable',
      success: false,
      error: `All model routes failed: ${primaryError}. ${keylessOnly ? 'Gemini fallback is disabled by FIRSTBORN_KEYLESS_ONLY=true.' : 'Gemini fallback is not configured.'}`,
      fallbackUsed: false,
      keylessRouteErrors: [...primaryErrors],
    };
  }
}
