/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { TestExecutionResult } from '../types/agent.ts';

const execAsync = promisify(exec);

// Whitelist of allowed verification commands to prevent arbitrary untrusted execution
const ALLOWED_COMMAND_PREFIXES = [
  'npm run test',
  'npm test',
  'npm run lint',
  'npm run build',
  'npx vitest',
  'npx tsc',
  'node --check',
  'node -e',
];

export class TestRunnerService {
  async runCheck(command: string, cwd = process.cwd()): Promise<TestExecutionResult> {
    const trimmed = command.trim();
    const startTime = Date.now();

    // Enforce safety boundary: verify command against allowed patterns
    const isAllowed = ALLOWED_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
    if (!isAllowed) {
      return {
        command: trimmed,
        exitCode: 126, // Command invoked cannot execute
        stdout: '',
        stderr: `Security Boundary Violation: Command "${trimmed}" is not in the allowed verification command whitelist (${ALLOWED_COMMAND_PREFIXES.join(', ')}).`,
        durationMs: 0,
        status: 'ERROR',
      };
    }

    try {
      const { stdout, stderr } = await execAsync(trimmed, {
        cwd,
        timeout: 45000, // 45 seconds timeout
        maxBuffer: 1024 * 1024 * 2, // 2MB buffer
      });

      return {
        command: trimmed,
        exitCode: 0,
        stdout: stdout || '',
        stderr: stderr || '',
        durationMs: Date.now() - startTime,
        status: 'PASSED',
      };
    } catch (err: any) {
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      return {
        command: trimmed,
        exitCode,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
        durationMs: Date.now() - startTime,
        status: 'FAILED',
      };
    }
  }
}
