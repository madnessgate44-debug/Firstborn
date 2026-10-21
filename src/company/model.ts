/**
 * Model access for the company.
 *
 * This deliberately mirrors Forge's `src/services/model.ts` so the company uses
 * the *same keys*: the same keyless-first `freelm` router, the same provider
 * environment variables (GROQ_API_KEY, OPENROUTER_API_KEY, KILO_API_KEY, ...),
 * and the same optional `GEMINI_API_KEY` fallback — gated by the same
 * `FIRSTBORN_KEYLESS_ONLY` lock. Nothing here invents a new credential name.
 */
import { GoogleGenAI } from '@google/genai';
import { FreeLLM } from 'freelm';

export interface ModelResult {
  text: string;
  model: string;
  provider: string;
  success: boolean;
  error?: string;
  fallbackUsed?: boolean;
  routeErrors?: string[];
}

export type ChatMessage = { role: 'system' | 'user'; content: string };

/** Provider credentials freelm reads, in the same set Forge clears in keyless-only mode. */
export const CREDENTIAL_ENV_NAMES = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ZAI_API_KEY', 'COHERE_API_KEY',
  'CO_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'NIM_API_KEY',
  'KILO_API_KEY', 'FREELM_GOOGLE_KEYS', 'FREELM_GROQ_KEYS', 'FREELM_OPENROUTER_KEYS',
  'FREELM_CLOUDFLARE_KEYS', 'FREELM_ZAI_KEYS', 'FREELM_COHERE_KEYS',
  'FREELM_CEREBRAS_KEYS', 'FREELM_MISTRAL_KEYS', 'FREELM_NIM_KEYS', 'FREELM_KILO_KEYS',
];

export function isKeylessOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FIRSTBORN_KEYLESS_ONLY ?? '').trim().toLowerCase() === 'true';
}

/**
 * Work tier. `easy` work — planning, prose, reviews — needs no provider key and
 * should ride the free keyless routes. `hard` work (writing code, real checks)
 * may use configured keys first and fall back to keyless.
 */
export type TaskTier = 'easy' | 'hard';

const EASY_ALIASES = ['chat:fast', 'chat:small', 'chat', 'chat:large', 'chat:best'];
const HARD_ALIASES = ['chat:large', 'chat', 'chat:fast', 'chat:small', 'chat:best'];

/** The alias attempt order for a tier: cheap-first for easy, strong-first for hard. */
export function routeAliasesFor(tier: TaskTier): string[] {
  return tier === 'easy' ? [...EASY_ALIASES] : [...HARD_ALIASES];
}

/**
 * Large, long-context keyless models the company audit spreads its lenses across.
 * Ordered by preference. Free model ids churn, so each lens receives the whole
 * list as a failover chain and only the model that actually answers is recorded.
 */
export const AUDIT_LARGE_MODELS = [
  'nvidia/nemotron-3.5-super-vl:free',      // Kilo, 1M ctx
  'Meta-Llama-3_3-70B-Instruct',            // OVHcloud, 131k ctx
  'Qwen3.5-397B-A17B',                      // OVHcloud, 262k ctx
  'gpt-oss-120b',                           // OVHcloud, 131k ctx
  'nvidia/nemotron-3-super-120b-a12b:free', // Kilo, 262k ctx
];

/**
 * The ordered failover chain for one audit lens. Rotating the start point by
 * lens index spreads the panel over distinct providers, so one provider's rate
 * limit cannot silence the whole audit and the lenses do not all collapse onto
 * a single model. An explicit list overrides the built-in one.
 */
export function auditModelChain(lensIndex: number, models: string[] = AUDIT_LARGE_MODELS): string[] {
  if (!models.length) return [];
  const start = ((lensIndex % models.length) + models.length) % models.length;
  return [...models.slice(start), ...models.slice(0, start)];
}

export interface ModelServiceOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Per-call routing knobs: the work tier, and an optional explicit model list. */
export interface CompleteOptions {
  tier?: TaskTier;
  models?: string[];
}

