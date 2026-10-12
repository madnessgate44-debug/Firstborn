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
}

type ChatMessage = { role: 'system' | 'user'; content: string };

export class ModelService {
  private readonly gemini: GoogleGenAI | null;
  private readonly geminiConfigured: boolean;
  private readonly primaryUrl = (process.env.FREE_MODEL_BASE_URL || 'https://api.murakumo.cloud/v1').replace(/\/+$/, '');
  private readonly primaryModel = process.env.FREE_MODEL_NAME || 'auto:coding';

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
      primaryProvider: 'Murakumo anonymous inference; llmfaucet keyless gateway as secondary route',
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
  "changes": [{"path":"relative/path","action":"modify|create","rationale":"...","content":"full file content"}],
  "suggestedChecks": ["npm run lint"]
}
Use only paths in the supplied target repository inventory or clearly justified new paths.
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
        provider: process.env.FREE_MODEL_BASE_URL ? 'Configured keyless OpenAI-compatible endpoint' : 'Murakumo anonymous inference',
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
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (route.authorization) headers.Authorization = route.authorization;
        const response = await fetch(`${route.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: route.model, messages, temperature: 0.1 }),
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
        const data = await response.json() as { choices?: { message?: { content?: string } }[]; model?: string };
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('Endpoint returned no message content.');
        return { text, model: data.model || route.model, provider: route.provider, success: true, fallbackUsed: false };
      } catch (err) {
        primaryErrors.push(`${route.provider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const primaryError = primaryErrors.join(' | ');

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
        };
      } catch (err) {
        const fallbackError = err instanceof Error ? err.message : String(err);
        return {
          text: '',
          model: 'auto:coding -> gemini-2.5-flash',
          provider: 'llmfaucet anonymous gateway + Gemini fallback',
          success: false,
          error: `Primary keyless route failed: ${primaryError}; Gemini fallback failed: ${fallbackError}`,
          fallbackUsed: true,
        };
      }
    }

    return {
      text: '',
      model: this.primaryModel,
      provider: 'keyless model routes unavailable',
      success: false,
      error: `All keyless primary routes failed: ${primaryError}. Gemini fallback is not configured.`,
      fallbackUsed: false,
    };
  }
}
