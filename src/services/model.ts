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

      // Some anonymous endpoints report HTTP success but return an empty/thinking-only
      // answer. Treat that as a failed model choice and try another discovered alias.
      for (const alias of ['chat', 'chat:fast', 'chat:small']) {
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
            continue;
          }
          return {
            text: content,
            model: invokedModel,
            provider: invokedProvider,
            success: true,
            fallbackUsed: false,
            keylessRouteErrors: [...primaryErrors],
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          primaryErrors.push(`${alias}: ${errorMessage}`);
        }
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
