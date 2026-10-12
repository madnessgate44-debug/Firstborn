/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';
import { FreeLLM } from 'freelm';

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

/**
 * GitHub capitalizes repository-variable names, so the flag can arrive as
 * `True`/`TRUE`, not just `true`. Normalize before comparing, otherwise the
 * keyless-only safety lock silently fails to engage.
 */
function isKeylessOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FIRSTBORN_KEYLESS_ONLY ?? '').trim().toLowerCase() === 'true';
}

export { isKeylessOnly };

export class ModelService {
  private readonly gemini: GoogleGenAI | null;
  private readonly geminiConfigured: boolean;

  constructor() {
    if (isKeylessOnly()) {
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
      fallbackConfigured: this.geminiConfigured && !isKeylessOnly(),
      costStatus: isKeylessOnly()
        ? 'Strict keyless-only mode: provider credentials are removed and Gemini fallback is disabled.'
        : 'freelm prefers configured free-tier providers and can fall back to anonymous keyless endpoints; Gemini fallback is optional.',
    };
  }

  async generatePlanAndPatch(prompt: string, contextFiles: { path: string; content: string }[]): Promise<ModelGenerationResult> {
    // The separators are drawn from a weird token so a model cannot mistake them
    // for file content and reuse one as an exact "find" anchor (exhaustion run:
    // models anchored on the literal "--- END FILE ---" and could never apply).
    const fileContexts = contextFiles
      .map((f) => `<<<FORGE_CONTEXT_FILE path="${f.path}" (harness marker, not file content)>>>\n${f.content}\n<<<FORGE_END_CONTEXT_FILE (harness marker, not file content)>>>`)
      .join('\n\n');

    const fullPrompt = `You are Forge, the precise coding and audit agent for Firstborn.
Follow these rules:
- Inspect the supplied target-repository files; never pretend to have inspected files not supplied.
- Lines like <<<FORGE_CONTEXT_FILE ...>>> and <<<FORGE_END_CONTEXT_FILE ...>>> are harness markers, NOT file content. Never use them as a "find" anchor; copy every find string only from real file content between the markers.
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
STRICT OUTPUT LIMIT: reserve output well below the anonymous endpoint's 2048-token ceiling by using max_tokens=1024. Return compact valid JSON only, with no markdown. For existing files, action MUST be "modify" and MUST use "edits"; never return the whole file in "content". For a new file, action MUST be "create" and use "content" instead of "edits". Prefer the smallest patch that satisfies the requirements; if the mission needs more than two files or three edits, return only the first bounded stage and state the remaining work in summary rather than truncating the JSON. Keep each find/replace snippet minimal but exact. Every find string must occur exactly once in the supplied source file. Do not repeat unchanged source. For each requirement, list the exact checks in checkCommands that verify it, or set manualReviewNote when no automated check exists. If a safe patch cannot fit these limits, return valid JSON with an empty changes array and explain the blocker in summary. Use only paths in the supplied target repository inventory or clearly justified new paths.
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
    const routingNotes: string[] = [];
    let invokedProvider = 'freelm free-tier router';
    let invokedModel = 'chat';

    try {
      const llm = FreeLLM.fromEnv({
        // Always include the no-signup Kilo/OVHcloud routes as last resorts.
        keyless: true,
        maxAttempts: 12,
        timeout: 35,
        hedge: true,
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

      // 1. DISCOVERY (find the finest free model currently available)
      // freelm maps aliases to concrete models via tags: `chat:large`/`chat:best`
      // select the large-tagged (most capable) models, `chat:fast`/`chat:small`
      // the smaller ones. Enumerate the live candidate set so we can prefer the
      // strongest route that answers, and report exactly which model was chosen
      // and what stronger options existed.
      const discoveredRoutes: { alias: string; provider: string; model: string }[] = [];
      const capabilityEscalation: string[] = [];
      try {
        const concreteByAlias = new Map<string, string[]>();
        for (const alias of ['chat:large', 'chat:best', 'chat:fast', 'chat:small']) {
          for (const provider of llm.providers) {
            try {
              for (const modelId of provider.resolveModels(alias)) {
                if (!concreteByAlias.has(modelId)) concreteByAlias.set(modelId, []);
                concreteByAlias.get(modelId)!.push(`${provider.name}:${alias}`);
              }
            } catch {
              // Alias unsupported for this provider; skip it.
            }
          }
        }
        for (const [modelId, sources] of concreteByAlias) {
          discoveredRoutes.push({ alias: sources[0], provider: sources[0].split(':')[0], model: modelId });
        }
      } catch {
        // Discovery is best-effort; the alias probe below still works.
      }
      if (discoveredRoutes.length > 0) {
        routingNotes.push(`discovery enumerated ${discoveredRoutes.length} candidate model(s) across ${new Set(discoveredRoutes.map((r) => r.provider)).size} provider(s)`);
      }

      // 2. RANKING (try the strongest available model first; degrade only on failure).
      // `chat:large` resolves to the large-tagged models, so a capable anonymous
      // route is attempted before any fallback. `chat`/`chat:fast`/`chat:small`
      // follow the same failover chain, and freelm itself degrades a failing
      // provider/model internally (hedge, cooldowns, benching) before we step down.
      for (const alias of ['chat:large', 'chat', 'chat:fast', 'chat:small', 'chat:best']) {
        try {
          const response = await llm.chat(messages, {
            model: alias,
            temperature: 0.1,
            max_tokens: 1024,
            signal: AbortSignal.timeout(40000),
          });
          const content = response.text.trim();
          invokedProvider = response.provider || invokedProvider;
          invokedModel = response.model || invokedModel;
          if (!content) {
            primaryErrors.push(`${alias} via ${invokedProvider}: response contained no usable text`);
            capabilityEscalation.push(`${alias} returned no usable text`);
            continue;
          }
          // Prefer the finest model that actually answered: if we had to settle
          // below the top capability tier, say so explicitly.
          const triedTopTier = alias === 'chat:large' || alias === 'chat:best';
          return {
            text: content,
            model: invokedModel,
            provider: invokedProvider,
            success: true,
            fallbackUsed: false,
            keylessRouteErrors: [
              ...primaryErrors,
              ...routingNotes,
              ...(triedTopTier
                ? []
                : [`selected ${alias} (${invokedModel} via ${invokedProvider}) after stronger routes failed: ${capabilityEscalation.join(' | ') || 'none reported'}`]),
            ],
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          primaryErrors.push(`${alias}: ${errorMessage}`);
          capabilityEscalation.push(`${alias}: ${errorMessage}`);
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      primaryErrors.push(`freelm initialization failed: ${errorMessage}`);
    }

    const primaryError = primaryErrors.join(' | ') || 'freelm returned no usable text without a reported provider error';

    if (this.gemini && !isKeylessOnly()) {
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
      error: `All keyless primary routes failed: ${primaryError}. ${isKeylessOnly() ? 'Gemini fallback is disabled by FIRSTBORN_KEYLESS_ONLY=true.' : 'Gemini fallback is not configured.'}`,
      fallbackUsed: false,
      keylessRouteErrors: [...primaryErrors],
    };
  }
}
