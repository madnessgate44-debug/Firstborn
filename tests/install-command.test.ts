import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_COMMANDS } from '../src/services/test-runner.ts';
import { readFileSync } from 'node:fs';

test('npm ci is an authorized, script-less reproducible install', () => {
  assert.deepEqual(AUTHORIZED_COMMANDS['npm ci'], { executable: 'npm', args: ['ci', '--ignore-scripts'] });
  assert.deepEqual(AUTHORIZED_COMMANDS['npm install'].args, ['install', '--ignore-scripts']);
});

test('forge prefers npm ci when a lockfile exists and falls back to npm install on retry', () => {
  const src = readFileSync(new URL('../src/agent/forge.ts', import.meta.url), 'utf8');
  assert.match(src, /existsSync\(path\.join\(worktree, 'package-lock\.json'\)\) \? 'npm ci' : 'npm install'/);
  assert.match(src, /runCheck\(installCommand, worktree\)/);
  assert.match(src, /retryInstall = await this\.testRunner\.runCheck\('npm install', worktree\)/);
});
