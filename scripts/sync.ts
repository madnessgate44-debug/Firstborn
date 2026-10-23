/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unattended conversation sync CLI.
 *
 *   npm run sync                 # read OpenHands sessions, archive new messages, refresh status
 *   npm run sync -- --dry-run    # plan only; write nothing, print the plan
 *
 * Requires OPENHANDS_API_KEY (read-only) and, to write, GITHUB_TOKEN. The
 * ChatGPT personal-conversation source is deliberately excluded: no unattended
 * source exists for it, so the pipeline reports it as unsupported rather than
 * approximating it with a manual export.
 */

import { OpenHandsClient } from '../src/sync/openhands-client.ts';
import { OpenHandsSourceReader } from '../src/sync/openhands-source.ts';
import { GitHubRepoWriter, DEFAULT_SYNC_BRANCH } from '../src/sync/github-writer.ts';
import { runSync, type RepoWriter, type SourceReader } from '../src/sync/pipeline.ts';
import { MemoryCheckpointStore, RepoCheckpointStore, type CheckpointStore } from '../src/sync/store.ts';
import { DEFAULT_ROUTES, DEFAULT_ROUTES_PATH, parseRoutes } from '../src/sync/routes.ts';
import { renderStatus } from '../src/sync/render.ts';
import { SOURCE_CAPABILITIES } from '../src/sync/sources.ts';

const COORDINATION_REPO = process.env.FORGE_SYNC_REPO || 'madnessgate44-debug/Firstborn';

/** A writer that records writes in memory instead of touching GitHub (dry run). */
class DryRunWriter implements RepoWriter {
  readonly writes: { repository: string; path: string; bytes: number }[] = [];
  async read(): Promise<string | null> {
    return null;
  }
  async write(repository: string, files: { path: string; content: string }[]): Promise<{ commit: string | null }> {
    for (const f of files) this.writes.push({ repository, path: f.path, bytes: f.content.length });
    return { commit: null };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, Number.parseInt(limitArg.split('=')[1], 10) || 50) : 50;

  const apiKey = process.env.OPENHANDS_API_KEY;
  if (!apiKey) {
    console.error('sync: OPENHANDS_API_KEY is required (read-only Cloud token)');
    process.exitCode = 2;
    return;
  }

  const client = new OpenHandsClient({ apiKey });
  const source: SourceReader = new OpenHandsSourceReader(client);

  // Routes are read from the coordination repo when a token is present.
  const token = process.env.GITHUB_TOKEN;
  let routes = DEFAULT_ROUTES;
  let store: CheckpointStore = new MemoryCheckpointStore();
  let writer: RepoWriter = new DryRunWriter();

  if (!dryRun) {
    if (!token) {
      console.error('sync: GITHUB_TOKEN is required to write; use --dry-run to plan only');
      process.exitCode = 2;
      return;
    }
    const ghWriter = new GitHubRepoWriter({ token });
    const routesText = await ghWriter.readDefaultBranch(COORDINATION_REPO, DEFAULT_ROUTES_PATH);
    routes = parseRoutes(routesText);
    writer = ghWriter;
    // Checkpoints live inside each project's own repository, read via the writer.
    store = new RepoCheckpointStore((repository, path) => ghWriter.read(repository, path));
  }

  console.log(`[sync] source: OpenHands Cloud (${SOURCE_CAPABILITIES.openhands.unattended ? 'unattended' : 'manual'})`);
  console.log(`[sync] unsupported: ${SOURCE_CAPABILITIES['chatgpt-personal'].blocker}`);
  console.log(`[sync] mode: ${dryRun ? 'dry-run' : `write to ${DEFAULT_SYNC_BRANCH}`}`);

  const result = await runSync({
    source,
    writer,
    store,
    routes: routes.routes,
    fallbackRepository: routes.fallbackRepository,
    limit,
  });

  console.log('\n--- SYNC STATUS ---');
  console.log(renderStatus(result.status));
  if (result.errors.length) {
    console.log('Errors:');
    for (const e of result.errors) console.log(`  - ${e}`);
  }
  if (writer instanceof DryRunWriter) {
    console.log('Planned writes (dry-run):');
    for (const w of writer.writes) console.log(`  - ${w.repository} ${w.path} (${w.bytes} bytes)`);
  }
  console.log(`Written: ${result.written.length} file(s); errors: ${result.errors.length}`);

  // A run with errors is a degraded run: fail the step so CI and a reader both see it.
  if (result.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[sync] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
