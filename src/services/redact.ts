/**
 * Secret redaction for anything that leaves the browser (snapshots, tool
 * results, audit receipts). Deterministic and dependency-free: same input,
 * same output. Patterns target credential shapes and credential-labelled
 * values, so ordinary prose is left intact.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // OpenAI / Anthropic style keys
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  // GitHub tokens
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_TOKEN]'],
  // Google API keys
  [/\bAIza[0-9A-Za-z\-_]{20,}\b/g, '[REDACTED_KEY]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // Bearer tokens in headers or text
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED]'],
  // key=value / key: value credential pairs
  [
    /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"'&]{6,})/gi,
    '$1: [REDACTED]',
  ],
];

/** Replace credential-shaped substrings with stable placeholders. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
