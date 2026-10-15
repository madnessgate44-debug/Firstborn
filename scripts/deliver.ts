/**
 * forge-company deliver CLI — audit a target, then deliver a verified fix.
 *
 *   npm run deliver -- <owner/repo> "goal"
 *
 * Read the target, run the software company's implementation team inside a clone
 * pinned at the audited commit, run the target's own checks, and open a pull
 * request on an isolated `forge/` branch. It never merges and never touches the
 * base branch. Requires GITHUB_TOKEN with `repo` scope (contents + pull requests).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelService } from '../src/company/model.ts';
import { modelBrain } from '../src/company/brains.ts';
import { buildRoleTools } from '../src/company/role-tools.ts';
import { DEFAULT_ROSTER } from '../src/company/roles.ts';
import type { Role } from '../src/company/roles.ts';
import { deliverChange, type PullRequestOpener } from '../src/company/deliver.ts';
import { fetchRepoContext } from '../src/company/repo-context.ts';

const TOKEN = process.env.GITHUB_TOKEN || '';
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The one tool sequence each role follows, so the model executes rather than wanders. */
const ROLE_SEQUENCE: Record<string, string[]> = {
  pm: ['finish with your requirements artifact (data.items = acceptance criteria)'],
  architect: ['read_file on the files named in the goal', 'finish with your design artifact (data.design, data.files)'],
  implementer: ['read_file on each file you will change', 'write_file with the corrected content', 'run_check the "test" command', 'finish with your change artifact'],
  reviewer: ['read_file on the changed file', 'finish with your review artifact (data.blockers = number)'],
  qa: ['run_check the "test" command', 'run_check the "lint" command', 'finish with your evidence artifact'],
  security: ['read_file on the changed file', 'finish with your security artifact (data.clean = boolean)'],
  release: ['finish with your decision artifact (data.ship = boolean)'],
};

function modelRoster(model: ModelService, workspaceDir: string): (item: { id: string; title: string }, attempt: number) => Role[] {
  return (_item, attempt) =>
    DEFAULT_ROSTER.map((r) => ({
      id: r.id,
      title: r.title,
      mandate: r.mandate,
      authority: r.authority,
      consumes: r.consumes,
      produces: r.produces,
      tools: buildRoleTools({
        workspaceDir,
        canMutate: r.authority === 'branch-write',
        allowedRoots: [''],
      }),
      brain: modelBrain(model, {
        role: `${r.title} (attempt ${attempt})`,
        mandate: r.mandate,
        sequence: ROLE_SEQUENCE[r.id],
        artifactHint: `Emit your "${r.produces}" artifact in data.`,
      }),
    }));
}

const openPr: PullRequestOpener = async ({ target, head, base, title, body, token }) => {
  const res = await fetch(`https://api.github.com/repos/${target}/pulls`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'forge-company-deliver' },
    body: JSON.stringify({ title, head, base, body }),
  });
  if (!res.ok) throw new Error(`GitHub PR API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = (args[0] || '').trim();
  const goal = args.slice(1).join(' ').trim() || 'Address the audit findings.';
  if (!repoPattern.test(target) || target.includes('..')) {
    console.error('usage: npm run deliver -- owner/repo "goal"');
    process.exitCode = 2;
    return;
  }

  const ctx = await fetchRepoContext(target);
  console.log(`[deliver] ${ctx.target} @ ${ctx.commit.slice(0, 8)}; goal: ${goal}`);

  const model = new ModelService();
  const info = model.getProviderInfo();
  console.log(`[deliver] model: ${info.primaryProvider}; Gemini fallback configured: ${info.fallbackConfigured}`);

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-deliver-'));
  const branch = `forge/deliver-${ctx.commit.slice(0, 8)}-${Date.now().toString(36)}`;

  const result = await deliverChange({
    target: ctx.target,
    goal,
    commit: ctx.commit,
    branch,
    workspaceDir,
    token: TOKEN,
    rosterFor: modelRoster(model, workspaceDir),
    attemptsPerItem: Math.max(1, Number.parseInt(process.env.FORGE_DELIVER_ATTEMPTS ?? '', 10) || 1),
    push: process.env.FORGE_DELIVER_PUSH !== 'false',
    openPr,
  });

  const outDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'company-delivery.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'company-delivery.md'), result.markdown + '\n');

  console.log('\n--- COMPANY DELIVERY REPORT ---');
  console.log('Status:', result.status, '|', result.reason);
  console.log('Branch:', result.branch, '| head:', result.headCommit ?? '(none)');
  console.log('Changed files:', result.changedFiles.join(', ') || '(none)');
  for (const c of result.checks) console.log(`- ${c.name}: ${c.status}`);
  if (result.prUrl) console.log('PR:', result.prUrl);
  console.log('\n' + result.markdown);
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((err) => {
  console.error('[forge-company deliver] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
