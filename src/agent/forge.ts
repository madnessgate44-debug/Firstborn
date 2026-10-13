/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskDefinition, TaskExecutionReport, FileChangePlan, RequirementEvidenceInput } from '../types/agent.ts';
import { GitHubService } from '../services/github.ts';
import { ModelService } from '../services/model.ts';
import { TestRunnerService } from '../services/test-runner.ts';
import { loadForgeLimits } from './limits.ts';
import { applyExactEdits } from './stages.ts';
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
  /^\.github\//i,
  /^node_modules\//i,
  // Files executed by target checks must not be model-editable.
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)npm-shrinkwrap\.json$/i,
  /(^|\/)\.npmrc$/i,
  /^vite\.config\.[cm]?[jt]s$/i,
  /^tsconfig[^/]*\.json$/i,
  /^scripts\//i,
];

// Keep the total source context bounded for anonymous models with small context windows.
const MAX_SOURCE_CONTEXT_CHARS = 24000;

// Anonymous models sometimes wrap otherwise valid JSON in Markdown fences.
// Normalize only that wrapper; JSON.parse remains the strict structural validator.
function parseModelJson(text: string): any {
  let normalized = text.trim();
  if (normalized.startsWith('```')) {
    const firstLineEnd = normalized.indexOf('\n');
    if (firstLineEnd >= 0) normalized = normalized.slice(firstLineEnd + 1);
    const trimmedEnd = normalized.trimEnd();
    if (trimmedEnd.endsWith('```')) normalized = trimmedEnd.slice(0, -3);
    normalized = normalized.trim();
  }
  if (!isStructurallyBalanced(normalized)) {
    throw new Error('Model output is structurally truncated: unbalanced JSON braces or brackets (output limit reached).');
  }
  return JSON.parse(normalized);
}

/**
 * Detect truncation deterministically: scan the text ignoring string contents and
 * require every brace/bracket to close. A model that hits its output ceiling leaves
 * the JSON open, which JSON.parse reports only as an obscure "Unterminated string".
 */
export function isStructurallyBalanced(text: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  const pairs: Record<string, string> = { '}': '{', ']': '[' };
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== pairs[char]) return false;
    }
  }
  return stack.length === 0 && !inString;
}

// A complete, compilable source file is always bracket-balanced. If applying an
// edit yields unbalanced braces/parens/brackets, the edit almost certainly used a
// partial or malformed anchor (for example replacing "foo() {" with "foo() ;"),
// which produces a syntax error the model must fix rather than us committing.
export function isCodeBalanced(text: string): boolean {
  let depth = 0;
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; i += 1; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth < 0) return false;
    }
    i += 1;
  }
  return depth === 0;
}

// A task description that names a file only in order to FORBID changing it
// ("do not modify X", "leave X untouched") must not be treated as an explicit
// edit request. Treating it as one made Forge hard-block on unrelated size limits.
export function isForbiddenReference(taskText: string, candidate: string): boolean {
  const idx = taskText.indexOf(candidate);
  if (idx < 0) return false;
  const window = taskText.slice(Math.max(0, idx - 60), idx + candidate.length + 40).toLowerCase();
  const prefix = /(do not modify|don't modify|do not change|do not touch|must not (modify|change|touch)|without (modifying|changing|touching))\s*$/.test(
    taskText.slice(Math.max(0, idx - 60), idx).toLowerCase()
  );
  const wrapped = /(leave|keep|hold)[\s\S]{0,60}?(untouched|unchanged|intact|as-is|as is)/.test(window);
  return prefix || wrapped;
}

// --- R6 resilience primitives -------------------------------------------------

export type FailureClass = 'RETRYABLE' | 'FATAL';

/**
 * Classify a runtime failure so callers can retry transient conditions and stop
 * on permanent ones. Deterministic and pure so it is unit-testable.
 */
export function classifyFailure(error: unknown): FailureClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const status = (error as { status?: number })?.status;
  if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500)) return 'RETRYABLE';
  if (/abort|timeout|timed out|econnreset|enotfound|socket hang up|fetch failed|rate limit|429|5\d\d/.test(message)) {
    return 'RETRYABLE';
  }
  return 'FATAL';
}

export interface BoundedRetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected sleep so tests never wait on wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Run an async operation with bounded retries and exponential backoff. Never
 * loops unbounded, never retries a fatal classification, and reports the exact
 * number of attempts so the caller can log truthful evidence.
 */
export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: BoundedRetryOptions
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number }> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retryable = options.isRetryable ?? ((error: unknown) => classifyFailure(error) === 'RETRYABLE');

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, value: await operation(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryable(error)) {
        return { ok: false, error, attempts: attempt };
      }
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  return { ok: false, error: lastError, attempts };
}

export interface ModelPlanShapeCheck {
  ok: boolean;
  error?: string;
  requirements: { id: string; description: string; acceptanceCriteria: string; checkCommands?: string[]; manualReviewNote?: string }[];
  changes: FileChangePlan[];
}

/**
 * Deterministically validate and normalize a raw model plan. Malformed shapes
 * are reported as structured errors instead of throwing deep in the mapper, so
 * a single bad field cannot silently corrupt the report.
 */
