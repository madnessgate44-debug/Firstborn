import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deliverChange, resolveAuthorizedCommands } from '../src/company/deliver.ts';
import { buildRoleTools } from '../src/company/role-tools.ts';
import { DEFAULT_ROSTER } from '../src/company/roles.ts';
import type { Role } from '../src/company/roles.ts';
import type { AgentAction, AgentBrain } from '../src/kernel/loop.ts';
import type { WorkItem } from '../src/company/company.ts';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run real git and fail the test loudly if it does not succeed. */
function git(args: string[], cwd?: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * A real bare repository to push to, seeded with a real commit on `main`.
 * This is the target the company will change — no mocking of git or the FS.
 */
function seedRemote(): { remoteDir: string; commit: string } {
  const remoteDir = tmp('deliver-remote-');
  git(['init', '--bare', '-q', '-b', 'main', remoteDir]);
  const seedDir = tmp('deliver-seed-');
  git(['init', '-q', '-b', 'main', seedDir]);
  fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'sample-target', scripts: { test: 'node check.js' } }, null, 2));
  fs.writeFileSync(path.join(seedDir, 'index.js'), "module.exports = { version: '0.0.0' };\n");
  fs.writeFileSync(path.join(seedDir, 'check.js'), "const v = require('./index.js').version;\nif (v !== '1.0.0') { console.error('expected 1.0.0, got ' + v); process.exit(1); }\n");
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'add', '-A'], seedDir);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed'], seedDir);
  const commit = git(['rev-parse', 'HEAD'], seedDir);
  git(['push', '-q', remoteDir, 'HEAD:refs/heads/main'], seedDir);
  return { remoteDir, commit };
}

/**
 * A deterministic roster that behaves like the real one: it writes a file, then
 * QA records evidence from the checks it actually ran. `edits` maps a role to the
 * file it writes, so a test can make the change break or keep the target's tests.
 */
function rosterFor(attempt: number, opts: { bad?: boolean } = {}): Role[] {
  const runs: Record<string, AgentAction[]> = {
    implementer: [
      { tool: 'write_file', input: { path: 'index.js', content: opts.bad ? 'module.exports = { version: 123 };\n' : "module.exports = { version: '1.0.0' };\n" } },
      { tool: 'finish', input: { summary: 'implemented the change', data: { files: { 'index.js': opts.bad ? 'module.exports = { version: 123 };\n' : "module.exports = { version: '1.0.0' };\n" } } } },
    ],
    qa: [
      { tool: 'run_check', input: { command: 'test' } },
      { tool: 'finish', input: { summary: 'ran the target tests', data: {} } },
    ],
    security: [{ tool: 'finish', input: { summary: 'no escapes found', data: { clean: true } } }],
    reviewer: [{ tool: 'finish', input: { summary: 'change is correct', data: { blockers: 0 } } }],
    pm: [{ tool: 'finish', input: { summary: 'requirement: bump the version', data: { items: ['version is bumped'] } } }],
    architect: [{ tool: 'finish', input: { summary: 'touch index.js', data: { files: ['index.js'] } } }],
    release: [{ tool: 'finish', input: { summary: 'may ship', data: { ship: true } } }],
  };
  const brain = (id: string): AgentBrain => {
    const script = runs[id] ?? [{ tool: 'finish', input: { summary: id, data: {} } }];
    let i = 0;
    return async () => script[Math.min(i++, script.length - 1)];
  };
  return DEFAULT_ROSTER.map((r) => ({
    id: r.id,
    title: r.title,
    mandate: r.mandate,
    authority: r.authority,
    consumes: r.consumes,
    produces: r.produces,
    tools: buildRoleTools({ workspaceDir: '', canMutate: r.authority === 'branch-write' }).map((t) => t),
    brain: brain(r.id),
  }));
}

