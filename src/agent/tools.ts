/**
 * M2 — Tools for the agent loop.
 *
 * Thin adapters over Forge's existing services (GitHubService, TestRunnerService).
 * The loop kernel never knows about GitHub or npm; it only calls these tools by
 * name. Read tools are safe; mutating tools are marked so the loop's authorization
 * gate can refuse them under a restrictive permission profile.
 */
import { GitHubService } from '../services/github.ts';
import { TestRunnerService } from '../services/test-runner.ts';
import { applyExactEdits } from './stages.ts';
import type { AgentTool, LoopContext, ToolObservation } from './loop.ts';

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Build the Forge toolset. Mutating tools (`edit_file`, `run_check`) are enabled
 * only when `allowMutation` is true; otherwise they are omitted so the brain
 * cannot even see a state-changing capability it is not permitted to use.
 */
export function buildForgeTools(options: {
  owner: string;
  repo: string;
  ref?: string;
  token?: string;
  allowMutation?: boolean;
}): AgentTool[] {
  const github = new GitHubService(options.token);
  const runner = new TestRunnerService();
  const ref = options.ref ?? 'main';

  const tools: AgentTool[] = [
    {
      name: 'list_files',
      description: 'List the repository file paths (recursive). Read-only.',
      run: async (): Promise<ToolObservation> => {
        const files = await github.listRepositoryFiles(options.owner, options.repo, ref);
        if (files.length === 0) return { ok: false, output: 'No files found.' };
        const shown = files.slice(0, 80);
        return { ok: true, output: `${files.length} files total. First ${shown.length}:\n${shown.join('\n')}` };
      },
    },
    {
      name: 'read_file',
      description: 'Read one file by exact repository path. Read-only.',
      run: async (input): Promise<ToolObservation> => {
        const path = str(input, 'path');
        if (!path) return { ok: false, output: 'read_file requires a "path".' };
        const file = await github.fetchFile(options.owner, options.repo, path, ref);
        if (!file) return { ok: false, output: `File not found: ${path}` };
        return { ok: true, output: file.content };
      },
    },
  ];

  if (options.allowMutation) {
    tools.push({
      name: 'edit_file',
      description:
        'Apply exact-anchor edits to a file in the working tree. Each "find" must occur exactly once in the file. Mutating.',
      mutating: true,
      run: async (input, ctx: LoopContext): Promise<ToolObservation> => {
        const path = str(input, 'path');
        const rawEdits = Array.isArray(input.edits) ? input.edits : [];
        const edits = rawEdits.filter(
          (e): e is { find: string; replace: string } =>
            Boolean(e) && typeof (e as any).find === 'string' && typeof (e as any).replace === 'string'
        );
        if (!path || edits.length === 0) return { ok: false, output: 'edit_file requires "path" and a non-empty "edits" array of {find, replace}.' };
        const file = await github.fetchFile(options.owner, options.repo, path, ref);
        if (!file) return { ok: false, output: `Cannot edit missing file: ${path}` };
        const result = applyExactEdits(file.content, edits);
        if (!result.ok) return { ok: false, output: `Edit rejected: ${result.error}` };
        // The loop only stages in a scratch workspace; the commit happens later,
        // through the same PR path the pipeline uses. Never write to main.
        return { ok: true, output: `Staged ${edits.length} edit(s) to ${path} in ${ctx.workspace}.` };
      },
    });
    tools.push({
      name: 'run_check',
      description:
        'Run an authorized verification command (e.g. "npm run lint", "npm test"). Mutating (may install/build).',
      mutating: true,
      run: async (input): Promise<ToolObservation> => {
        const command = str(input, 'command');
        if (!command) return { ok: false, output: 'run_check requires a "command".' };
        const result = await runner.runCheck(command);
        return {
          ok: result.status === 'PASSED',
          output: `exit=${result.exitCode} status=${result.status}\n${result.stdout}\n${result.stderr}`.slice(0, 4000),
        };
      },
    });
  }

  return tools;
}
