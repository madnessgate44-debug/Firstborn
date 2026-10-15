/**
 * Isolated runtime verification: the audit's only step that executes target code.
 *
 * It clones the target at the audited commit into a throwaway directory and runs the
 * target's own checks (install, lint, test, build). This is how the audit finds
 * compile-time and runtime failures — type errors, null dereferences, failing tests —
 * that a read-only sample cannot see.
 *
 * SECURITY: this runs untrusted code, including dependency lifecycle scripts. It is
 * therefore OFF by default and only runs when a caller explicitly sets `enabled`. It
 * never touches the host working tree: everything happens inside a scratch temp
 * directory that is removed afterwards.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RepoContext } from './repo-context.ts';

export interface RuntimeVerificationOptions {
  enabled: boolean;
  /** Override the install command. Default: `npm ci` with a lockfile, else `npm install --legacy-peer-deps`. */
  installCommand?: string;
  /** Checks to run. Default: every one of lint/test/build that the target's package.json defines. */
  checks?: { name: string; command: string; severity?: 'HIGH' | 'MEDIUM' | 'LOW' }[];
  /** Per-command wall-clock cap. Default 10 minutes. */
  timeoutMs?: number;
  /** Scratch directory; a fresh temp dir is used when omitted. */
  workDir?: string;
  /**
   * Run the checks in this existing directory instead of cloning the target.
   * Useful for auditing a local checkout and for tests. Never removed.
   */
  localDir?: string;
  /** Keep the scratch directory after the run (for debugging). Default false. */
  keep?: boolean;
}

export interface RuntimeCheck {
  name: string;
  command: string;
  exitCode: number;
  output: string;
  severity?: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Paths implicated by the failure (parsed from tsc output when possible). */
  paths: string[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 20_000;

function run(command: string, cwd: string, timeoutMs: number): { exitCode: number; output: string } {
  const res = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { exitCode: 124, output: `${out}\n[timed out after ${Math.round(timeoutMs / 1000)}s]`.trim() };
  }
  return { exitCode: res.status ?? 1, output: out.slice(0, MAX_OUTPUT) };
}

/** Paths a `tsc`-style output blames: `src/x.ts(12,3): error TS...`. */
function blamedPaths(output: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of output.matchAll(/([\w./-]+\.(?:ts|tsx|js|jsx))\(\d+,\d+\):\s*error/gi)) {
    if (known.has(m[1])) found.add(m[1]);
  }
  return [...found];
}

/** Default checks: whatever the target's package.json actually defines. */
function defaultChecks(scripts: Record<string, string>): { name: string; command: string; severity?: 'HIGH' | 'MEDIUM' | 'LOW' }[] {
  const wanted = ['lint', 'test', 'build'];
  return wanted.filter((n) => typeof scripts[n] === 'string').map((n) => ({ name: n, command: `npm run ${n}` }));
}

function cloneCommand(ctx: RepoContext, dest: string): string {
  const token = process.env.GITHUB_TOKEN ? `x-access-token:${process.env.GITHUB_TOKEN}@` : '';
  const url = `https://${token}github.com/${ctx.target}.git`;
  // A full clone is the most faithful; the commit is checked out explicitly.
  return `git clone --quiet ${url} ${dest} && git -C ${dest} checkout --quiet ${ctx.commit}`;
}

export async function verifyRuntime(
  ctx: RepoContext,
  corpus: Record<string, string> | null,
  options: RuntimeVerificationOptions
): Promise<RuntimeCheck[]> {
  if (!options.enabled) return [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pkgText = corpus?.['package.json'] ?? ctx.excerpts['package.json'];
  if (!pkgText) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(pkgText).scripts as Record<string, string>) ?? {};
  } catch {
    return [];
  }

  const dir = options.localDir ?? options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-'));
  const ownDir = !options.localDir;
  const checks: RuntimeCheck[] = [];
  const known = new Set(ctx.files);
  try {
    if (!options.localDir) {
      const clone = run(cloneCommand(ctx, dir), os.tmpdir(), timeoutMs);
      if (clone.exitCode !== 0) {
        return [{ name: 'clone', command: `git clone ${ctx.target}@${ctx.commit.slice(0, 8)}`, exitCode: clone.exitCode, output: clone.output, severity: 'MEDIUM', paths: [] }];
      }
    }

    const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
    const installCommand = options.installCommand ?? (hasLock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund --legacy-peer-deps');
    const install = run(installCommand, dir, timeoutMs);
    checks.push({ name: 'install', command: installCommand, exitCode: install.exitCode, output: install.output, severity: 'HIGH', paths: ['package.json'] });
    if (install.exitCode !== 0) return checks;

    const toRun = options.checks ?? defaultChecks(scripts);
    for (const c of toRun) {
      const r = run(c.command, dir, timeoutMs);
      checks.push({
        name: c.name,
        command: c.command,
        exitCode: r.exitCode,
        output: r.output,
        severity: c.severity,
        paths: blamedPaths(r.output, known),
      });
    }
    return checks;
  } finally {
    if (ownDir && !options.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}
