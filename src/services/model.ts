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
}

export class ModelService {
  private ai: GoogleGenAI | null = null;
  private apiKeyPresent: boolean = false;

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (key && key.trim() !== '' && key !== 'MY_GEMINI_API_KEY') {
      this.ai = new GoogleGenAI({});
      this.apiKeyPresent = true;
    }
  }

  isConfigured(): boolean {
    return this.apiKeyPresent;
  }

  getProviderInfo() {
    return {
      provider: 'Google AI Studio / Gemini',
      model: 'gemini-2.5-flash',
      configured: this.apiKeyPresent,
      costStatus: 'Zero-cost in AI Studio runtime; requires free-tier key upon export',
    };
  }

  async generatePlanAndPatch(prompt: string, contextFiles: { path: string; content: string }[]): Promise<ModelGenerationResult> {
    if (!this.ai || !this.apiKeyPresent) {
      return {
        text: '',
        model: 'gemini-2.5-flash',
        provider: 'Google AI Studio / Gemini',
        success: false,
        error: 'Model provider is not configured. GEMINI_API_KEY is missing or invalid.',
      };
    }

    try {
      const fileContexts = contextFiles
        .map((f) => `--- FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`)
        .join('\n\n');

      const fullPrompt = `You are Forge, the precise coding agent for Firstborn.
Follow AGENTS.md rules strictly:
- Inspect files and determine minimal, bounded changes.
- Number all requirements and acceptance criteria.
- Produce clean, reviewable patches without unnecessary rewrites or scope creep.
- Output a JSON response matching the following schema:
{
  "summary": "Short 1-line summary of changes",
  "requirements": [
    { "id": "REQ-1", "description": "...", "acceptanceCriteria": "..." }
  ],
  "changes": [
    {
      "path": "relative/path/to/file",
      "action": "modify" | "create" | "delete",
      "rationale": "...",
      "content": "Full replacement content for the file"
    }
  ],
  "suggestedChecks": ["npm run test", "npm run lint"]
}

Context Files:
${fileContexts}

User Task:
${prompt}

Respond ONLY with valid JSON.`;

      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: fullPrompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      return {
        text: response.text || '',
        model: 'gemini-2.5-flash',
        provider: 'Google AI Studio / Gemini',
        success: true,
      };
    } catch (err: any) {
      return {
        text: '',
        model: 'gemini-2.5-flash',
        provider: 'Google AI Studio / Gemini',
        success: false,
        error: err.message,
      };
    }
  }
}
