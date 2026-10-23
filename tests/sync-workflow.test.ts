import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCE_CAPABILITIES, supportedSources, unsupportedSources } from '../src/sync/sources.ts';

// Contract guards: the workflow must actually run the pipeline, and the capability
// matrix must keep ChatGPT explicitly unsupported. These fail if either regresses.

const yml = readFileSync(new URL('../.github/workflows/conversation-sync.yml', import.meta.url), 'utf8');

test('sync workflow: runs the sync script, not just a schedule', () => {
  assert.match(yml, /npx tsx scripts\/sync\.ts/, 'workflow must invoke the sync pipeline');
  assert.match(yml, /OPENHANDS_API_KEY:/, 'workflow must pass the read-only source token');
  assert.match(yml, /GITHUB_TOKEN:/, 'workflow must pass a write token');
});

test('sync workflow: exposes a dry-run switch and a manual trigger', () => {
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /dry_run:/);
  assert.match(yml, /--dry-run/);
});

test('capability matrix: OpenHands is the only supported unattended source', () => {
  assert.equal(supportedSources().length, 1);
  assert.equal(supportedSources()[0].source, 'openhands');
  assert.equal(SOURCE_CAPABILITIES.openhands.unattended, true);
  assert.equal(SOURCE_CAPABILITIES.openhands.stableIds, true);
  assert.ok(SOURCE_CAPABILITIES.openhands.officialRefs.length >= 1);
});

test('capability matrix: ChatGPT personal conversations are unsupported with a blocker', () => {
  const chatgpt = SOURCE_CAPABILITIES['chatgpt-personal'];
  assert.equal(chatgpt.unattended, false);
  assert.ok(chatgpt.blocker && chatgpt.blocker.length > 0);
  assert.equal(unsupportedSources().length, 1);
  assert.equal(unsupportedSources()[0].source, 'chatgpt-personal');
});
