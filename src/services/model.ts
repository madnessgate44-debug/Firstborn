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
  private readonly primaryUrl = (process.env.FREE_MODEL_BASE_URL || 'https://api.llmfaucet.dev/v1').replace(/\/+$/, '');
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
      primaryProvider: 'llmfaucet anonymous gateway',
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

    let primaryError = '';
    try {
      const response = await fetch(`${this.primaryUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer free' },
        body: JSON.stringify({ model: this.primaryModel, messages, temperature: 0.1 }),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`Keyless model gateway returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const data = await response.json() as { choices?: { message?: { content?: string } }[]; model?: string };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('Keyless model gateway returned no message content.');
      return { text, model: data.model || this.primaryModel, provider: 'llmfaucet anonymous gateway', success: true, fallbackUsed: false };
    } catch (err) {
      primaryError = err instanceof Error ? err.message : String(err);
    }

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
      provider: 'llmfaucet anonymous gateway',
      success: false,
      error: `Primary keyless route failed: ${primaryError}. Gemini fallback is not configured.`,
      fallbackUsed: false,
    };
  }
}
