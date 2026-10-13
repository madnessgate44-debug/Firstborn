/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';
import { FreeLLM, PROVIDER_ENV, envKeys } from 'freelm';

export interface ModelGenerationResult {
  text: string;
  model: string;
  provider: string;
  success: boolean;
  error?: string;
  fallbackUsed?: boolean;
  keylessRouteErrors?: string[];
}

type ChatMessage = { role: 'system' | 'user'; content: string };

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

  async generatePlanAndPatch(prompt: string, contextFiles: { path: string; content: string }[]): Promise<ModelGenerationResult> {
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
    let invokedProvider = 'freelm free-tier router';
    let invokedModel = 'chat';

    try {
      const llm = FreeLLM.fromEnv({
        // Always include the no-signup Kilo/OVHcloud routes as last resorts.
        keyless: true,
        maxAttempts: 6,
        timeout: 30,
        hedge: false,
        onEvent: (event) => {
          if (event.kind === 'error') {
            primaryErrors.push(`${event.provider || 'unknown provider'} / ${event.model || 'unknown model'}: ${event.error || `HTTP ${event.status ?? 'unknown'}`}`);
          }
          if (event.kind === 'success') {
            invokedProvider = event.provider || invokedProvider;
            invokedModel = event.model || invokedModel;
          }
        },
      });

      // Prefer concrete, long-output-capable NON-reasoning models. Measured on the
      // free routes: the 120B "reasoning" models spend the whole token budget on
      // hidden reasoning and return empty content (the "no usable text" failure),
      // while these answer with clean, bounded output. `model` accepts an ordered
      // fallback list; freelm picks the first routable one and benches it on 429.
      const envChain = process.env.FORGE_MODEL_CHAIN?.split(',').map((s) => s.trim()).filter(Boolean);
      // Provider-diverse chain so ONE exhausted key/model cannot stall a mission.
      // Quotas are per-model (Groq: 30 rpm / 1000 rpd; Gemini free: ~20 rpd/model,
      // 1M ctx), so listing several models per provider multiplies usable calls,
      // and comma-joined keys (GROQ_API_KEY="k1,k2") multiply it again. freelm routes
      // each id to a provider that knows it and benches only that model on a 429.
      const hasProviderKeys = PROVIDER_ENV.some((spec) => envKeys(spec).length > 0);
      const keyedChain = [
        'qwen/qwen3.8-27b',                // groq, proven fast (~140ms in CI)
        'openai/gpt-oss-20b',              // groq, 1000 rpd; reasoning, needs the full token budget
        'openai/gpt-oss-120b',             // groq / nim
        'gemini-3.5-flash-lite',           // gemini free, 1M ctx, non-reasoning
        'gemini-3.1-flash-lite',           // gemini free, 1M ctx
        'gemini-flash-lite-latest',        // gemini alias
        'Mistral-Small-3.2-24B-Instruct-2506', // keyless ovh, ~1.1s
        'Meta-Llama-3_3-70B-Instruct',     // keyless ovh, ~2.0s
        'poolside/laguna-s-2.1:free',      // keyless kilo
      ];
      // No keys: the keyed ids 404, so lead with the models that actually answer.
      const keylessChain = [
        'Mistral-Small-3.2-24B-Instruct-2506', // ovh, keyless, ~1.1s
        'Meta-Llama-3_3-70B-Instruct',     // ovh, keyless, ~2.0s
        'Qwen3.8-27B',                     // ovh, keyless
        'poolside/laguna-s-2.1:free',      // kilo, keyless
      ];
      const preferredModels: string[] = envChain && envChain.length > 0
        ? envChain
        : (hasProviderKeys ? keyedChain : keylessChain);
      const modelChain = preferredModels; // tried one by one so an empty/thinking answer moves on
      const maxTokens = Number(process.env.FORGE_MAX_TOKENS ?? 2048);
      const perCallTimeoutMs = Number(process.env.FORGE_MODEL_TIMEOUT_MS ?? 20000);
      // Hard wall-clock budget for the whole fallback sweep. Without it, a saturated
      // keyless tier can grind for minutes across every model and pass before failing.
      const budgetMs = Number(process.env.FORGE_MODEL_BUDGET_MS ?? 45000);
      const sweepDeadline = Date.now() + budgetMs;
      try {
        for (const model of modelChain) {
          if (Date.now() >= sweepDeadline) {
            primaryErrors.push(`model sweep budget of ${budgetMs}ms exhausted; not waiting further on the keyless tier`);
            break;
          }
          try {
            const response = await llm.chat(messages, {
              model,
              temperature: 0.1,
              max_tokens: maxTokens,
              signal: AbortSignal.timeout(Math.min(perCallTimeoutMs, Math.max(1000, sweepDeadline - Date.now()))),
            });
            const content = (response.text ?? '').trim();
            if (!content) {
              // Reasoning-only models return HTTP 200 with empty content; treat that
              // as unusable and move to the next model instead of aborting.
              primaryErrors.push(`${model} via ${response.provider || 'unknown'}: response contained no usable text`);
              continue;
            }
            return {
              text: content,
              model: response.model || model,
              provider: response.provider || invokedProvider,
              success: true,
              fallbackUsed: false,
              keylessRouteErrors: [...primaryErrors],
            };
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            primaryErrors.push(`${model}: ${errorMessage}`);
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        primaryErrors.push(`freelm initialization failed: ${errorMessage}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      primaryErrors.push(`freelm initialization failed: ${errorMessage}`);
    }

    const primaryError = primaryErrors.join(' | ') || 'freelm returned no usable text without a reported provider error';

    if (this.gemini && process.env.FIRSTBORN_KEYLESS_ONLY !== 'true') {
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
          keylessRouteErrors: [...primaryErrors],
        };
      } catch (err) {
        const fallbackError = err instanceof Error ? err.message : String(err);
        return {
          text: '',
          model: 'auto:coding -> gemini-2.5-flash',
          provider: 'keyless model routes + Gemini fallback',
          success: false,
          error: `Primary keyless route failed: ${primaryError}; Gemini fallback failed: ${fallbackError}`,
          fallbackUsed: true,
          keylessRouteErrors: [...primaryErrors],
        };
      }
    }

    return {
      text: '',
      model: 'chat:large',
      provider: 'keyless model routes unavailable',
      success: false,
      error: `All keyless primary routes failed: ${primaryError}. ${process.env.FIRSTBORN_KEYLESS_ONLY === 'true' ? 'Gemini fallback is disabled by FIRSTBORN_KEYLESS_ONLY=true.' : 'Gemini fallback is not configured.'}`,
      fallbackUsed: false,
      keylessRouteErrors: [...primaryErrors],
    };
  }
}
