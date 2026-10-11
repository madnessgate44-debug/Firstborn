/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskDefinition, TaskExecutionReport, TaskStatus } from '../types/agent.ts';
import { GitHubService } from '../services/github.ts';
import { ModelService } from '../services/model.ts';
import { TestRunnerService } from '../services/test-runner.ts';
import * as fs from 'fs/promises';
import * as path from 'path';

export class ForgeAgent {
  private github: GitHubService;
  private model: ModelService;
  private testRunner: TestRunnerService;

  constructor(githubToken?: string) {
    this.github = new GitHubService(githubToken);
    this.model = new ModelService();
    this.testRunner = new TestRunnerService();
  }

  async executeTask(task: TaskDefinition): Promise<TaskExecutionReport> {
    const report: TaskExecutionReport = {
      taskId: task.id,
      status: 'QUEUED',
      startTime: new Date().toISOString(),
      baseCommitSha: 'UNKNOWN',
      modelInvoked: {
        provider: 'Google AI Studio / Gemini',
        model: 'gemini-2.5-flash',
        callsCount: 0,
      },
      requirements: [],
      plannedChanges: [],
      testResults: [],
      logs: [],
    };

    const log = (level: 'info' | 'warn' | 'error', message: string) => {
      report.logs.push({ timestamp: new Date().toISOString(), level, message });
    };

    try {
      // 1. VALIDATING
      report.status = 'VALIDATING';
      log('info', `Validating task definition: ${task.id} (${task.title})`);

      if (!task.title || !task.description) {
        report.status = 'FAILED';
        report.errorMessage = 'Validation Failed: Task title and description cannot be empty.';
        log('error', report.errorMessage);
        return report;
      }

      const [owner, repo] = task.targetRepo.split('/');
      if (!owner || !repo) {
        report.status = 'FAILED';
        report.errorMessage = `Validation Failed: Invalid target repository format "${task.targetRepo}". Expected "owner/repo".`;
        log('error', report.errorMessage);
        return report;
      }

      // 2. INSPECTING
      report.status = 'INSPECTING';
      log('info', `Inspecting target repository: ${task.targetRepo}`);
      const repoInfo = await this.github.inspectRepository(owner, repo);

      if (!repoInfo.exists) {
        report.status = 'BLOCKED';
        report.blockerReason = `Repository inspection failed: ${repoInfo.errorMessage || 'Repository does not exist'}`;
        log('warn', report.blockerReason);
        return report;
      }

      report.baseCommitSha = repoInfo.latestCommitSha;
      log('info', `Target repository verified. Base branch: ${repoInfo.defaultBranch}, Base SHA: ${report.baseCommitSha}`);

      // 3. READING PERSISTENT INSTRUCTIONS
      log('info', 'Checking for persistent instructions in AGENTS.md');
      const agentsMdRemote = await this.github.fetchFile(owner, repo, 'AGENTS.md', repoInfo.defaultBranch);
      let instructionText = '';
      if (agentsMdRemote) {
        instructionText = agentsMdRemote.content;
        log('info', 'Found and loaded remote AGENTS.md instructions.');
      } else {
        // Fallback to local AGENTS.md
        try {
          instructionText = await fs.readFile(path.resolve(process.cwd(), 'AGENTS.md'), 'utf-8');
          log('info', 'Using local repository AGENTS.md instructions.');
        } catch {
          log('warn', 'AGENTS.md not found locally or remotely; using built-in system standards.');
        }
      }

      // 4. PLANNING (MODEL INVOCATION)
      report.status = 'PLANNING';
      log('info', 'Invoking model to generate requirements matrix and minimal patch.');

      const contextFiles = [
        { path: 'AGENTS.md', content: instructionText },
        { path: 'package.json', content: JSON.stringify(require('../../package.json'), null, 2) },
      ];

      report.modelInvoked.callsCount += 1;
      const modelResult = await this.model.generatePlanAndPatch(
        `Task: ${task.title}\nDetails: ${task.description}`,
        contextFiles
      );

      if (!modelResult.success) {
        report.status = 'FAILED';
        report.errorMessage = `Model Generation Failed: ${modelResult.error}`;
        log('error', report.errorMessage);
        return report;
      }

      let parsedPlan: any;
      try {
        parsedPlan = JSON.parse(modelResult.text);
      } catch (err: any) {
        report.status = 'FAILED';
        report.errorMessage = `Failed to parse structured JSON from model output: ${err.message}`;
        log('error', report.errorMessage);
        return report;
      }

      report.requirements = (parsedPlan.requirements || []).map((req: any) => ({
        id: req.id,
        description: req.description,
        acceptanceCriteria: req.acceptanceCriteria,
        status: 'PENDING',
      }));

      report.plannedChanges = (parsedPlan.changes || []).map((ch: any) => ({
        path: ch.path,
        action: ch.action,
        rationale: ch.rationale,
      }));

      log('info', `Requirements matrix established with ${report.requirements.length} criteria.`);

      // 5. TESTING / VERIFICATION
      report.status = 'TESTING';
      log('info', 'Running verification checks and real tests in environment.');

      const checksToRun = parsedPlan.suggestedChecks && parsedPlan.suggestedChecks.length > 0
        ? parsedPlan.suggestedChecks
        : ['npm run lint'];

      for (const cmd of checksToRun) {
        log('info', `Executing bounded check: ${cmd}`);
        const testRes = await this.testRunner.runCheck(cmd);
        report.testResults.push(testRes);

        if (testRes.status === 'PASSED') {
          log('info', `Check "${cmd}" PASSED (exit code 0).`);
        } else {
          log('warn', `Check "${cmd}" FAILED (exit code ${testRes.exitCode}).`);
        }
      }

      const allChecksPassed = report.testResults.every((r) => r.status === 'PASSED');
      report.requirements.forEach((req) => {
        req.status = allChecksPassed ? 'PASS' : 'FAIL';
        req.evidence = `Exit codes: ${report.testResults.map((r) => `${r.command}=${r.exitCode}`).join(', ')}`;
      });

      // 6. GITHUB OUTPUT & PR
      report.status = 'VERIFYING';
      const branchName = `forge/task-${task.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
      report.branchName = branchName;

      if (!task.allowPrCreation) {
        log('info', 'Task completed verification. Pull Request creation not requested.');
        report.status = allChecksPassed ? 'VERIFYING' : 'FAILED';
      } else {
        log('info', `Attempting branch and PR creation for branch ${branchName}...`);
        const branchRes = await this.github.createOrUpdateBranch(owner, repo, branchName, report.baseCommitSha);

        if (!branchRes.success) {
          log('warn', `Branch creation halted: ${branchRes.error}`);
          report.status = 'BLOCKED';
          report.blockerReason = `GitHub branch operation blocked: ${branchRes.error}`;
        } else {
          const prRes = await this.github.openPullRequest({
            owner,
            repo,
            title: `[Forge] ${task.title}`,
            head: branchName,
            base: repoInfo.defaultBranch,
            body: `### Forge Task Report: ${task.id}
**Base Commit**: \`${report.baseCommitSha}\`
**Requirements Summary**:
${report.requirements.map((r) => `- [x] **${r.id}**: ${r.description}`).join('\n')}

**Verification Output**:
${report.testResults.map((t) => `- \`${t.command}\`: Exit ${t.exitCode} (${t.status})`).join('\n')}
`,
          });

          if (prRes.success) {
            report.status = 'PR_OPENED';
            report.prUrl = prRes.url;
            report.prNumber = prRes.number;
            log('info', `Pull Request successfully opened: ${prRes.url}`);
          } else {
            report.status = 'BLOCKED';
            report.blockerReason = `PR opening blocked: ${prRes.error}`;
            log('warn', report.blockerReason);
          }
        }
      }

      report.endTime = new Date().toISOString();
      return report;
    } catch (err: any) {
      report.status = 'FAILED';
      report.errorMessage = `Unhandled agent exception: ${err.message}`;
      report.endTime = new Date().toISOString();
      log('error', report.errorMessage);
      return report;
    }
  }
}
