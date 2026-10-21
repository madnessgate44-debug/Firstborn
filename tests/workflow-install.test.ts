import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Install steps run on every workflow, and a dependency's postinstall script would
// run with the workflow's secrets in scope. Every install must therefore disable
// lifecycle scripts. This test scans all workflows so a new one cannot slip in.

const workflowsDir = fileURLToPath(new URL('../.github/workflows', import.meta.url));

test('workflow-install: every npm install step passes --ignore-scripts', () => {
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length > 0, 'no workflow files found');
  for (const file of files) {
    const lines = readFileSync(`${workflowsDir}/${file}`, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      // Only install invocations matter; a comment mentioning them does not run.
      if (!/(^|\s)(npm (ci|install))(\s|$)/.test(line)) continue;
      if (line.trim().startsWith('#')) continue;
      assert.match(
        line,
        /--ignore-scripts/,
        `${file}:${i + 1} runs "${line.trim()}" without --ignore-scripts`
      );
    }
  }
});
