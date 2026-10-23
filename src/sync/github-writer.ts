/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitHub-backed repository writer for the sync pipeline.
 *
 * Reads and writes go through the Git Data API. Writes land on a dedicated sync
 * branch — never on the default branch — so an unattended job cannot change a
 * project's main line without a human merging it. The branch is created from the
 * default branch head the first time and reused afterwards.
 */

import { GitHubService } from '../services/github.ts';
import type { RepoWriter } from './pipeline.ts';

export interface GitHubWriterOptions {
  token: string;
  /** Branch the pipeline commits to. Defaults to an isolated sync branch. */
  branch?: string;
  /** Injectable for tests. */
  service?: GitHubService;
}

export const DEFAULT_SYNC_BRANCH = 'conversation-sync';

export class GitHubRepoWriter implements RepoWriter {
  private readonly service: GitHubService;
  private readonly branch: string;
  private readonly branchEnsured = new Set<string>();

  constructor(opts: GitHubWriterOptions) {
    if (!opts.token || !opts.token.trim()) throw new Error('GitHubRepoWriter: token is required');
    this.service = opts.service ?? new GitHubService(opts.token);
    this.branch = opts.branch ?? DEFAULT_SYNC_BRANCH;
    if (this.branch === 'main' || this.branch === 'master') {
      throw new Error(`GitHubRepoWriter: refusing to write to protected branch "${this.branch}"`);
    }
  }

  async read(repository: string, path: string): Promise<string | null> {
    const [owner, repo] = splitRepo(repository);
    const file = await this.service.fetchFile(owner, repo, path, this.branch);
    return file?.content ?? null;
  }

  /**
   * Read a file from the repository's default branch. Configuration such as the
   * routing registry lives on the default branch; only archived artifacts live on
   * the sync branch, so a config change on `main` takes effect without waiting for
   * the sync branch to catch up.
   */
  async readDefaultBranch(repository: string, path: string): Promise<string | null> {
    const [owner, repo] = splitRepo(repository);
    const info = await this.service.inspectRepository(owner, repo);
    if (!info.exists) return null;
    const file = await this.service.fetchFile(owner, repo, path, info.defaultBranch);
    return file?.content ?? null;
  }

  async write(
    repository: string,
    files: { path: string; content: string }[],
    message: string
  ): Promise<{ commit: string | null }> {
    const [owner, repo] = splitRepo(repository);
    const baseSha = await this.ensureBranch(owner, repo);
    const res = await this.service.commitChangesToBranch({
      owner,
      repo,
      branchName: this.branch,
      baseCommitSha: baseSha,
      commitMessage: message,
      files,
    });
    if (!res.success) throw new Error(res.error ?? 'commit failed');
    return { commit: res.headSha ?? null };
  }

  /** Ensure the sync branch exists and return its head commit SHA. */
  private async ensureBranch(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    if (!this.branchEnsured.has(key)) {
      const existing = await this.service.fetchBranchHeadSha(owner, repo, this.branch);
      if (!existing) {
        const info = await this.service.inspectRepository(owner, repo);
        if (!info.exists) throw new Error(`repository ${key} is not accessible`);
        const created = await this.service.createOrUpdateBranch(owner, repo, this.branch, info.latestCommitSha);
        if (!created.success) {
          // A concurrent run may have created it between the check and the create.
          const raced = await this.service.fetchBranchHeadSha(owner, repo, this.branch);
          if (!raced) throw new Error(created.error ?? 'branch creation failed');
        }
      }
      this.branchEnsured.add(key);
    }
    const head = await this.service.fetchBranchHeadSha(owner, repo, this.branch);
    if (!head) throw new Error(`could not resolve head of ${key}@${this.branch}`);
    return head;
  }
}

function splitRepo(repository: string): [string, string] {
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repository "${repository}"; expected owner/repo`);
  }
  return [parts[0], parts[1]];
}