export class ModelService {
  private readonly gemini: GoogleGenAI | null;
  private readonly geminiConfigured: boolean;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ModelServiceOptions = {}) {
    const env = options.env ?? process.env;
    this.env = env;
    if (isKeylessOnly(env)) {
      for (const name of CREDENTIAL_ENV_NAMES) delete env[name];
      env.FREELM_KEYLESS = '1';
    }
    const key = env.GEMINI_API_KEY?.trim();
    this.geminiConfigured = Boolean(key && key !== 'MY_GEMINI_API_KEY');
    this.gemini = this.geminiConfigured ? new GoogleGenAI({ apiKey: key }) : null;
  }

  /** The primary gateway is keyless; real availability is established per request. */
  isConfigured(): boolean {
    return true;
  }

  getProviderInfo() {
    return {
      primaryProvider: 'freelm multi-provider free-tier router with keyless Kilo and OVHcloud fallback',
      primaryRequiresApiKey: false,
      fallbackProvider: 'Google AI Studio / Gemini',
      fallbackModel: 'gemini-2.5-flash',
      fallbackConfigured: this.geminiConfigured && !isKeylessOnly(this.env),
      costStatus: isKeylessOnly(this.env)
        ? 'Strict keyless-only mode: provider credentials are removed and Gemini fallback is disabled.'
        : 'freelm prefers configured free-tier providers and can fall back to anonymous keyless endpoints; Gemini fallback is optional.',
    };
  }

  /**
   * Route a prompt exactly as Forge does: discover the finest free route, try the
   * strongest alias first, degrade on failure, then fall back to Gemini only when
   * a key is present and keyless-only is off. Anonymous keyless endpoints are used
   * only when no provider key is configured, so the audit does not silently degrade
   * to the weakest model when real keys are available.
   */
  async complete(messages: ChatMessage[], fullPrompt: string, opts: CompleteOptions = {}): Promise<ModelResult> {
    const tier: TaskTier = opts.tier ?? 'hard';
    const models = opts.models;
    const routeErrors: string[] = [];
    let invokedProvider = 'freelm free-tier router';
    let invokedModel = models?.[0] ?? 'chat';
    const timeoutMs = options_timeout(this.env, 40000);
    // Easy work should not spend a provider key: it is routed keyless even when
    // keys are configured. Hard work prefers configured keys and falls back to
    // keyless endpoints.
    const hasProviderKeys = tier === 'hard' && CREDENTIAL_ENV_NAMES.some((n) => (this.env[n] ?? '').trim());

    try {
      const llm = FreeLLM.fromEnv({
        keyless: hasProviderKeys ? 'auto' : true,
        maxAttempts: 12,
        timeout: 35,
        hedge: true,
        wait: true,
        maxWait: 15,
        onEvent: (event) => {
          if (event.kind === 'error') {
            routeErrors.push(`${event.provider || 'unknown provider'} / ${event.model || 'unknown model'}: ${event.error || `HTTP ${event.status ?? 'unknown'}`}`);
          }
          if (event.kind === 'success') {
            invokedProvider = event.provider || invokedProvider;
            invokedModel = event.model || invokedModel;
          }
        },
      });

      const deadline = Date.now() + 90000;
      for (let round = 0; round < 3; round += 1) {
        if (round > 0) {
          const waitMs = round === 1 ? 5000 : 15000;
          if (Date.now() + waitMs > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        let availabilityFailure = false;
        // Prefer an explicit model list (used to pin a distinct large model per
        // audit lens); otherwise ride the alias chain for the tier.
        const routeOrder = models?.length ? models : routeAliasesFor(tier);
        for (const alias of routeOrder) {
          if (Date.now() > deadline) break;
          try {
            const response = await llm.chat(messages, {
              model: alias,
              temperature: 0.1,
              max_tokens: 1024,
              reasoning_effort: 'none',
              signal: AbortSignal.timeout(timeoutMs),
            });
            const content = response.text.trim();
            invokedProvider = response.provider || invokedProvider;
            invokedModel = response.model || invokedModel;
            if (!content) {
              availabilityFailure = false;
              routeErrors.push(`${alias} via ${invokedProvider}/${invokedModel}: response contained no usable text`);
              continue;
            }
            return { text: content, model: invokedModel, provider: invokedProvider, success: true, fallbackUsed: false, routeErrors: [...routeErrors] };
          } catch (err) {
            availabilityFailure = true;
            routeErrors.push(`${alias}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!availabilityFailure) break;
      }
    } catch (err) {
      routeErrors.push(`freelm initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const primaryError = routeErrors.join(' | ') || 'freelm returned no usable text without a reported provider error';

    if (this.gemini && !isKeylessOnly(this.env)) {
      try {
        const response = await this.gemini.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: fullPrompt,
          config: { responseMimeType: 'application/json' },
        });
        if (!response.text) throw new Error('Gemini returned no message content.');
        return { text: response.text, model: 'gemini-2.5-flash', provider: 'Google AI Studio / Gemini', success: true, fallbackUsed: true, routeErrors: [...routeErrors] };
      } catch (err) {
        return {
          text: '',
          model: 'auto:coding -> gemini-2.5-flash',
          provider: 'keyless model routes + Gemini fallback',
          success: false,
          error: `Primary keyless route failed: ${primaryError}; Gemini fallback failed: ${err instanceof Error ? err.message : String(err)}`,
          fallbackUsed: true,
          routeErrors: [...routeErrors],
        };
      }
    }

    return { text: '', model: 'chat:large', provider: 'keyless model routes unavailable', success: false, error: primaryError, routeErrors: [...routeErrors] };
  }

  /** Ask the model for a compact JSON object; returns null on any unusable output. */
  async completeJson<T>(messages: ChatMessage[], fullPrompt: string, opts: CompleteOptions = {}): Promise<{ value: T | null; result: ModelResult }> {
    const result = await this.complete(messages, fullPrompt, opts);
    if (!result.success || !result.text.trim()) return { value: null, result };
    const value = extractJson<T>(result.text);
    return { value, result };
  }
}

/**
 * Parse a JSON object out of model text that may wrap it in fences or prose.
 * Returns null when nothing parseable is present, so callers can tell "no answer"
 * apart from a real answer instead of silently defaulting.
 */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to the first balanced {...} block (handles leading/trailing prose).
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function options_timeout(env: NodeJS.ProcessEnv, fallback: number): number {
  const parsed = Number.parseInt(env.FORGE_MODEL_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : fallback;
}
