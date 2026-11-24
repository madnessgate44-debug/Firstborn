/**
 * Integration fixture: truncation salvage + partial-stage gate, end to end.
 *
 * Drives ForgeAgent.executeTask against the real public qualification
 * sandbox with a stub model whose single response is a truncated two-file
 * JSON plan (the second file's content is cut mid-string). The flow must:
 *   1. recover the one complete file change via truncation salvage
 *      (no repair model call spent),
 *   2. apply it in the isolated worktree and pass the target checks,
 *   3. export the verified patch artifact (PR151 durable path),
 *   4. stop BLOCKED with an explicit partial-stage / needs-replan reason
 *      BEFORE any branch/commit/PR call.
 *
 * Not part of `npm test`: it clones the live public sandbox repo. Run with:
 *   npx tsx scripts/qualify-truncation-salvage.ts
 * Exits non-zero when any expectation fails.
 */
import { ForgeAgent } from '../src/agent/forge.ts';
import type { TaskDefinition } from '../src/types/agent.ts';
import * as fs from 'fs/promises';

const fullPlan = JSON.stringify({
  summary: 'stage 1: add multiply util; test file cut off by output limit',
  requirements: [
    {
      id: 'REQ-1',
      description: 'Add a multiply util and its node:test coverage',
      acceptanceCriteria: 'multiply.js parses and multiply(3, 4) === 12',
      checkCommands: ['node --check multiply.js'],
    },
  ],
  changes: [
    {
      path: 'multiply.js',
      action: 'create',
      rationale: 'new util',
      content: 'export function multiply(a, b) { return a * b; }\n',
    },
    {
      path: 'multiply.test.js',
      action: 'create',
      rationale: 'cover util',
      content:
        'import test from "node:test"; import assert from "node:assert/strict"; import { multiply } from "./multiply.js"; test("multiply", () => { assert.equal(multiply(3, 4), 12); });',
    },
  ],
});
// Truncate inside the second change's content string: the test file is lost.
// (lastIndexOf: the requirement text also mentions multiply(3, 4); the cut
// must land in the changes array, after the first change closed.)
const truncatedPlan = fullPlan.slice(0, fullPlan.lastIndexOf('multiply(3, 4)') + 6);

const failures: string[] = [];
const expect = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures.push(label);
};

const stubModel = {
  calls: 0,
  async generatePlanAndPatch() {
    this.calls += 1;
    return {
      success: true,
      text: truncatedPlan,
      provider: 'stub-truncation-fixture',
      model: 'truncated-plan-v1',
      fallbackUsed: false,
      keylessRouteErrors: [],
    };
  },
};

const agent = new ForgeAgent(undefined);
(agent as any).model = stubModel;

// Spies that must never fire: a salvaged plan may not reach commit or PR.
let commitReached = false;
let prReached = false;
const github = (agent as any).github;
for (const method of ['commitChangesToBranch', 'createBranch', 'pushBranch']) {
  if (typeof github[method] === 'function') {
    const original = github[method].bind(github);
    github[method] = async (...args: unknown[]) => {
      commitReached = true;
      return original(...args);
    };
  }
}
if (typeof github.createPullRequest === 'function') {
  const original = github.createPullRequest.bind(github);
  github.createPullRequest = async (...args: unknown[]) => {
    prReached = true;
    return original(...args);
  };
}

const task: TaskDefinition = {
  id: 'qual-truncation-salvage',
  title: 'Add multiply util with tests',
  description:
    'Create multiply.js exporting multiply(a, b) and multiply.test.js covering it. Verify with: node --check multiply.js',
  targetRepo: 'madnessgate44-debug/forge-qualification-sandbox',
  targetBranch: 'main',
  createdAt: new Date().toISOString(),
  author: 'truncation-salvage-fixture',
  allowPrCreation: false,
};

console.log('Running truncated-plan mission against the qualification sandbox...');
const report = await agent.executeTask(task);

console.log('--- FIXTURE RESULT ---');
console.log('status:', report.status);
console.log('blockerReason:', report.blockerReason ?? 'N/A');
console.log('patch artifact:', report.artifactPaths?.patch ?? 'N/A');
console.log('model calls:', report.modelInvoked.callsCount, '| stub calls:', stubModel.calls);
console.log('plannedChanges:', report.plannedChanges.map((c) => c.path).join(', ') || 'none');

expect(report.status === 'BLOCKED', 'mission ends BLOCKED, not COMPLETED/VERIFYING');
expect(/partial stage/i.test(report.blockerReason ?? ''), 'blocker reason names the partial stage');
expect(/replan/i.test(report.blockerReason ?? ''), 'blocker reason requires a replan of the remaining scope');
expect(stubModel.calls === 1, 'exactly one model call: salvage avoided the repair retry');
expect(report.plannedChanges.length === 1 && report.plannedChanges[0].path === 'multiply.js', 'only the complete file change survived salvage');
expect(report.testResults.length > 0 && report.testResults.every((t) => t.status === 'PASSED'), 'surviving work verified: all target checks passed');
expect(!commitReached, 'commit/branch calls never reached');
expect(!prReached, 'pull-request call never reached');
expect(!report.branchName && !report.prUrl && !report.headCommitSha, 'report carries no branch/PR/head commit');

const patchPath = report.artifactPaths?.patch;
expect(Boolean(patchPath), 'verified patch artifact was exported before the stop');
if (patchPath) {
  const patch = await fs.readFile(patchPath, 'utf-8');
  expect(patch.includes('multiply.js'), 'patch artifact contains the surviving file');
  expect(!patch.includes('multiply.test.js'), 'patch artifact does not contain the truncated file');
  expect(!patch.includes('package-lock.json'), 'scope drift stays out of the artifact');
  const salvageTrace = (report.trace ?? []).find((t) => t.stage === 'COMMIT' && t.status === 'BLOCKED' && /partial stage/i.test(t.detail ?? ''));
  expect(Boolean(salvageTrace), 'trace records the partial-stage stop at the COMMIT stage');
}

if (failures.length > 0) {
  console.error(`\nFIXTURE FAILED: ${failures.length} expectation(s) failed`);
  process.exit(1);
}
console.log('\nFIXTURE PASSED: salvage recovers complete work, verifies it, exports the patch, and stops as an explicit partial stage before commit/PR.');
