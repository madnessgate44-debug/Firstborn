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
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
  private githubToken?: string;

  constructor(githubToken?: string) {
    this.githubToken = githubToken?.trim();
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
      const portablePath = change.path.replace(/\\/g, '/');
      const normalizedPath = path.posix.normalize(portablePath).replace(/^(\.\/)+/, '');
      if (path.isAbsolute(change.path) || portablePath.startsWith('/') || normalizedPath === '..' || normalizedPath.startsWith('../') || normalizedPath.includes('/../')) {
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
        .filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/.test(p))
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

      report.modelInvoked.provider = modelResult.provider;
      report.modelInvoked.model = modelResult.model;
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

      // 6. Apply the validated patch in an isolated checkout, then test that exact tree.
      report.status = 'TESTING';
      const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'firstborn-forge-'));
      const worktree = path.join(workRoot, 'target');
      try {
        const gitEnv: NodeJS.ProcessEnv = { ...process.env };
        delete gitEnv.GITHUB_TOKEN;
        delete gitEnv.GEMINI_API_KEY;
        delete gitEnv.GH_TOKEN;
        if (this.githubToken) {
          gitEnv.GIT_CONFIG_COUNT = '1';
          gitEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
          gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.githubToken}`).toString('base64')}`;
        }
        log('info', `Cloning target branch ${repoInfo.defaultBranch} into an isolated temporary worktree.`);
        await execFileAsync('git', ['clone', '--depth', '1', '--branch', repoInfo.defaultBranch, `https://github.com/${owner}/${repo}.git`, worktree], {
          env: gitEnv,
          timeout: 120000,
          maxBuffer: 2 * 1024 * 1024,
        });
        const { stdout: checkedOutSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree, timeout: 15000 });
        if (checkedOutSha.trim() !== report.baseCommitSha) {
          report.status = 'BLOCKED';
          report.blockerReason = `Target branch moved during inspection (expected ${report.baseCommitSha}, cloned ${checkedOutSha.trim()}). Retry against the new base.`;
          log('warn', report.blockerReason);
          return report;
        }

        for (const change of report.plannedChanges) {
          const portablePath = change.path.replace(/\\/g, '/');
          const normalizedPath = path.posix.normalize(portablePath).replace(/^(\.\/)+/, '');
          const absolutePath = path.resolve(worktree, normalizedPath);
          if (!absolutePath.startsWith(worktree + path.sep)) {
            throw new Error(`Patch path escaped the isolated worktree: ${change.path}`);
          }
          const exists = await fs.access(absolutePath).then(() => true).catch(() => false);
          if (change.action === 'create' && exists) throw new Error(`Patch marked existing file as create: ${change.path}`);
          if (change.action === 'modify' && !exists) throw new Error(`Patch marked missing file as modify: ${change.path}`);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, change.content as string, 'utf-8');
        }

        const packagePath = path.join(worktree, 'package.json');
        let scripts: Record<string, string> = {};
        try {
          const targetPackage = JSON.parse(await fs.readFile(packagePath, 'utf-8'));
          scripts = targetPackage.scripts || {};
        } catch {
          // Non-Node repositories are not assumed to have npm checks.
        }

        const checksToRun: string[] = [];
        if (Object.keys(scripts).length > 0) {
          const install = await this.testRunner.runCheck('npm install', worktree);
          report.testResults.push(install);
          if (install.status !== 'PASSED') {
            report.status = 'FAILED';
            report.errorMessage = `Target dependency installation failed (exit ${install.exitCode}).`;
            log('error', report.errorMessage);
            return report;
          }
          for (const command of ['npm run lint', 'npm test', 'npm run build']) {
            const scriptName = command === 'npm test' ? 'test' : command.slice('npm run '.length);
            if (scripts[scriptName]) checksToRun.push(command);
          }
        }
        const substantiveChecks = checksToRun.filter((cmd) => cmd !== 'git diff --check');
        if (substantiveChecks.length === 0) {
          report.status = 'BLOCKED';
          report.blockerReason = 'No recognized target-project test, lint, or build script exists; whitespace validation alone is not sufficient to authorize a coding PR.';
          log('warn', report.blockerReason);
          return report;
        }
        checksToRun.push('git diff --check');
        for (const cmd of checksToRun) {
          log('info', `Testing proposed patch in target worktree: ${cmd}`);
          const result = await this.testRunner.runCheck(cmd, worktree);
          report.testResults.push(result);
          log(result.status === 'PASSED' ? 'info' : 'warn', `Target check "${cmd}" exit=${result.exitCode} status=${result.status}`);
        }

        const allChecksPassed = report.testResults.length > 0 && report.testResults.every((r) => r.status === 'PASSED');
        if (!allChecksPassed) {
          report.status = 'FAILED';
          report.errorMessage = 'One or more checks failed in the isolated target worktree after applying the proposed patch.';
          return report;
        }

        // Generic repository checks do not prove every requirement individually.
        report.requirements.forEach((req) => {
          req.status = 'PENDING';
          req.evidence = `Target-tree checks passed: ${report.testResults.map((r) => `${r.command}=${r.exitCode}`).join(', ')}. Criterion-specific proof still requires review.`;
        });
      } finally {
        await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
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
${report.requirements.map((r) => `- [ ] **${r.id}**: ${r.description} (${r.status}; criterion-specific proof pending)`).join('\n')}

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