/** buildRoleTools needs the real workspace; rebuild per run inside deliver via closure. */
function rosterForWorkspace(dir: string, opts: { bad?: boolean } = {}) {
  return (_item: WorkItem, attempt: number): Role[] => {
    const base = rosterFor(attempt, opts);
    return base.map((r) => ({ ...r, tools: buildRoleTools({ workspaceDir: dir, canMutate: r.authority === 'branch-write' }) }));
  };
}

test('resolveAuthorizedCommands reads only the target\'s declared scripts', () => {
  const dir = tmp('pkg-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'vite build' } }));
  assert.deepEqual(resolveAuthorizedCommands(dir), { test: 'npm test' });
  const empty = tmp('pkg-');
  assert.deepEqual(resolveAuthorizedCommands(empty), {});
});

test('delivery pushes a real, verified change to a real remote branch', async () => {
  const { remoteDir, commit } = seedRemote();
  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed',
    goal: 'bump the version',
    commit,
    branch: 'forge/deliver-test',
    workspaceDir: work,
    token: 'unused-in-local-test',
    remoteUrl: remoteDir,
    rosterFor: rosterForWorkspace(work),
    attemptsPerItem: 1,
    push: true,
    openPr: async () => ({ url: 'https://example.test/pr/1', number: 1 }),
  });

  assert.equal(result.status, 'COMPLETED', result.reason);
  assert.deepEqual(result.changedFiles, ['index.js']);
  assert.equal(result.checks.find((c) => c.name === 'test')?.status, 'PASSED');
  assert.equal(result.prNumber, 1);

  // The branch is really on the remote, and the change is really in it.
  const remoteHead = git(['rev-parse', `refs/heads/forge/deliver-test`], remoteDir);
  assert.equal(remoteHead, result.headCommit);
  const show = git(['show', `refs/heads/forge/deliver-test:index.js`], remoteDir);
  assert.match(show, /1\.0\.0/);
  // The base branch was never touched.
  assert.equal(git(['rev-parse', 'refs/heads/main'], remoteDir), commit);
});

test('delivery refuses to push when the target\'s own check fails', async () => {
  const { remoteDir, commit } = seedRemote();
  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed',
    goal: 'break the version',
    commit,
    branch: 'forge/broken',
    workspaceDir: work,
    token: 'unused-in-local-test',
    remoteUrl: remoteDir,
    rosterFor: rosterForWorkspace(work, { bad: true }),
    attemptsPerItem: 1,
    push: true,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /check "test" failed/);
  // No branch was created on the remote.
  const branches = git(['branch', '--list'], remoteDir);
  assert.doesNotMatch(branches, /forge\/broken/);
});

test('delivery refuses a branch that is not under forge/', async () => {
  const { remoteDir, commit } = seedRemote();
  const result = await deliverChange({
    target: 'local/seed', goal: 'x', commit, branch: 'main', workspaceDir: tmp('w-'),
    token: 't', remoteUrl: remoteDir, rosterFor: rosterForWorkspace(tmp('w-')), push: false,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /must start with "forge\/"|base branch/);
});

test('delivery refuses to push a change it cannot verify (no checks declared)', async () => {
  const remoteDir = tmp('deliver-remote-');
  git(['init', '--bare', '-q', '-b', 'main', remoteDir]);
  const seedDir = tmp('deliver-seed-');
  git(['init', '-q', '-b', 'main', seedDir]);
  fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'no-scripts' }));
  fs.writeFileSync(path.join(seedDir, 'index.js'), 'module.exports = {};\n');
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'add', '-A'], seedDir);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed'], seedDir);
  const commit = git(['rev-parse', 'HEAD'], seedDir);
  git(['push', '-q', remoteDir, 'HEAD:refs/heads/main'], seedDir);

  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed', goal: 'x', commit, branch: 'forge/nochecks', workspaceDir: work,
    token: 't', remoteUrl: remoteDir, rosterFor: rosterForWorkspace(work), push: true,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /no test or lint script/);
});
