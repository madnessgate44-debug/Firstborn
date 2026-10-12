/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ForgeAgent } from './forge.ts';
import * as fs from 'fs/promises';
import * as path from 'path';

async function runCli() {
  const taskId = process.env.TASK_ID || `cli-${Date.now()}`;
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'task';
  const taskTitle = process.env.TASK_TITLE || 'Automated Maintenance Task';
  const taskDesc = process.env.TASK_DESC || 'Run repository health check and verification';
  const targetRepo = process.env.GITHUB_REPOSITORY || 'madnessgate44-debug/firstborn';
  const token = process.env.GITHUB_TOKEN;

  console.log(`[Forge CLI] Initiating task ${taskId}...`);
  console.log(`Target Repo: ${targetRepo}`);

  const agent = new ForgeAgent(token);
  const report = await agent.executeTask({
    id: taskId,
    title: taskTitle,
    description: taskDesc,
    targetRepo,
    targetBranch: 'main',
    createdAt: new Date().toISOString(),
    author: 'github-actions-forge',
    allowPrCreation: Boolean(token),
  });

  console.log('--- FORGE EXECUTION REPORT ---');
  console.log('Status:', report.status);
  console.log('Base SHA:', report.baseCommitSha);
  console.log('Provider:', report.modelInvoked.provider);
  console.log('Model:', report.modelInvoked.model);
  console.log('Branch:', report.branchName ?? 'N/A');
  console.log('Head commit:', report.headCommitSha ?? 'N/A');
  console.log('Requirements:', report.requirements.length);
  console.log('Tests Run:', report.testResults.length);
  if (report.prUrl) console.log('PR Opened:', report.prUrl);
  if (report.errorMessage) console.log('Error:', report.errorMessage);
  if (report.blockerReason) console.log('Blocker:', report.blockerReason);

  // Early BLOCKED/FAILED returns inside executeTask may not pass through its normal finalizer.
  // Stamp the end time here so every persisted report has a complete execution window.
  report.endTime ||= new Date().toISOString();
  const evidenceDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, `${safeTaskId}.json`),
    JSON.stringify(report, null, 2)
  );

  if (report.status === 'FAILED' || report.status === 'BLOCKED') {
    process.exit(1);
  }
}

runCli().catch((err) => {
  console.error('[Forge CLI] Fatal unhandled error:', err);
  process.exit(1);
});
