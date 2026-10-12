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

export class ModelService {
  private readonly gemini: GoogleGenAI | null;
  private readonly geminiConfigured: boolean;

  constructor() {
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
      primaryModel: 'chat:large',
      primaryRequiresApiKey: false,
      fallbackProvider: 'Google AI Studio / Gemini',
      fallbackModel: 'gemini-2.5-flash',
      fallbackConfigured: this.geminiConfigured,
      costStatus: 'freelm prefers configured free-tier providers and can fall back to anonymous keyless endpoints; Gemini fallback is optional.',
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
- Return JSON matching this schema:
{
  "summary": "Short summary",
  "requirements": [{"id":"REQ-1","description":"...","acceptanceCriteria":"..."}],
  "changes": [
    {"path":"relative/path","action":"modify","rationale":"...","edits":[{"find":"exact unique source snippet","replace":"replacement snippet"}]}
  ],
  "suggestedChecks": ["npm run lint"]
}
STRICT OUTPUT LIMIT: reserve output well below the anonymous endpoint's 2048-token ceiling by using max_tokens=1024. Return compact valid JSON only, with no markdown. For existing files, action MUST be "modify" and MUST use "edits"; never return the whole file in "content". For a new file, action MUST be "create" and use "content" instead of "edits". Limit the whole patch to at most 2 files and at most 3 edits total. Keep each find/replace snippet minimal but exact. Every find string must occur exactly once in the supplied source file. Do not repeat unchanged source. If a safe patch cannot fit these limits, return valid JSON with an empty changes array and explain the blocker in summary. Use only paths in the supplied target repository inventory or clearly justified new paths.
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
    let invokedModel = 'chat:large';

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
      for (const alias of ['chat:large', 'chat:fast', 'chat:small']) {
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

    if (this.gemini) {
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
      error: `All keyless primary routes failed: ${primaryError}. Gemini fallback is not configured.`,
      fallbackUsed: false,
      keylessRouteErrors: [...primaryErrors],
    };
  }
}
