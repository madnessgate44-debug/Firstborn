/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from '@google/genai';

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
  private readonly primaryUrl = (process.env.FREE_MODEL_BASE_URL || 'https://api.murakumo.cloud/v1').replace(/\/+$/, '');
  private readonly primaryModel = process.env.FREE_MODEL_NAME || 'murakumo/free';

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
      primaryProvider: 'Murakumo anonymous free models with capacity fallback; llmfaucet best-effort secondary route',
      primaryModel: this.primaryModel,
      primaryRequiresApiKey: false,
      fallbackProvider: 'Google AI Studio / Gemini',
      fallbackModel: 'gemini-2.5-flash',
      fallbackConfigured: this.geminiConfigured,
      costStatus: 'Primary route is anonymous shared free capacity with variable limits; Gemini fallback requires an already-configured API key.',
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

    const keylessRoutes = [
      {
        baseUrl: this.primaryUrl,
        model: this.primaryModel,
        provider: process.env.FREE_MODEL_BASE_URL ? 'Configured keyless OpenAI-compatible endpoint' : 'Murakumo anonymous free model',
        authorization: '',
      },
      {
        baseUrl: 'https://api.murakumo.cloud/v1',
        model: 'mishima',
        provider: 'Murakumo anonymous fallback model',
        authorization: '',
      },
      {
        baseUrl: 'https://api.llmfaucet.dev/v1',
        model: 'auto:coding',
        provider: 'llmfaucet anonymous gateway',
        authorization: 'Bearer free',
      },
    ];
    const primaryErrors: string[] = [];
    for (const route of keylessRoutes) {
      let routeSucceeded = false;
      for (let attempt = 0; attempt < 2 && !routeSucceeded; attempt += 1) {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (route.authorization) headers.Authorization = route.authorization;
          const response = await fetch(`${route.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: route.model, messages, temperature: 0.1, max_tokens: 1024, reasoning: { effort: 'none' } }),
            signal: AbortSignal.timeout(30000),
          });

          if (!response.ok) {
            const responseBody = (await response.text()).slice(0, 300);
            const message = `${route.provider}: HTTP ${response.status}: ${responseBody}`;
            primaryErrors.push(message);
            if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
              await new Promise((resolve) => setTimeout(resolve, response.status === 429 ? 1500 : 750));
              continue;
            }
            routeSucceeded = true;
            continue;
          }

          const data = await response.json() as {
            choices?: { text?: unknown; finish_reason?: string; message?: { content?: unknown; refusal?: unknown; reasoning?: unknown } }[];
            model?: string;
            output_text?: unknown;
          };
          const choice = data.choices?.[0];
          const rawContent = choice?.message?.content ?? choice?.text ?? data.output_text;
          const content = typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent.map((part: any) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : typeof part?.content === 'string' ? part.content : '').join('')
              : '';
          if (!content.trim()) {
            const messageKeys = choice?.message && typeof choice.message === 'object'
              ? Object.keys(choice.message).join(',')
              : 'none';
            primaryErrors.push(`${route.provider}: HTTP ${response.status} but no usable text (finish_reason=${choice?.finish_reason || 'unknown'}, message_keys=${messageKeys}, response_model=${data.model || 'unknown'})`);
            if (attempt === 0) {
              await new Promise((resolve) => setTimeout(resolve, 750));
              continue;
            }
            routeSucceeded = true;
            continue;
          }

          return { text: content, model: data.model || route.model, provider: route.provider, success: true, fallbackUsed: false, keylessRouteErrors: [...primaryErrors] };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          primaryErrors.push(`${route.provider}: ${errorMessage}`);
          if (attempt === 0 && /timeout|aborted|fetch failed/i.test(errorMessage)) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          routeSucceeded = true;
        }
      }
    }
    const primaryError = primaryErrors.join(' | ');

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
      model: this.primaryModel,
      provider: 'keyless model routes unavailable',
      success: false,
      error: `All keyless primary routes failed: ${primaryError}. ${process.env.FIRSTBORN_KEYLESS_ONLY === 'true' ? 'Gemini fallback is disabled by FIRSTBORN_KEYLESS_ONLY=true.' : 'Gemini fallback is not configured.'}`,
      fallbackUsed: false,
      keylessRouteErrors: [...primaryErrors],
    };
  }
}