export function validateModelPlanShape(raw: unknown): ModelPlanShapeCheck {
  const empty: ModelPlanShapeCheck = { ok: true, requirements: [], changes: [] };
  if (!raw || typeof raw !== 'object') {
    return { ...empty, ok: false, error: 'Model plan was not a JSON object.' };
  }
  const plan = raw as Record<string, unknown>;

  if (plan.requirements !== undefined && !Array.isArray(plan.requirements)) {
    return { ...empty, ok: false, error: 'Model plan "requirements" must be an array when present.' };
  }
  if (plan.changes !== undefined && !Array.isArray(plan.changes)) {
    return { ...empty, ok: false, error: 'Model plan "changes" must be an array when present.' };
  }

  const requirements = (plan.requirements ?? []).map((req, index) => {
    const item = (req ?? {}) as Record<string, unknown>;
    return {
      id: typeof item.id === 'string' && item.id ? item.id : `REQ-${index + 1}`,
      description: typeof item.description === 'string' ? item.description : '',
      acceptanceCriteria: typeof item.acceptanceCriteria === 'string' ? item.acceptanceCriteria : '',
      checkCommands: Array.isArray(item.checkCommands)
        ? item.checkCommands.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : undefined,
      manualReviewNote: typeof item.manualReviewNote === 'string' ? item.manualReviewNote : undefined,
    };
  });

  const changes: FileChangePlan[] = [];
  for (const change of (plan.changes ?? []) as unknown[]) {
    const item = (change ?? {}) as Record<string, unknown>;
    if (typeof item.path !== 'string' || item.path.length === 0) {
      return { ...empty, ok: false, error: 'A change is missing a "path".' };
    }
    if (!['create', 'modify', 'delete'].includes(String(item.action))) {
      return { ...empty, ok: false, error: `Change "${item.path}" has an invalid action "${String(item.action)}".` };
    }
    if (item.edits !== undefined && !Array.isArray(item.edits)) {
      return { ...empty, ok: false, error: `Change "${item.path}" has non-array edits.` };
    }
    changes.push({
      path: item.path,
      action: item.action as FileChangePlan['action'],
      rationale: typeof item.rationale === 'string' ? item.rationale : '',
      content: typeof item.content === 'string' ? item.content : undefined,
      edits: Array.isArray(item.edits)
        ? (item.edits as { find: string; replace: string }[])
        : undefined,
    });
  }

  // Models sometimes emit several entries for the same file (for example one edit
  // per requirement). Merge same-path, same-action entries deterministically so a
  // legitimate multi-edit plan is not rejected as ambiguous, while a genuine
  // action conflict still fails closed.
  const mergedByPath = new Map<string, FileChangePlan>();
  for (const change of changes) {
    const existing = mergedByPath.get(change.path);
    if (!existing) {
      mergedByPath.set(change.path, change);
      continue;
    }
    if (existing.action !== change.action) {
      return { ...empty, ok: false, error: `Change "${change.path}" has conflicting actions "${existing.action}" and "${change.action}".` };
    }
    if (typeof existing.content === 'string' && typeof change.content === 'string' && existing.content !== change.content) {
      return { ...empty, ok: false, error: `Change "${change.path}" supplies two different full contents.` };
    }
    const mergedEdits = [...(existing.edits ?? []), ...(change.edits ?? [])];
    mergedByPath.set(change.path, {
      ...existing,
      content: existing.content ?? change.content,
      edits: mergedEdits.length > 0 ? mergedEdits : undefined,
    });
  }

  return { ok: true, requirements, changes: [...mergedByPath.values()] };
}

// Requested branch wins only when it is explicit and not the default; invalid
// branches are resolved later (and fail closed) by the caller.
export function resolveTargetBranch(requested: string | undefined, defaultBranch: string): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed !== defaultBranch ? trimmed : defaultBranch;
}

