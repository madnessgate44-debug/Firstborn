/**
 * Deterministic salvage for truncated model JSON plans.
 *
 * Large missions can exhaust the model's output token budget mid-JSON. The
 * strict parser then fails and the mission burns a repair call or fails
 * outright. This module attempts a bounded, structural repair first: it cuts
 * the text back to the last fully closed container, closes any containers
 * still open, and parses the result.
 *
 * Salvage NEVER invents content. The only accepted cut point is directly
 * after a completed `}` or `]`: anything after it (a partial object, a
 * partial string, a number cut in half) is dropped whole. This is what makes
 * a salvaged plan safe to validate: every change/edit/requirement that
 * survives was complete in the model's actual output, and nothing partial
 * is kept and "completed" by the repair.
 *
 * The caller re-validates the salvaged value with validateModelPlanShape and
 * requires at least one complete file change before trusting it.
 */

// Anonymous models sometimes wrap otherwise valid JSON in Markdown fences.
// Same normalization rule as the strict parser: unwrap the fence only.
function normalizeModelJsonText(text: string): string {
  let normalized = text.trim();
  if (normalized.startsWith('```')) {
    const firstLineEnd = normalized.indexOf('\n');
    if (firstLineEnd >= 0) normalized = normalized.slice(firstLineEnd + 1);
    const trimmedEnd = normalized.trimEnd();
    if (trimmedEnd.endsWith('```')) normalized = trimmedEnd.slice(0, -3);
    normalized = normalized.trim();
  }
  return normalized;
}

export interface PlanSalvageResult {
  /** Parsed plan when one could be recovered, otherwise null. */
  plan: unknown | null;
  /** true when the plan came from truncation repair rather than a clean parse. */
  salvaged: boolean;
}

/**
 * Try to parse model output as JSON; if strict parsing fails, attempt a
 * structural truncation repair. Returns { plan: null } when nothing usable
 * can be recovered.
 */
export function parsePlanJsonWithSalvage(text: string): PlanSalvageResult {
  const normalized = normalizeModelJsonText(text);
  try {
    return { plan: JSON.parse(normalized), salvaged: false };
  } catch {
    // Fall through to truncation salvage.
  }

  const repaired = repairTruncatedJson(normalized);
  if (repaired === null) return { plan: null, salvaged: false };
  try {
    return { plan: JSON.parse(repaired), salvaged: true };
  } catch {
    return { plan: null, salvaged: false };
  }
}

/**
 * Cut a truncated JSON document back to the last closed container and close
 * any containers still open. Returns the repaired string, or null when the
 * input is not a truncated JSON document (no open containers left, no
 * completed container to keep, or structural mismatch).
 */
export function repairTruncatedJson(text: string): string | null {
  const src = text;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastContainerClose = -1;
  let sawOpen = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      sawOpen = true;
      stack.push(ch === '{' ? '}' : ']');
    } else if (ch === '}' || ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return null;
      stack.pop();
      lastContainerClose = i + 1;
    }
  }

  // Repair applies only to a document that opened containers and never
  // closed them all. Anything else is not a truncation we can safely close.
  if (!sawOpen || stack.length === 0) return null;
  // No completed container to keep: whatever partial content exists is not
  // salvageable without guessing.
  if (lastContainerClose <= 0) return null;

  const cut = src.slice(0, lastContainerClose);

  // Recompute the open stack on the cut text so the closers match reality.
  const openStack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cut.length; i++) {
    const ch = cut[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') openStack.push('}');
    else if (ch === '[') openStack.push(']');
    else if (ch === '}' || ch === ']') {
      if (openStack.length === 0 || openStack[openStack.length - 1] !== ch) return null;
      openStack.pop();
    }
  }
  if (inStr) return null;
  if (openStack.length === 0) return null;
  return cut + openStack.reverse().join('');
}
