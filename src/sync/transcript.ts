/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transcript normalization and redaction.
 *
 * The pipeline stores source-faithful text: the words a participant wrote are
 * preserved verbatim. The only transformation allowed is redaction of secrets,
 * which is applied before anything leaves the process so a token can never reach
 * a commit.
 *
 * Redaction is deliberately conservative and deterministic: the same input always
 * produces the same output, and a redaction is visible as `[REDACTED:<kind>]`
 * rather than silently deleted, so a reader can tell something was removed.
 */

import type { RawEvent, TranscriptMessage } from './types.ts';

interface RedactionRule {
  kind: string;
  pattern: RegExp;
}

/**
 * Secret shapes that must never be committed. Ordered longest-first where a
 * shorter pattern would otherwise consume part of a longer one.
 */
const REDACTION_RULES: RedactionRule[] = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'aws-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: 'bearer-token',
    pattern: /\b(?:Bearer|token|api[_-]?key|apikey|secret|password|passwd|pwd)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{16,})["']?/gi,
  },
];

/** Apply every redaction rule to a string. Pure. */
export function redact(text: string): { text: string; redactions: string[] } {
  let out = text;
  const redactions: string[] = [];
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, (match, ...groups) => {
      // For the key/value rule keep the key name and replace only the value.
      if (rule.kind === 'bearer-token' && typeof groups[0] === 'string') {
        redactions.push(rule.kind);
        return match.replace(groups[0], `[REDACTED:${rule.kind}]`);
      }
      redactions.push(rule.kind);
      return `[REDACTED:${rule.kind}]`;
    });
  }
  return { text: out, redactions };
}

/** Flatten an OpenHands `llm_message.content` array into plain text. */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
      parts.push((part as any).text);
    }
  }
  return parts.join('\n');
}

/** Map an OpenHands event source to a transcript speaker. */
function speakerFor(event: RawEvent): TranscriptMessage['speaker'] | null {
  if (event.source === 'user') return 'user';
  if (event.source === 'agent' || event.source === 'assistant') return 'assistant';
  if (event.source === 'environment' || event.source === 'system') return 'system';
  return null;
}

/**
 * Convert raw events into source-faithful transcript messages.
 *
 * Only genuine conversation messages become transcript entries: a user or
 * assistant `llm_message`. Tool actions, observations, and state updates are not
 * conversation text and are excluded so the transcript stays readable. The stable
 * source event id is kept as the message id.
 */
export function normalizeEvents(events: RawEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const event of events) {
    const speaker = speakerFor(event);
    if (!speaker) continue;
    const llm = (event as any).llm_message;
    if (!llm || typeof llm !== 'object') continue;
    const raw = extractMessageText(llm.content);
    if (!raw.trim()) continue;
    const { text } = redact(raw);
    messages.push({
      id: event.id,
      speaker,
      timestamp: event.timestamp,
      text,
    });
  }
  return messages;
}
