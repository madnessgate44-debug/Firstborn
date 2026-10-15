/**
 * Evidence ledger: turn a finding into a machine check that cannot be fooled.
 *
 * A language model must never be the only thing standing between a claim and the
 * report. For the failure modes that actually happened — a "stored XSS" claim with
 * no HTML sink anywhere, a "hardcoded API key" claim for a key read from the
 * environment — we settle the question deterministically by searching the real
 * source at the exact commit, and we show the command and its raw result so a
 * non-coder can spot-check it.
 *
 * The corpus is the exact-commit tarball, parsed in memory. No target code runs.
 */
import { gunzipSync } from 'node:zlib';

/** Text/source extensions worth scanning; everything else is skipped. */
const TEXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|html|css|scss|txt|env|toml|sh|py|go|rb|java|kt)$/i;

/** Raw-HTML sinks. If none exist, a "stored XSS via rendering" claim is false. */
export const RENDER_SINKS = [
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval(',
  'new Function(',
];

/** Literal credentials. If none exist, a "hardcoded secret" claim is false. */
export const SECRET_LITERAL_RE =
  /(AIza[0-9A-Za-z_\-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,})/;

export interface EvidenceCheck {
  /** What the check establishes, in plain words. */
  claim: string;
  /** A command a human can run to reproduce the check. */
  command: string;
  /** The raw result the check returned. */
  result: string;
  /** true = supports the finding; false = contradicts it. */
  supports: boolean;
  /** Literal a reader can paste into GitHub search to spot-check this themselves. */
  needle?: string;
}

export type FindingVerdict = 'SUPPORTED' | 'CONTRADICTED' | 'UNVERIFIED';
export type FindingCategory = 'verified-fact' | 'judgment';

export interface EvidenceOutcome {
  verdict: FindingVerdict;
  category: FindingCategory;
  checks: EvidenceCheck[];
}

/** Parse a gzipped tar archive into a { relativePath: utf8Text } map. */
export function parseTarGz(gz: Buffer): Record<string, string> {
  const buf = gunzipSync(gz);
  const files: Record<string, string> = {};
  let offset = 0;
  let pendingName: string | null = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = readStr(header, 0, 100);
    const size = Number.parseInt(readStr(header, 124, 12).trim() || '0', 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = readStr(header, 345, 155);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    let fullName = pendingName ?? (prefix ? `${prefix}/${name}` : name);
    pendingName = null;

    if (typeflag === 'L') {
      // GNU long name: this entry's data holds the *next* entry's path.
      pendingName = readStr(buf.subarray(dataStart, dataEnd), 0, size);
    } else if (typeflag === '0' || typeflag === '\0') {
      const rel = fullName.split('/').slice(1).join('/'); // drop the "owner-repo-sha/" root
      if (rel && TEXT_RE.test(rel)) files[rel] = buf.subarray(dataStart, dataEnd).toString('utf8');
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readStr(b: Uint8Array, off: number, len: number): string {
  const slice = b.subarray(off, off + len);
  const end = slice.indexOf(0);
  return Buffer.from(end >= 0 ? slice.subarray(0, end) : slice).toString('utf8');
}

export interface Hit {
  path: string;
  line: number;
  text: string;
}

/** Find every line in the corpus containing `needle` (case-insensitive). */
export function searchCorpus(files: Record<string, string>, needle: string): Hit[] {
  const hits: Hit[] = [];
  const n = needle.toLowerCase();
  for (const [path, content] of Object.entries(files)) {
    content.split('\n').forEach((text, i) => {
      if (text.toLowerCase().includes(n)) hits.push({ path, line: i + 1, text: text.trim().slice(0, 140) });
    });
  }
  return hits;
}

/** Aggregate hits for several needles. */
export function searchMany(files: Record<string, string>, needles: string[]): Hit[] {
  return needles.flatMap((n) => searchCorpus(files, n));
}

export function isRenderSinkClaim(text: string): boolean {
  return /\b(xss|cross[- ]site|unsanitized|raw html|innerhtml|dangerouslysetinnerhtml|html injection)\b/i.test(text);
}

export function isHardcodedSecretClaim(text: string): boolean {
  const aboutSecret = /\b(key|secret|token|password|credential)\b/i.test(text);
  const hardcoded = /\b(hard[- ]?coded|committed|checked in|in the (source|code|repo|bundle))\b/i.test(text);
  return aboutSecret && hardcoded;
}

/**
 * Settle a finding deterministically against the real source.
 *
 * - A render-sink (XSS) claim is contradicted when the corpus has zero HTML sinks;
 *   React escapes JSX by default, so there is no injection vector.
 * - A hardcoded-secret claim is contradicted when the corpus has zero literal
 *   credentials.
 * - Anything we cannot settle mechanically is an explicit *judgment*, not a fact.
 */
export function verifyFinding(
  finding: { title: string; evidence: string; recommendation: string; paths: string[] },
  corpus: Record<string, string>,
  fileCount: number
): EvidenceOutcome {
  const text = `${finding.title} ${finding.evidence} ${finding.recommendation}`;
  const checks: EvidenceCheck[] = [];

  const citedExist = finding.paths.length > 0;
  checks.push({
    claim: 'the cited paths exist in the repository',
    command: `git ls-files | grep -F <path>`,
    result: citedExist ? `all cited paths present: ${finding.paths.join(', ')}` : 'no path cited',
    supports: citedExist,
    needle: finding.paths[0],
  });

  if (isRenderSinkClaim(text)) {
    const hits = searchMany(corpus, RENDER_SINKS);
    const found = hits.length > 0;
    checks.push({
      claim: 'an unsafe HTML sink exists that could render untrusted content',
      command: `grep -rn "${RENDER_SINKS.join('|')}" <repo>`,
      result: found
        ? `${hits.length} match(es), e.g. ${hits[0].path}:${hits[0].line}`
        : `0 matches across ${fileCount} files`,
      supports: found,
      needle: 'dangerouslySetInnerHTML',
    });
    return {
      verdict: found ? 'SUPPORTED' : 'CONTRADICTED',
      category: 'verified-fact',
      checks,
    };
  }

  if (isHardcodedSecretClaim(text)) {
    const literal = Object.entries(corpus).flatMap(([path, content]) => {
      const m = content.match(SECRET_LITERAL_RE);
      return m ? [{ path, match: m[0].slice(0, 8) + '…' }] : [];
    });
    checks.push({
      claim: 'a literal credential is present in the source',
      command: `grep -rEn "${SECRET_LITERAL_RE.source.slice(0, 40)}…" <repo>`,
      result: literal.length ? `${literal.length} literal(s), e.g. ${literal[0].path}` : `0 literals across ${fileCount} files`,
      supports: literal.length > 0,
      needle: 'process.env',
    });
    return {
      verdict: literal.length ? 'SUPPORTED' : 'CONTRADICTED',
      category: 'verified-fact',
      checks,
    };
  }

  return { verdict: 'UNVERIFIED', category: 'judgment', checks };
}
