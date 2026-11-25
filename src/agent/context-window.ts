/**
 * Bounded excerpts of oversized source files.
 *
 * Forge used to block any task that named a file over 16000 characters, so it
 * could not edit large files at all (including its own forge.ts). Instead of
 * guessing, build an excerpt around the lines the task text points at: the
 * head of the file plus windows around lines that contain a quoted string or
 * identifier from the task. The model sees only the excerpt, but every edit
 * anchor is still validated against the FULL file by applyExactEdits, so an
 * anchor that is missing or not unique in the real file is rejected.
 */

export interface WindowedContext {
  /** Excerpt to show the model. Omitted ranges are marked with an unusable anchor. */
  excerpt: string;
  /** Number of task terms that matched at least one line. */
  matchedTerms: number;
  /** Total lines in the file and lines shown. */
  totalLines: number;
  shownLines: number;
}

/** Files larger than this are never excerpted; Forge still blocks. */
export const MAX_WINDOWED_FILE_CHARS = 600_000;

const HEAD_LINES = 30;
const CONTEXT_RADIUS = 20;

/** Quoted strings and code-like identifiers from the task text. */
export function extractTaskTerms(taskText: string): { strong: string[]; weak: string[] } {
  const strong = new Set<string>();
  for (const m of taskText.matchAll(/'([^'\n]{3,80})'|"([^"\n]{3,80})"|`([^`\n]{3,80})`/g)) {
    strong.add((m[1] ?? m[2] ?? m[3]).trim());
  }
  const weak = new Set<string>();
  for (const m of taskText.matchAll(/[A-Za-z_][A-Za-z0-9_.]{4,}/g)) {
    if (/[A-Z_.]/.test(m[0].slice(1)) || m[0].length > 9) weak.add(m[0]);
  }
  return { strong: [...strong].slice(0, 20), weak: [...weak].slice(0, 40) };
}

export function buildWindowedContext(content: string, taskText: string, maxChars = 12000): WindowedContext | null {
  const lines = content.split('\n');
  const { strong, weak } = extractTaskTerms(taskText);
  const hit = new Map<number, number>(); // line index -> score
  const matched = new Set<string>();
  const score = (terms: string[], weight: number) => {
    for (const term of terms) {
      lines.forEach((line, i) => {
        if (line.includes(term)) {
          hit.set(i, (hit.get(i) ?? 0) + weight);
          matched.add(term);
        }
      });
    }
  };
  score(strong, 3);
  score(weak, 1);
  if (hit.size === 0) return null;

  const keep = new Set<number>();
  const used = () => [...keep].reduce((n, i) => n + lines[i].length + 1, 0);
  for (let i = 0; i < Math.min(HEAD_LINES, lines.length); i += 1) keep.add(i);
  const ranked = [...hit.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const [center] of ranked) {
    const add: number[] = [];
    for (let i = Math.max(0, center - CONTEXT_RADIUS); i <= Math.min(lines.length - 1, center + CONTEXT_RADIUS); i += 1) {
      if (!keep.has(i)) add.push(i);
    }
    const cost = add.reduce((n, i) => n + lines[i].length + 1, 0);
    if (used() + cost > maxChars) continue;
    add.forEach((i) => keep.add(i));
  }
  const ordered = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const i of ordered) {
    if (i !== prev + 1) out.push(`<<<FORGE_OMITTED ${i - prev - 1} lines>>>`);
    out.push(lines[i]);
    prev = i;
  }
  if (prev < lines.length - 1) out.push(`<<<FORGE_OMITTED ${lines.length - 1 - prev} lines>>>`);
  return { excerpt: out.join('\n'), matchedTerms: matched.size, totalLines: lines.length, shownLines: ordered.length };
}
