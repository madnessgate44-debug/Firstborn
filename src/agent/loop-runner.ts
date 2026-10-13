/**
 * M2 — Loop runner. Wires the loop kernel (`loop.ts`) to the real brain
 * (`ModelService.chooseNextAction`), the Forge tools (`tools.ts`), and the
 * permission gate (`policy.ts`) so a mission runs as look -> think -> act ->
 * observe instead of a fixed pipeline.
 *
 * Honors FORGE_LOOP_GOAL. Mutation is allowed only when the caller consents
 * (allowPrCreation) AND the permission profile permits branch writes, so the loop
 * can never widen its own authority.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ModelService } from '../services/model.ts';
import { loadPermissionConfig, evaluatePermissionPolicy } from './policy.ts';
import { buildForgeTools } from './tools.ts';
import { runAgentLoop, loadLoopLimits, FINISH_TOOL, type Authorization } from './loop.ts';

async function main(): Promise<void> {
  const goal = (process.env.FORGE_LOOP_GOAL ?? '').trim();
  if (!goal) throw new Error('FORGE_LOOP_GOAL is required (the mission objective).');

  const targetRepo = (process.env.GITHUB_REPOSITORY ?? 'madnessgate44-debug/Firstborn').trim();
  const [owner, repo] = targetRepo.split('/');
  if (!owner || !repo) throw new Error(`GITHUB_REPOSITORY must be owner/repo, got "${targetRepo}".`);
  const ref = (process.env.FORGE_LOOP_REF ?? 'main').trim();
  const token = process.env.GITHUB_TOKEN;
  const consented = ['1', 'true', 'yes', 'on'].includes((process.env.FORGE_ALLOW_PR_CREATION ?? '').trim().toLowerCase());

  const branch = (process.env.FORGE_LOOP_BRANCH ?? 'forge/task-loop').trim();
  // Operate on the real checkout when present (CI checks the repo out here), so
  // search/read/edit act on actual files and run_check can see installed deps.
  const workspace = (process.env.FORGE_LOOP_WORKSPACE ?? process.cwd()).trim();
  const policy = evaluatePermissionPolicy(
    {
      requestedPrCreation: consented,
      branchName: branch,
      targetBranch: 'main',
      repo: `${owner}/${repo}`,
    },
    loadPermissionConfig()
  );

  const tools = buildForgeTools({ owner, repo, ref, token, allowMutation: policy.allowBranchWrite, workspace });
  const model = new ModelService();

  const authorize: Authorization = (action) => {
    if (!policy.allowBranchWrite) {
      return { allowed: false, reason: `profile '${policy.effectiveProfile}' does not permit mutations` };
    }
    return { allowed: true };
  };

  const result = await runAgentLoop({
    goal,
    tools,
    brain: (state) => model.chooseNextAction(state),
    authorize,
    limits: loadLoopLimits(),
    workspace: branch,
    onStep: (step) => {
      console.log(`[loop ${step.index}] ${step.action.tool} -> ${step.observation.ok ? 'ok' : 'FAILED'}: ${step.observation.output.slice(0, 200)}`);
    },
  });

  console.log('--- FORGE LOOP REPORT ---');
  console.log('Goal:', goal);
  console.log('Status:', result.status);
  console.log('Steps:', result.steps.length);
  console.log('Reason:', result.reason);

  const evidenceDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    path.join(evidenceDir, 'forge-loop.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), goal, status: result.status, steps: result.steps, reason: result.reason }, null, 2) + '\n'
  );

  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((error) => {
  console.error('[Forge loop] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
