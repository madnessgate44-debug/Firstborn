/**
 * forge-company audit CLI — the software company performs a read-only audit.
 *
 *   npm run audit -- madnessgate44-debug/Amina
 *
 * This drives the real company engine: one work item per audit lens, competing
 * attempts, judged on evidence (a mandatory rule is that every finding cites a
 * path that exists). Read-only; it never clones or executes the target's code.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ModelService } from '../src/company/model.ts';
import { runCompanyAudit } from '../src/company/audit-company.ts';

const TOKEN = process.env.GITHUB_TOKEN || '';
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function ghJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'forge-company-audit', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function ghText(owner: string, repo: string, filePath: string, ref: string): Promise<string | null> {
  try {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    const data = await ghJson(`https://api.github.com/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    if (data.type !== 'file' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

const TEST_RE = /(^|\/)(tests?|__tests__|specs?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)(test_)?[^/]*_?test\.py$/i;

/** Fetch the inventory and a representative, bounded set of excerpts. */
export async function fetchRepoContext(target: string): Promise<{ target: string; commit: string; files: string[]; excerpts: Record<string, string> }> {
  if (!repoPattern.test(target) || target.includes('..')) throw new Error('target must be an explicit owner/repo value');
  const [owner, repo] = target.split('/');
  const meta = await ghJson(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = meta.default_branch;
  const commit = await ghJson(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
  const tree = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  const files: string[] = tree.tree.filter((i: any) => i.type === 'blob').map((i: any) => i.path);
  const has = (p: string) => files.includes(p);

  const src = files.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|kt|java)$/i.test(p) && !/(^|\/)(node_modules|dist|build)\//.test(p));
  const tests = src.filter((p) => TEST_RE.test(p)).slice(0, 4);
  const source = src.filter((p) => !TEST_RE.test(p)).slice(0, 14);
  const entrypoints = ['server.ts', 'index.js', 'index.ts', 'src/main.tsx', 'src/App.tsx', 'package.json', 'tsconfig.json', 'vite.config.ts'].filter(has);
  const workflows = files.filter((p) => /^\.github\/workflows\/.*\.ya?ml$/.test(p)).slice(0, 5);
  const keyPaths = [...new Set([...entrypoints, ...workflows, ...tests, ...source])].slice(0, 22);
  const excerpts: Record<string, string> = {};
  for (const p of keyPaths) {
    const v = await ghText(owner, repo, p, branch);
    if (v !== null) excerpts[p] = v.slice(0, 4000);
  }
  return { target: meta.full_name, commit: commit.sha, files, excerpts };
}

async function main(): Promise<void> {
  const target = (process.argv[2] || '').trim();
  if (!repoPattern.test(target) || target.includes('..')) {
    console.error('usage: npm run audit -- owner/repo');
    process.exitCode = 2;
    return;
  }
  const ctx = await fetchRepoContext(target);
  console.log(`[audit] ${ctx.target} @ ${ctx.commit.slice(0, 8)}; ${ctx.files.length} files; ${Object.keys(ctx.excerpts).length} excerpts`);

  const model = new ModelService();
  const info = model.getProviderInfo();
  console.log(`[audit] model: ${info.primaryProvider}; Gemini fallback configured: ${info.fallbackConfigured}`);

  const attempts = Math.max(1, Number.parseInt(process.env.FORGE_AUDIT_ATTEMPTS ?? '', 10) || 2);
  const result = await runCompanyAudit({ model, ctx, attemptsPerItem: attempts, providerInfo: info });

  console.log('\n--- COMPANY AUDIT REPORT ---');
  console.log('Status:', result.status, '|', result.reason);
  console.log('Winners:', result.winners.join(', ') || '(none)');
  for (const e of result.employees) console.log(`- ${e.title}: ${e.success ? `winner ${e.model}` : `FAILED (${e.note})`}`);
  console.log('Integrated findings:', result.findings.length);

  const outDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'company-audit.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'company-audit.md'), result.markdown + '\n');
  console.log('\n' + result.markdown);
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((err) => {
  console.error('[forge-company audit] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