// A requirement is only PASS when a check named in its own acceptance criteria,
// description, or explicit checkCommands actually passed. Unrelated green checks
// cannot satisfy it, and a named-but-failing check yields FAIL, never PASS.
export function evaluateRequirementEvidence(
  requirement: RequirementEvidenceInput,
  results: { command: string; status: string; exitCode: number }[]
): { status: 'PASS' | 'PENDING' | 'FAIL'; evidence: string } {
  const attemptEvidence = results.map((result) => `${result.command}=${result.exitCode}`).join(', ');
  const criterion = `${requirement.acceptanceCriteria ?? ''} ${requirement.description ?? ''}`.toLowerCase();

  const matchesCommand = (command: string): boolean => {
    const lower = command.toLowerCase();
    const scriptName = lower === 'npm test' ? 'test' : lower.replace(/^npm run /, '');
    return criterion.includes(lower) || criterion.includes(scriptName);
  };

  const explicit = (requirement.checkCommands ?? []).map((c) => c.toLowerCase());
  const referencedChecks = results.filter((result) => {
    const lower = result.command.toLowerCase();
    return explicit.includes(lower) || matchesCommand(result.command);
  });

  const failed = referencedChecks.filter((result) => result.status !== 'PASSED');
  if (failed.length > 0) {
    return {
      status: 'FAIL',
      evidence: `Criterion-named check failed: ${failed.map((result) => `${result.command}=${result.exitCode}`).join(', ')}.`,
    };
  }
  if (referencedChecks.length > 0) {
    return {
      status: 'PASS',
      evidence: `Criterion-matched checks passed: ${referencedChecks.map((result) => `${result.command}=${result.exitCode}`).join(', ')}.`,
    };
  }
  const manual = requirement.manualReviewNote ? ` Manual review: ${requirement.manualReviewNote}.` : ' Manual review required.';
  return {
    status: 'PENDING',
    evidence: `No criterion-specific passing check was identified. Latest target-check attempt: ${attemptEvidence}.${manual}`,
  };
}

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
    const limits = loadForgeLimits();
    if (!Array.isArray(changes) || changes.length === 0) {
      return { valid: false, error: 'Empty patch: No file changes proposed.' };
    }
    if (changes.length > limits.maxFilesPerMission) {
      return { valid: false, error: `Patch exceeds the configured file ceiling: ${changes.length} > ${limits.maxFilesPerMission}.` };
    }
    const totalEdits = changes.reduce((sum, change) => sum + (Array.isArray(change.edits) ? change.edits.length : 0), 0);
    if (totalEdits > limits.maxEditsPerMission) {
      return { valid: false, error: `Patch exceeds the configured edit ceiling: ${totalEdits} > ${limits.maxEditsPerMission}.` };
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
      change.path = normalizedPath; // commit exactly the path that was tested

      // 3. Action and content check
      if (!['modify', 'create'].includes(change.action)) {
        return { valid: false, error: `Unsupported or dangerous patch action "${change.action}". Only create and modify are supported.` };
      }
      const hasContent = typeof change.content === 'string' && change.content.length > 0;
      const hasEdits = Array.isArray(change.edits) && change.edits.length > 0
        && change.edits.every((edit) => edit && typeof edit.find === 'string' && edit.find.length > 0 && typeof edit.replace === 'string');
      if ((change.action === 'create' && !hasContent) || (change.action === 'modify' && !hasContent && !hasEdits)) {
        return { valid: false, error: `Invalid patch: "${change.path}" needs complete content for create or valid exact edits for modify.` };
      }
      const patchSize = hasContent ? Buffer.byteLength(change.content as string, 'utf-8') : Buffer.byteLength(JSON.stringify(change.edits ?? []), 'utf-8');
      if (patchSize > loadForgeLimits().maxPatchBytes) {
        return { valid: false, error: `Patch size limit exceeded: "${change.path}" exceeds the configured per-file patch limit.` };
      }
    }

    return { valid: true };
  }

  private findEditAnchorProblems(
    changes: FileChangePlan[],
    contextFiles: { path: string; content: string }[]
  ): string[] {
    const sourceByPath = new Map(contextFiles.map((file) => [file.path, file.content]));
    const problems: string[] = [];

    for (const change of changes) {
      if (change.action !== 'modify' || !Array.isArray(change.edits) || change.edits.length === 0) continue;
      const source = sourceByPath.get(change.path);
      if (typeof source !== 'string') {
        problems.push(`${change.path}: source content was not supplied to validate the edit anchors.`);
        continue;
      }
      const result = applyExactEdits(source, change.edits);
      if (!result.ok) {
        problems.push(`${change.path}: ${result.error}`);
        continue;
      }
      if (!isCodeBalanced(result.content)) {
        problems.push(`${change.path}: applying the edits leaves unbalanced braces/parentheses (likely a partial or broken anchor).`);
      }
    }
    return problems;
  }


  /**
   * Deterministically reconstruct the final content of every file the patch
   * touches, by applying its exact edits to the source snapshot that was supplied
   * to the model. This is the single source of truth for both the tested worktree
   * and the committed files, so the two can never diverge.
   */
  private async stageFinalContents(
    changes: FileChangePlan[],
    contextFiles: { path: string; content: string }[]
  ): Promise<{ ok: boolean; files: FileChangePlan[]; error?: string }> {
    const sourceByPath = new Map(contextFiles.map((file) => [file.path, file.content]));
    const files: FileChangePlan[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      if (seen.has(change.path)) {
        return { ok: false, files, error: `Duplicate change for path "${change.path}"; refusing ambiguous commit.` };
      }
      seen.add(change.path);
      const hasContent = typeof change.content === 'string' && change.content.length > 0;
      const hasEdits = Array.isArray(change.edits) && change.edits.length > 0;
      if (hasContent && !hasEdits) {
        if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(change.path) && !isCodeBalanced(change.content as string)) {
          return { ok: false, files, error: `Full content for "${change.path}" is not syntactically balanced; refusing a broken file.` };
        }
        files.push({ ...change, edits: undefined });
        continue;
      }
      if (hasEdits) {
        const source = sourceByPath.get(change.path);
        if (typeof source !== 'string') {
          return { ok: false, files, error: `No supplied source content to apply exact edits for "${change.path}".` };
        }
        const applied = applyExactEdits(source, change.edits as { find: string; replace: string }[]);
        if (!applied.ok) {
          return { ok: false, files, error: `Exact edit rejected in "${change.path}": ${applied.error}` };
        }
        if (!isCodeBalanced(applied.content)) {
          return { ok: false, files, error: `Exact edit for "${change.path}" leaves unbalanced braces/parentheses; refusing a syntactically broken file.` };
        }
        files.push({ ...change, content: applied.content, edits: undefined });
        continue;
      }
      return { ok: false, files, error: `Change for "${change.path}" has neither content nor edits.` };
    }
    return { ok: true, files };
  }

  /**
   * Write already-staged final file contents into the isolated worktree. Path,
   * symlink, and escape checks are identical to applyChangesToWorktree so the
   * committed tree is byte-for-byte the tested tree.
   */
  private async applyFinalContentsToWorktree(worktree: string, files: FileChangePlan[]): Promise<void> {
    for (const change of files) {
      const portablePath = change.path.replace(/\\/g, '/');
      const normalizedPath = path.posix.normalize(portablePath).replace(/^(\.\/)+/, '');
      const absolutePath = path.resolve(worktree, normalizedPath);
      if (!absolutePath.startsWith(worktree + path.sep)) {
        throw new Error(`Patch path escaped the isolated worktree: ${change.path}`);
      }
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const worktreeRealPath = await fs.realpath(worktree);
      const parentRealPath = await fs.realpath(path.dirname(absolutePath));
      if (parentRealPath !== worktreeRealPath && !parentRealPath.startsWith(worktreeRealPath + path.sep)) {
        throw new Error(`BLOCKED: patch target parent resolves outside the worktree: ${change.path}`);
      }
      let targetStat;
      try { targetStat = await fs.lstat(absolutePath); } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      if (targetStat?.isSymbolicLink()) throw new Error(`BLOCKED: refusing to patch symlink: ${change.path}`);
      if (targetStat) {
        const targetRealPath = await fs.realpath(absolutePath);
        if (targetRealPath !== worktreeRealPath && !targetRealPath.startsWith(worktreeRealPath + path.sep)) {
          throw new Error(`BLOCKED: patch target resolves outside the worktree: ${change.path}`);
        }
      }
      if (change.action === 'create' && targetStat) throw new Error(`Patch marked existing file as create: ${change.path}`);
      if (change.action === 'modify' && !targetStat) throw new Error(`Patch marked missing file as modify: ${change.path}`);
      await fs.writeFile(absolutePath, change.content as string, 'utf-8');
    }
  }

  async executeTask(task: TaskDefinition): Promise<TaskExecutionReport> {
    const report: TaskExecutionReport = {
      taskId: task.id,
      status: 'QUEUED',
      startTime: new Date().toISOString(),
      baseCommitSha: 'UNKNOWN',
      modelInvoked: {
        provider: process.env.FIRSTBORN_KEYLESS_ONLY === 'true' ? 'keyless router (not yet selected)' : 'not selected',
        model: 'not-selected',
        callsCount: 0,
        fallbackUsed: false,
        keylessRouteErrors: [],
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

      // Honor an explicitly requested target branch; fall back to the repository default.
      const targetBranch = resolveTargetBranch(task.targetBranch, repoInfo.defaultBranch);
      if (targetBranch !== repoInfo.defaultBranch) {
        const branchSha = await this.github.fetchBranchHeadSha(owner, repo, targetBranch);
        if (!branchSha) {
          report.status = 'BLOCKED';
          report.blockerReason = `Requested target branch "${targetBranch}" could not be resolved in ${owner}/${repo}.`;
          log('warn', report.blockerReason);
          return report;
        }
        report.baseCommitSha = branchSha;
        log('info', `Using explicitly requested target branch "${targetBranch}" at SHA ${branchSha}.`);
      }

      // 3. READING PERSISTENT INSTRUCTIONS & TARGET CODE SCOPE
      log('info', 'Checking for persistent instructions in AGENTS.md');
      const agentsMdRemote = await this.github.fetchFile(owner, repo, 'AGENTS.md', targetBranch);
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
      const repoFilePaths = await this.github.listRepositoryFiles(owner, repo, targetBranch);
      log('info', `Found ${repoFilePaths.length} files in target repository tree.`);

      // Read the target repository's package manifest and bounded real source files.
      const packageJsonRemote = await this.github.fetchFile(owner, repo, 'package.json', targetBranch);
      const packageJsonContent = packageJsonRemote?.content || '{}';
      const taskText = `${task.title} ${task.description}`;
      const taskTerms = taskText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 2);
      const explicitPaths = Array.from(
        taskText.matchAll(/((?:src|scripts|\.github|docs)\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml))/g),
        (match) => match[1]
      ).filter((candidate, index, all) => all.indexOf(candidate) === index && repoFilePaths.includes(candidate))
        .filter((candidate) => !isForbiddenReference(taskText, candidate));
      const eligibleSourcePaths = repoFilePaths
        .filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/.test(p))
        .filter((p) => !p.startsWith('node_modules/') && !p.startsWith('dist/') && !p.startsWith('.git/'))
        .filter((p) => p !== 'package.json' && p !== 'AGENTS.md');
      // Exact user-named paths are authoritative. For inferred context, skip oversized files
      // and continue searching so an unrelated large file cannot block the whole mission.
      const sourceCandidates = (explicitPaths.length > 0 ? explicitPaths.slice(0, 5) : eligibleSourcePaths
        .sort((a, b) => {
          const score = (candidate: string) => {
            const lower = candidate.toLowerCase();
            return taskTerms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
          };
          return score(b) - score(a) || a.localeCompare(b);
        }));
      const targetSourceFiles: { path: string; content: string }[] = [];
      for (const candidate of sourceCandidates) {
        if (targetSourceFiles.length >= 5) break;
        const file = await this.github.fetchFile(owner, repo, candidate, targetBranch);
        if (!file) {
          log('warn', `Could not fetch candidate source file; skipping: ${candidate}`);
          continue;
        }
        if (file.content.length > 16000) {
          const reason = `source file exceeds 16000 characters: ${file.path}`;
          if (explicitPaths.length > 0) {
            report.status = 'BLOCKED';
            report.blockerReason = `Explicitly requested ${reason}; refusing to guess or patch an incomplete context.`;
            log('warn', report.blockerReason);
            return report;
          }
          log('warn', `Skipping inferred ${reason} and continuing source selection.`);
          continue;
        }
        const contextChars = targetSourceFiles.reduce((total, source) => total + source.content.length, 0);
        if (contextChars + file.content.length > MAX_SOURCE_CONTEXT_CHARS) {
          const reason = `adding ${file.path} would exceed the ${MAX_SOURCE_CONTEXT_CHARS}-character total source-context budget`;
          if (explicitPaths.length > 0) {
            report.status = 'BLOCKED';
            report.blockerReason = `Explicit source context is too large: ${reason}.`;
            log('warn', report.blockerReason);
            return report;
          }
          log('warn', `Skipping inferred source file because ${reason}.`);
          continue;
        }
        targetSourceFiles.push({ path: file.path, content: file.content });
      }
      if (targetSourceFiles.length === 0) {
        report.status = 'BLOCKED';
        report.blockerReason = explicitPaths.length > 0
          ? 'None of the explicitly requested source files could be safely loaded.'
          : 'No eligible source files under the 16000-character context limit could be loaded.';
        log('warn', report.blockerReason);
        return report;
      }

      // 4. PLANNING (MODEL INVOCATION)
      report.status = 'PLANNING';
      log('info', `Invoking model with target manifest and ${targetSourceFiles.length} actual target source files.`);

      const contextFiles = [
        { path: 'AGENTS.md', content: instructionText },
        { path: 'package.json', content: packageJsonContent },
        { path: 'FILE_TREE_INVENTORY.txt', content: repoFilePaths.slice(0, 100).join('\n') },
        ...targetSourceFiles,
      ];

      const maxModelCalls = loadForgeLimits().maxModelCalls;
      const maxRepairs = loadForgeLimits().maxRepairAttempts;
      const guardModelCall = (label: string): boolean => {
        if (report.modelInvoked.callsCount >= maxModelCalls) {
          report.status = 'BLOCKED';
          report.blockerReason = `Model-call ceiling reached (${maxModelCalls}); stopping safely before ${label}.`;
          log('warn', report.blockerReason);
          return false;
        }
        return true;
      };
      const recordModel = (result: { provider: string; model: string; fallbackUsed?: boolean; keylessRouteErrors?: string[] }) => {
        report.modelInvoked.provider = result.provider;
        report.modelInvoked.model = result.model;
        report.modelInvoked.fallbackUsed = result.fallbackUsed ?? false;
        report.modelInvoked.keylessRouteErrors = [
          ...(report.modelInvoked.keylessRouteErrors ?? []),
          ...(result.keylessRouteErrors ?? []),
        ];
      };
      const focusContext = (requiredPath: string) =>
        contextFiles.filter((file) =>
          file.path === requiredPath || file.path === 'AGENTS.md' || file.path === 'package.json' || file.path === 'FILE_TREE_INVENTORY.txt'
        );
      // The context handed to the model must reflect edits already made this mission,
      // exactly like a developer reading the file after their last change. Without
      // this, a later file is written against a stale snapshot of its dependencies.
      const stagedByPath = new Map<string, string>();
      const stageOne = async (change: FileChangePlan): Promise<void> => {
        const result = await this.stageFinalContents([change], contextFiles);
        if (result.ok && result.files[0] && typeof result.files[0].content === 'string') {
          stagedByPath.set(change.path, result.files[0].content);
        }
      };
      const evolvingContext = (requiredPath: string) =>
        focusContext(requiredPath).map((file) =>
          stagedByPath.has(file.path) ? { ...file, content: stagedByPath.get(file.path) as string } : file
        );

      // 4. PLANNING — PER-FILE BOUNDED EXECUTION
      // Forge works the way a careful engineer does: capture the requirements once,
      // then implement one required file per model call so no single output must fit
      // the whole mission inside the anonymous endpoint's small output ceiling.
      report.modelInvoked.callsCount += 1;
      let modelResult = await this.model.generatePlanAndPatch(
        `Task: ${task.title}\nDetails: ${task.description}`,
        contextFiles
      );
      if (!modelResult.success && classifyFailure(modelResult.error) === 'RETRYABLE') {
        log('warn', `Model route reported a retryable failure; one bounded retry. Detail: ${modelResult.error}`);
        const retry = await withBoundedRetry(
          () => this.model.generatePlanAndPatch(`Task: ${task.title}\nDetails: ${task.description}`, contextFiles),
          { attempts: loadForgeLimits().modelAttempts, baseDelayMs: 500 }
        );
        report.modelInvoked.callsCount += retry.attempts;
        if (retry.ok) modelResult = retry.value;
      }
      recordModel(modelResult);
      if (!modelResult.success) {
        report.status = 'FAILED';
        report.errorMessage = `Model Generation Failed: ${modelResult.error}`;
        log('error', report.errorMessage);
        return report;
      }

      // The bootstrap plan may come back truncated or malformed on a small-output
      // endpoint. Retry a bounded number of times, then fall back to implementing
      // the explicitly named files directly so planning cannot abort the mission
      // before the per-file engine ever runs.
      const planAttempts = loadForgeLimits().modelAttempts + 2;
      let bootShape: ReturnType<typeof validateModelPlanShape> | undefined;
      for (let planAttempt = 0; planAttempt < planAttempts; planAttempt += 1) {
        if (planAttempt > 0) {
          if (!guardModelCall(`planning retry ${planAttempt + 1}/${planAttempts}`)) return report;
          report.modelInvoked.callsCount += 1;
          modelResult = await this.model.generatePlanAndPatch(
            `Task: ${task.title}\nDetails: ${task.description}\n\nReturn a compact JSON plan with a "requirements" array (each with id, description, acceptanceCriteria using an existing repo check such as "npm run lint" or "npm test") and a "changes" array (may be empty; the implementation will be produced per file afterwards). Keep the JSON small and complete.`,
            contextFiles
          );
          recordModel(modelResult);
          if (!modelResult.success) continue;
        }
        try {
          bootShape = validateModelPlanShape(parseModelJson(modelResult.text));
        } catch (err: any) {
          log('warn', `Bootstrap plan attempt ${planAttempt + 1} was not valid JSON (${err.message}); retrying if budget remains.`);
          bootShape = undefined;
        }
        if (bootShape?.ok && bootShape.requirements.length > 0) break;
        bootShape = undefined;
      }
      const fallbackPaths = explicitPaths.filter((p) => !p.endsWith('.md') && !p.endsWith('.json'));
      if (!bootShape || !bootShape.ok) {
        if (fallbackPaths.length === 0) {
          report.status = 'FAILED';
          report.errorMessage = 'Bootstrap planning produced no valid requirements and no explicit files to fall back to.';
          log('error', report.errorMessage);
          return report;
        }
        log('warn', 'Bootstrap planning exhausted its bounded retries; falling back to per-file implementation of the explicitly named files.');
        report.requirements = fallbackPaths.map((p, index) => ({
          id: `REQ-${index + 1}`,
          description: `Implement the requested change in ${p}.`,
          acceptanceCriteria: 'npm run lint',
          status: 'PENDING' as const,
        }));
      } else {
        report.requirements = bootShape.requirements.map((req) => ({ ...req, status: 'PENDING' as const }));
        report.plannedChanges = bootShape.changes;
      }
      if (!bootShape || !bootShape.ok) report.plannedChanges = [];

      // Drop any change whose exact anchors do not validate against the supplied
      // source so the file can be re-implemented cleanly in the per-file loop.
      const bootAnchorProblems = new Set(
        this.findEditAnchorProblems(report.plannedChanges, contextFiles).map((problem) => problem.split(':')[0])
      );
      if (bootAnchorProblems.size > 0) {
        log('warn', `Dropping ${bootAnchorProblems.size} change(s) with invalid anchors for per-file re-implementation.`);
        report.plannedChanges = report.plannedChanges.filter((change) => !bootAnchorProblems.has(change.path));
      }
      for (const change of report.plannedChanges) {
        await stageOne(change);
      }

      // 4b. PER-FILE COMPLETION — one bounded, retried model call per required file.
      const filesToImplement = [...explicitPaths.filter((p) => !p.endsWith('.md') && !p.endsWith('.json'))]
        .sort((a, b) => (a.endsWith('/types.ts') || a.endsWith('types.ts') ? -1 : 0) - (b.endsWith('/types.ts') || b.endsWith('types.ts') ? -1 : 0));
      for (const requiredPath of filesToImplement) {
        if (report.plannedChanges.some((change) => change.path === requiredPath)) continue;
        if (!guardModelCall(`implementation of ${requiredPath}`)) return report;
        let added = false;
        let lastProblem = 'model produced no change for this file';
        for (let fileAttempt = 0; fileAttempt < maxRepairs && !added; fileAttempt += 1) {
          // On the last attempt, allow a complete rewrite of this one file. Anchored
          // edits are safer, but a rewrite lets Forge recover from repeated partial or
          // malformed anchors instead of giving up, exactly like a developer would.
          const rewriteMode = fileAttempt === maxRepairs - 1;
          const editInstruction = rewriteMode
            ? `Return a compact JSON plan with action "modify" for ${requiredPath} and a complete "content" string containing the ENTIRE corrected file (every line, all existing members preserved). Do not return edits. Do not modify any other file. The file must compile as valid TypeScript.`
            : `Return a compact JSON plan containing ONLY the change(s) for ${requiredPath}. The action MUST be "modify" and MUST use exact-anchor "edits" copied verbatim from the supplied source; never return whole-file content for an existing file. Every find string must occur exactly once. Do not modify any other file. Keep the edit minimal and syntactically complete.`;
          const crossModuleHint = ` If you need data owned by another class, add or use a PUBLIC method on that class (and change that file in its own step); never read a private member from another module.`;
          report.modelInvoked.callsCount += 1;
          const attemptNote = fileAttempt === 0
            ? ''
            : `\n\nPREVIOUS ATTEMPT FAILED: ${lastProblem}. Fix that specific problem and return valid JSON.`;
          const fileResult = await this.model.generatePlanAndPatch(
            `${task.title}\nDetails: ${task.description}\n\nIMPLEMENT FILE ${requiredPath} (attempt ${fileAttempt + 1}/${maxRepairs}). ${editInstruction}${crossModuleHint} The supplied source already includes every change made earlier in this mission, so implement this file against the current version shown.${attemptNote}`,
            evolvingContext(requiredPath)
          );
          recordModel(fileResult);
          if (!fileResult.success) {
            lastProblem = `model call failed: ${fileResult.error}`;
            continue;
          }
          let filePlan: any;
          try {
            filePlan = parseModelJson(fileResult.text);
          } catch (err: any) {
            lastProblem = `invalid JSON: ${err.message}`;
            continue;
          }
          const fileShape = validateModelPlanShape(filePlan);
          if (!fileShape.ok) {
            lastProblem = `plan shape rejected: ${fileShape.error}`;
            continue;
          }
          let candidate = fileShape.changes.find((change) => change.path === requiredPath);
          if (!candidate) {
            lastProblem = `no change for ${requiredPath}`;
            continue;
          }
          if (rewriteMode && !(typeof candidate.content === 'string' && candidate.content.length > 0)) {
            lastProblem = 'rewrite attempt did not include full file content';
            continue;
          }
          if (rewriteMode) {
            candidate = { ...candidate, action: 'modify', edits: undefined };
            const rewriteStage = await this.stageFinalContents([{ ...candidate, path: requiredPath }], contextFiles);
            if (!rewriteStage.ok || !rewriteStage.files[0]) {
              lastProblem = `rewrite rejected: ${rewriteStage.error ?? 'unknown'}`;
              continue;
            }
            candidate = rewriteStage.files[0];
          }
          const candidateAnchors = rewriteMode ? [] : this.findEditAnchorProblems([candidate], contextFiles);
          if (candidateAnchors.length > 0) {
            lastProblem = `invalid anchors: ${candidateAnchors.slice(0, 3).join(' | ')}`;
            continue;
          }
          const merged = [...report.plannedChanges, candidate];
          const mergedValidation = this.validatePatch(merged);
          if (!mergedValidation.valid) {
            lastProblem = `patch rejected: ${mergedValidation.error}`;
            continue;
          }
          report.plannedChanges = merged;
          stagedByPath.set(requiredPath, candidate.content as string);
          added = true;
        }
        if (!added) {
          report.status = 'FAILED';
          report.errorMessage = `Could not implement required file ${requiredPath} after ${maxRepairs} attempt(s): ${lastProblem}`;
          log('error', report.errorMessage);
          return report;
        }
        log('info', `Implemented required file ${requiredPath}.`);
      }

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

      // 5b. IMPLEMENTATION COVERAGE (prevents a false PASS)
      // A patch that only edits a strict subset of the files the task explicitly
      // requires is bounded/incomplete. Evidence must never authorize it, so we
      // fail closed and name the untouched files instead of reporting success.
      const requiredEditPaths = explicitPaths.filter((p) => !p.endsWith('.md') && !p.endsWith('.json'));
      const changedPaths = new Set(report.plannedChanges.map((c) => c.path));
      const untouchedRequired = requiredEditPaths.filter((p) => !changedPaths.has(p));
      if (untouchedRequired.length > 0) {
        report.status = 'FAILED';
        report.errorMessage = `Incomplete implementation: the task explicitly requires changes to ${untouchedRequired.join(', ')} but the patch does not modify them.`;
        log('error', report.errorMessage);
        return report;
      }
      log('info', `Implementation coverage confirmed for ${requiredEditPaths.length} explicitly required file(s).`);

      // 5c. FINAL-CONTENTS STAGING
      // Reconstruct every touched file's final content by applying the exact edits
      // to the source snapshot that was supplied to the model. This is the single
      // source of truth for both testing and committing, so the tree that is tested
      // is exactly the tree that is committed.
      let staged = await this.stageFinalContents(report.plannedChanges, contextFiles);
      if (!staged.ok) {
        report.status = 'FAILED';
        report.errorMessage = `Staging rejected: ${staged.error}`;
        log('error', report.errorMessage);
        return report;
      }
      log('info', `Staged final contents for ${staged.files.length} file(s).`);

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
        log('info', `Cloning target branch ${targetBranch} into an isolated temporary worktree.`);
        await execFileAsync('git', ['clone', '--depth', '1', '--branch', targetBranch, `https://github.com/${owner}/${repo}.git`, worktree], {
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

        await this.applyFinalContentsToWorktree(worktree, staged.files);

        const packagePath = path.join(worktree, 'package.json');
        let scripts: Record<string, string> = {};
        try {
          const targetPackage = JSON.parse(await fs.readFile(packagePath, 'utf-8'));
          scripts = targetPackage.scripts || {};
        } catch {
          // Non-Node repositories are not assumed to have npm checks.
        }

        const checksToRun: string[] = [];
        const hasNpmScripts = Object.keys(scripts).length > 0;
        if (hasNpmScripts) {
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

        let latestAttemptResults: TaskExecutionReport['testResults'] = [];
        let allChecksPassed = false;
        const maxTestRepairs = loadForgeLimits().maxRepairAttempts;
        const maxTestAttempts = maxTestRepairs + 1;
        for (let attempt = 0; attempt < maxTestAttempts && !allChecksPassed; attempt += 1) {
          const attemptResults: TaskExecutionReport['testResults'] = [];
          if (hasNpmScripts) {
            let install = await this.testRunner.runCheck('npm install', worktree);
            report.testResults.push(install);
            attemptResults.push(install);
            if (install.status !== 'PASSED') {
              log('warn', `Dependency installation failed on attempt ${attempt + 1}; retrying once before classifying the environment as blocked.`);
              await new Promise((resolve) => setTimeout(resolve, 1000));
              const retryInstall = await this.testRunner.runCheck('npm install', worktree);
              report.testResults.push(retryInstall);
              attemptResults[attemptResults.length - 1] = retryInstall;
              install = retryInstall;
            }
            if (install.status !== 'PASSED') {
              report.status = 'FAILED';
              report.errorMessage = `Target dependency installation failed twice (last exit ${install.exitCode}).`;
              log('error', report.errorMessage);
              return report;
            }
          }

          for (const cmd of checksToRun) {
            log('info', `Testing proposed patch (attempt ${attempt + 1}/3): ${cmd}`);
            const result = await this.testRunner.runCheck(cmd, worktree);
            report.testResults.push(result);
            attemptResults.push(result);
            const detail = result.status === 'PASSED'
              ? ''
              : `; stderr tail: ${result.stderr.slice(-500)}; stdout tail: ${result.stdout.slice(-500)}`;
            log(result.status === 'PASSED' ? 'info' : 'warn', `Target check "${cmd}" exit=${result.exitCode} status=${result.status}${detail}`);
          }

          latestAttemptResults = attemptResults;
          allChecksPassed = attemptResults.length > 0 && attemptResults.every((result) => result.status === 'PASSED');
          if (allChecksPassed) break;

          if (attempt < maxTestRepairs) {
            if (!guardModelCall(`target-check repair ${attempt + 1}/${maxTestRepairs}`)) return report;
            const failedResults = attemptResults.filter((result) => result.status !== 'PASSED');
            const failureDetails = failedResults.map((result) =>
              `COMMAND: ${result.command}\nSTATUS: ${result.status}\nEXIT: ${result.exitCode}\nSTDOUT HEAD:\n${result.stdout.slice(0, 700)}\nSTDOUT TAIL:\n${result.stdout.slice(-1100)}\nSTDERR HEAD:\n${result.stderr.slice(0, 500)}\nSTDERR TAIL:\n${result.stderr.slice(-1100)}`
            ).join('\n\n--- FAILED CHECK ---\n\n');
            log('warn', `Target checks failed; requesting bounded repair ${attempt + 1}/${maxTestRepairs} with ${failedResults.length} failing check(s).`);
            report.modelInvoked.callsCount += 1;
            // Identify which staged files the diagnostics point at. After the first
            // repair, ask for a full rewrite of those files: repeated anchored edits
            // that each fix one member while breaking another never converge, and a
            // rewrite is how a developer finally gets a coherent file.
            const failingPaths = [...new Set(
              failedResults.flatMap((result) =>
                [...`${result.stdout}\n${result.stderr}`.matchAll(/([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))\(\d+,\d+\)/g)].map((m) => m[1])
              )
            )].filter((p) => report.plannedChanges.some((change) => change.path === p));
            const requireRewrite = attempt >= 1 && failingPaths.length > 0;
            const previousPatchSummary = report.plannedChanges
              .map((change) => JSON.stringify({
                path: change.path,
                action: change.action,
                rationale: change.rationale,
                edits: change.edits?.map((edit) => ({
                  find: edit.find.slice(0, 500),
                  replace: edit.replace.slice(0, 800),
                })),
                contentPreview: typeof change.content === 'string' ? change.content.slice(0, 1200) : undefined,
              }, null, 2))
              .join('\n');
            const repairResult = await this.model.generatePlanAndPatch(
              `TASK TO COMPLETE: ${task.title}\nDETAILS: ${task.description}\n\nTARGET-CHECK REPAIR REQUIRED (attempt ${attempt + 1}/${maxTestRepairs}). The previous patch was applied but failed target checks. The exact previous edits and compiler/test diagnostics are included below. Fix the actual cause (including missing imports or type/syntax errors) and return a complete replacement JSON plan for the same task against the CURRENT files shown. Preserve the original task scope. Do not weaken, skip, or silence checks. Do not access private members of another module; if a count or helper is needed, expose a public method on the owning class and add it in that file too. ${requireRewrite ? `For these files the errors point at: ${failingPaths.join(', ')}. Return action "modify" with a complete "content" string containing the ENTIRE corrected file for each (every existing member preserved) and no edits.` : `For each existing file you may EITHER supply exact-anchor edits OR a complete "content" string with the entire corrected file.`} Do not modify package manifests, workflows, scripts, secrets, or security controls. Return changes for every file in the previous patch summary unless a file is already correct.\n\nPREVIOUS PATCH SUMMARY:\n${previousPatchSummary}\n\nFAILED CHECK DIAGNOSTICS:\n${failureDetails}`,
              contextFiles.map((file) =>
                stagedByPath.has(file.path) ? { ...file, content: stagedByPath.get(file.path) as string } : file
              )
            );
            report.modelInvoked.provider = repairResult.provider;
            report.modelInvoked.model = repairResult.model;
            report.modelInvoked.fallbackUsed = repairResult.fallbackUsed ?? false;
            report.modelInvoked.keylessRouteErrors = [
              ...(report.modelInvoked.keylessRouteErrors ?? []),
              ...(repairResult.keylessRouteErrors ?? []),
            ];
            if (!repairResult.success) {
              report.status = 'FAILED';
              report.errorMessage = `Target-check repair model call failed: ${repairResult.error}`;
              log('error', report.errorMessage);
              return report;
            }
            // A single repair attempt may still be malformed (bad JSON, bad anchors,
            // or a rejected patch). Treat that as a recoverable attempt failure and
            // let the next bounded attempt try again instead of aborting the mission.
            try {
              const repairedPlan = parseModelJson(repairResult.text);
              const repairedShape = validateModelPlanShape(repairedPlan);
              if (!repairedShape.ok || repairedShape.changes.length === 0) {
                log('warn', `Target-check repair produced no usable changes on attempt ${attempt + 1}: ${repairedShape.error ?? 'empty changes'}; trying next bounded attempt.`);
                continue;
              }
              // Merge repairs into the existing plan by path. A repair that returns
              // fewer files must never silently drop work already implemented and
              // validated earlier in the mission.
              const mergedRepair = new Map(report.plannedChanges.map((change) => [change.path, change]));
              for (const change of repairedShape.changes) mergedRepair.set(change.path, change);
              const candidateChanges = [...mergedRepair.values()];
              if (requireRewrite) {
                const nonRewritable = failingPaths.filter((p) => {
                  const change = mergedRepair.get(p);
                  return !(change && typeof change.content === 'string' && change.content.length > 0);
                });
                if (nonRewritable.length > 0) {
                  log('warn', `Target-check repair on attempt ${attempt + 1} did not return a full rewrite for ${nonRewritable.join(', ')}; trying next bounded attempt.`);
                  continue;
                }
              }
              const repairCoverageGaps = explicitPaths
                .filter((p) => !p.endsWith('.md') && !p.endsWith('.json'))
                .filter((p) => !candidateChanges.some((change) => change.path === p));
              if (repairCoverageGaps.length > 0) {
                log('warn', `Target-check repair on attempt ${attempt + 1} would omit required ${repairCoverageGaps.join(', ')}; trying next bounded attempt.`);
                continue;
              }
              const repairAnchorProblems = this.findEditAnchorProblems(candidateChanges, contextFiles);
              if (repairAnchorProblems.length > 0) {
                log('warn', `Target-check repair had invalid anchors on attempt ${attempt + 1}: ${repairAnchorProblems.slice(0, 5).join(' | ')}; trying next bounded attempt.`);
                continue;
              }
              const repairValidation = this.validatePatch(candidateChanges);
              if (!repairValidation.valid) {
                log('warn', `Target-check repair was rejected on attempt ${attempt + 1}: ${repairValidation.error}; trying next bounded attempt.`);
                continue;
              }
              const repairedStaged = await this.stageFinalContents(candidateChanges, contextFiles);
              if (!repairedStaged.ok) {
                log('warn', `Target-check repair staging rejected on attempt ${attempt + 1}: ${repairedStaged.error}; trying next bounded attempt.`);
                continue;
              }
              report.plannedChanges = candidateChanges;
              await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: worktree, timeout: 15000 });
              await execFileAsync('git', ['clean', '-fd'], { cwd: worktree, timeout: 15000 });
              staged = repairedStaged;
              await this.applyFinalContentsToWorktree(worktree, staged.files);
              log('info', 'Applied repaired patch to a clean base worktree; rerunning target checks after this repair attempt.');
            } catch (repairError: any) {
              log('warn', `Target-check repair was unusable on attempt ${attempt + 1} (${repairError.message}); trying next bounded attempt.`);
              continue;
            }
          }
        }

        if (!allChecksPassed) {
          report.status = 'FAILED';
          report.errorMessage = `Target checks still failed after ${maxTestRepairs} bounded patch-repair attempt(s).`;
          log('error', report.errorMessage);
          return report;
        }

        // Bind each requirement to the concrete evidence available for it rather than
        // forcing a blanket PENDING (see evaluateRequirementEvidence).
        report.requirements.forEach((req) => {
          const evaluation = evaluateRequirementEvidence(req, latestAttemptResults);
          req.status = evaluation.status;
          req.evidence = evaluation.evidence;
        });
      } finally {
        await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
      }

      // 7. GITHUB BRANCH, COMMIT & PR CREATION
      report.status = 'VERIFYING';
      const runDiscriminator = process.env.GITHUB_RUN_ID || `${Date.now()}`;
      const branchName = `forge/task-${task.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${runDiscriminator}`;
      report.branchName = branchName;

      // Commit exactly the staged final contents that were applied to and tested in
      // the isolated worktree, so the PR cannot diverge from the verified tree.
      const filesToCommit = staged.files.map((c) => ({ path: c.path, content: c.content as string }));

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
              base: targetBranch,
              body: `### Forge Task Report: ${task.id}
- **Base Commit**: \`${report.baseCommitSha}\`
- **Head Commit**: \`${report.headCommitSha}\`
- **Provider**: ${report.modelInvoked.provider}
- **Model**: ${report.modelInvoked.model}
- **Fallback Used**: ${report.modelInvoked.fallbackUsed ?? 'unknown'}
- **Keyless Route Errors**: ${(report.modelInvoked.keylessRouteErrors ?? []).join(' | ') || 'none reported'}
- **Status**: ${report.status}
- **Tests**: ${report.testResults.map((r) => `${r.command}: ${r.status}`).join(', ')}
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
