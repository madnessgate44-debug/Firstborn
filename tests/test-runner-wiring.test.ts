/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { TestRunnerService } from '../src/services/test-runner.ts';

async function flushMacrotasks(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('TestRunnerService timeout wiring', () => {
  let tempRoot: string;
  let binDir: string;
  let workDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    originalPath = process.env.PATH;
    tempRoot = await mkdtemp(join(tmpdir(), 'test-runner-wiring-'));
    binDir = join(tempRoot, 'bin');
    workDir = join(tempRoot, 'work');
    await mkdir(binDir, { recursive: true });
    await mkdir(workDir, { recursive: true });

    const fakeNpmPath = join(binDir, 'npm');
    await writeFile(fakeNpmPath, '#!/bin/sh\nexec sleep 600\n', { encoding: 'utf8' });
    await chmod(fakeNpmPath, 0o755);

    process.env.PATH = originalPath ? `${binDir}:${originalPath}` : binDir;
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(async () => {
    mock.timers.reset();
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function assertCommandTimeoutWiring(commandKey: string, expectedTimeoutMs: number): Promise<void> {
    const runner = new TestRunnerService();
    let settled = false;

    const resultPromise = runner.runCheck(commandKey, workDir).then((result) => {
      settled = true;
      return result;
    });

    await flushMacrotasks();
    mock.timers.tick(expectedTimeoutMs - 1);
    await flushMacrotasks();
    assert.equal(settled, false, `Expected "${commandKey}" not to settle before ${expectedTimeoutMs}ms`);

    mock.timers.tick(1);
    const result = await resultPromise;

    assert.equal(settled, true);
    assert.equal(result.exitCode, 124);
    assert.equal(result.status, 'ERROR');
    assert.ok(
      result.stderr.includes(`timed out after ${expectedTimeoutMs}ms`),
      `Expected stderr to include "timed out after ${expectedTimeoutMs}ms", got: ${result.stderr}`
    );
  }

  it('wires 240000ms timeout to setTimeout for npm test', async () => {
    await assertCommandTimeoutWiring('npm test', 240000);
  });

  it('wires 45000ms timeout to setTimeout for npm run lint', async () => {
    await assertCommandTimeoutWiring('npm run lint', 45000);
  });

  it('wires 180000ms timeout to setTimeout for npm ci', async () => {
    await assertCommandTimeoutWiring('npm ci', 180000);
  });
});
