import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandTimeoutMs, TestRunnerService } from '../src/services/test-runner.ts';

describe('commandTimeoutMs', () => {
  it('returns 180000ms for npm install and npm ci', () => {
    assert.equal(commandTimeoutMs('npm install'), 180000);
    assert.equal(commandTimeoutMs('npm ci'), 180000);
  });

  it('returns 240000ms for npm test and npm run test', () => {
    assert.equal(commandTimeoutMs('npm test'), 240000);
    assert.equal(commandTimeoutMs('npm run test'), 240000);
  });

  it('returns 45000ms for other commands and unknown commands', () => {
    assert.equal(commandTimeoutMs('npm run lint'), 45000);
    assert.equal(commandTimeoutMs('npm run build'), 45000);
    assert.equal(commandTimeoutMs('npm run model:smoke'), 45000);
    assert.equal(commandTimeoutMs('npx tsc --noEmit'), 45000);
    assert.equal(commandTimeoutMs('git diff --check'), 45000);
    assert.equal(commandTimeoutMs('unknown command'), 45000);
  });

  it('trims surrounding whitespace before matching command keys', () => {
    assert.equal(commandTimeoutMs('  npm test  '), 240000);
    assert.equal(commandTimeoutMs('\t npm run test \n'), 240000);
    assert.equal(commandTimeoutMs('  npm install  '), 180000);
    assert.equal(commandTimeoutMs('  npm ci  '), 180000);
    assert.equal(commandTimeoutMs('  npm run lint  '), 45000);
  });
});

describe('TestRunnerService.runCheck', () => {
  it('runs git status and returns exitCode 0 with status PASSED', async () => {
    const runner = new TestRunnerService();
    const result = await runner.runCheck('git status', process.cwd());
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'PASSED');
  });
});
