/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskDefinition, TaskExecutionReport, FileChangePlan } from '../types/agent.ts';
import { GitHubService } from '../services/github.ts';
import { ModelService } from '../services/model.ts';
import { TestRunnerService } from '../services/test-runner.ts';
import * as fs from 'fs/promises';
import * as path from 'path';

// Sensitive / Protected repository paths that Forge is prohibited from altering
const PROTECTED_PATH_PATTERNS = [
  /^\.git\//i,
  /^\.env/i,
  /^\.github\/workflows\//i,
  /^node_modules\//i,
];

// Maximum allowed patch content size per file (100KB)
const MAX_FILE_PATCH_BYTES = 100 * 1024;

export class ForgeAgent {
  private github: GitHubService;
  private model: ModelService;
  private testRunner: TestRunnerService;

  constructor(githubToken?: string) {
    this.github = new GitHubService(githubToken);
    this.model = new ModelService();
    this.testRunner = new TestRunnerService();
  }

  /**
   * Strict validation of generated patch paths and contents (Fixes AUD-20261012-02 Patch Validation)
   */
  private validatePatch(changes: FileChangePlan[]): { valid: boolean; error?: string } {
    if (!Array.isArray(changes) || changes.length === 0) {
      return { valid: false, error: 'Empty patch: No file changes proposed.' };
    }

    for (const change of changes) {
      // 1. Path format validation (must be relative, no traversal)
      if (!change.path || typeof change.path !== 'string') {
        return { valid: false, error: 'Malformed patch: Missing or non-string file path.' };
      }
      const normalizedPath = path.normalize(change.path).replace(/^(\.\/)+/, '');
      if (path.isAbsolute(change.path) || normalizedPath.startsWith('..') || change.path.includes('../')) {
        return { valid: false, error: `Security Boundary Violation: Directory traversal or absolute path detected: "${change.path}".` };
      }

      // 2. Protected files check
      if (PROTECTED_PATH_PATTERNS.some((pat) => pat.test(normalizedPath))) {
        return { valid: false, error: `Security Boundary Violation: Modification of protected file or path is forbidden: "${change.path}".` };
      }

      // 3. Action and content check
      if (!['modify', 'create'].includes(change.action)) {
        return { valid: false, error: `Unsupported or dangerous patch action "${change.action}". Only create and modify are supported.` };
      }
      if (typeof change.content !== 'string' || change.content.length === 0) {
        return { valid: false, error: `Invalid patch content: "${change.path}" has empty or invalid content.` };
      }
      if (Buffer.byteLength(change.content, 'utf-8') > MAX_FILE_PATCH_BYTES) {
        return { valid: false, error: `Patch size limit exceeded: "${change.path}" exceeds 100KB limit.` };
      }
    }

    return { valid: true };
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

      // 3. READING PERSISTENT INSTRUCTIONS & TARGET CODE SCOPE
      log('info', 'Checking for persistent instructions in AGENTS.md');
      const agentsMdRemote = await this.github.fetchFile(owner, repo, 'AGENTS.md', repoInfo.defaultBranch);
      let instructionText = '';
      if (agentsMdRemote) {
        instructionText = agentsMdRemote.content;
        log('info', 'Loaded remote AGENTS.md instructions.');
      } else {
        try {
          instructionText = await fs.readFile(path.resolve(process.cwd(), 'AGENTS.md'), 'utf-8');
          log('info', 'Loaded local AGENTS.md instructions.');
        } catch {
          instructionText = 'Standard engineering instructions: inspect before editing, keep changes minimal.';
        }
      }

      // Read target repository file inventory
      log('info', 'Gathering repository file inventory for grounding');
      const repoFilePaths = await this.github.listRepositoryFiles(owner, repo, repoInfo.defaultBranch);
      log('info', `Found ${repoFilePaths.length} files in target repository tree.`);

      // Read the target repository's package manifest and bounded real source files.
      const packageJsonRemote = await this.github.fetchFile(owner, repo, 'package.json', repoInfo.defaultBranch);
      const packageJsonContent = packageJsonRemote?.content || '{}';
      const sourcePaths = repoFilePaths
        .filter((p) => /\\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/.test(p))
        .filter((p) => !p.startsWith('node_modules/') && !p.startsWith('dist/') && !p.startsWith('.git/'))
        .filter((p) => p !== 'package.json' && p !== 'AGENTS.md')
        .slice(0, 10);
      const sourceResults = await Promise.all(
        sourcePaths.map(async (p) => {
          const file = await this.github.fetchFile(owner, repo, p, repoInfo.defaultBranch);
          return file ? { path: file.path, content: file.content.slice(0, 16000) } : null;
        })
      );
      const targetSourceFiles = sourceResults.filter(
        (file): file is { path: string; content: string } => file !== null
      );

      // 4. PLANNING (MODEL INVOCATION)
      report.status = 'PLANNING';
      log('info', `Invoking model with target manifest and ${targetSourceFiles.length} actual target source files.`);

      const contextFiles = [
        { path: 'AGENTS.md', content: instructionText },
        { path: 'package.json', content: packageJsonContent },
        { path: 'FILE_TREE_INVENTORY.txt', content: repoFilePaths.slice(0, 100).join('\\n') },
        ...targetSourceFiles,
      ];

      report.modelInvoked.callsCount += 1;
      const modelResult = await this.model.generatePlanAndPatch(
        `Task: ${task.title}\nDetails: ${task.description}`,
        contextFiles
      );

      report.modelInvoked.provider = modelResult.provider;\n      report.modelInvoked.model = modelResult.model;\n      if (!modelResult.success) {
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
        content: ch.content,
      }));

      log('info', `Requirements matrix established with ${report.requirements.length} criteria.`);

      // 5. PATCH VALIDATION (Fix AUD-20261012-02 Patch Validation)
      const patchValidation = this.validatePatch(report.plannedChanges);
      if (!patchValidation.valid) {
        report.status = 'FAILED';
        report.errorMessage = `Patch Validation Rejected: ${patchValidation.error}`;
        log('error', report.errorMessage);
        return report;
      }
      log('info', `Patch validated successfully: ${report.plannedChanges.length} files pass security checks.`);

      // 6. TESTING / VERIFICATION
      report.status = 'TESTING';
      log('info', 'Running bounded verification checks against strict command registry.');

      // Default to strict safe check 'npm run lint'
      const checksToRun = ['npm run lint'];

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

      // Enforce fail-closed semantics: if no tests ran, fail closed
      if (report.testResults.length === 0) {
        report.status = 'FAILED';
        report.errorMessage = 'Verification failed: Zero tests were executed.';
        log('error', report.errorMessage);
        return report;
      }

      const allChecksPassed = report.testResults.every((r) => r.status === 'PASSED');
      report.requirements.forEach((req) => {
        req.status = allChecksPassed ? 'PASS' : 'FAIL';
        req.evidence = `Exit codes: ${report.testResults.map((r) => `${r.command}=${r.exitCode}`).join(', ')}`;
      });

      if (!allChecksPassed) {
        report.status = 'FAILED';
        report.errorMessage = 'One or more verification checks failed.';
        return report;
      }

      // 7. GITHUB BRANCH, COMMIT & PR CREATION
      report.status = 'VERIFYING';
      const branchName = `forge/task-${task.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
      report.branchName = branchName;

      // Extract validated files with content
      const filesToCommit = report.plannedChanges
        .filter((c) => c.content && typeof c.content === 'string')
        .map((c) => ({ path: c.path, content: c.content as string }));

      // Fix AUD-20261012-02 Empty PR prevention: fail closed if no file contents are committed
      if (filesToCommit.length === 0) {
        report.status = 'FAILED';
        report.errorMessage = 'Safety Block: Zero files with valid content to commit. Cannot open empty Pull Request.';
        log('error', report.errorMessage);
        return report;
      }

      if (!task.allowPrCreation) {
        log('info', 'Task verified locally. Pull Request creation not authorized by caller.');
        report.status = 'VERIFYING';
      } else {
        log('info', `Creating or updating isolated branch ${branchName} at base SHA ${report.baseCommitSha}...`);
        const branchRes = await this.github.createOrUpdateBranch(owner, repo, branchName, report.baseCommitSha);

        if (!branchRes.success) {
          log('warn', `Branch operation halted: ${branchRes.error}`);
          report.status = 'BLOCKED';
          report.blockerReason = `GitHub branch operation blocked: ${branchRes.error}`;
        } else {
          log('info', `Branch ${branchName} confirmed.`);

          // Commit the actual patch files to the branch with base tree SHA resolution
          log('info', `Committing ${filesToCommit.length} modified files to ${branchName}...`);
          const commitRes = await this.github.commitChangesToBranch({
            owner,
            repo,
            branchName,
            baseCommitSha: report.baseCommitSha,
            commitMessage: `[Forge] ${task.title}\n\nTask-ID: ${task.id}\nRequirements: ${report.requirements.map(r => r.id).join(', ')}`,
            files: filesToCommit,
          });

          if (commitRes.success && commitRes.headSha) {
            report.headCommitSha = commitRes.headSha;
            log('info', `Committed changes. Head SHA: ${report.headCommitSha}`);

            // Open Pull Request with genuine head and base
            log('info', 'Opening Pull Request on GitHub...');
            const prRes = await this.github.openPullRequest({
              owner,
              repo,
              title: `[Forge] ${task.title}`,
              head: branchName,
              base: repoInfo.defaultBranch,
              body: `### Forge Task Report: ${task.id}
- **Base Commit**: \`${report.baseCommitSha}\`
- **Head Commit**: \`${report.headCommitSha}\`
- **Branch**: \`${branchName}\`

#### Requirements Traceability
${report.requirements.map((r) => `- [x] **${r.id}**: ${r.description} (${r.status})`).join('\n')}

#### Verified Checks
${report.testResults.map((t) => `- \`${t.command}\`: Exit ${t.exitCode} (${t.status}) in ${t.durationMs}ms`).join('\n')}

#### Changed Files
${report.plannedChanges.map((c) => `- \`${c.path}\` (${c.action}): ${c.rationale}`).join('\n')}
`,
            });

            if (prRes.success) {
              report.status = 'PR_OPENED';
              report.prUrl = prRes.url;
              report.prNumber = prRes.number;
              log('info', `Pull Request opened: ${prRes.url}`);
            } else {
              report.status = 'BLOCKED';
              report.blockerReason = `PR opening blocked: ${prRes.error}`;
              log('warn', report.blockerReason);
            }
          } else {
            log('warn', `Commit failed: ${commitRes.error}`);
            report.status = 'BLOCKED';
            report.blockerReason = `Git commit blocked: ${commitRes.error}`;
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
