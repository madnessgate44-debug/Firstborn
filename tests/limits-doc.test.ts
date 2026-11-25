import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadForgeLimits } from '../src/agent/limits.ts';

// Doc/code drift guard: docs/EXHAUSTION_TESTING.md publishes a table of every
// bounded limit and its default. That table said FORGE_MAX_MODEL_CALLS was 6
// while limits.ts used 8, so the published ceilings could not be trusted. This
// test parses the table and fails if any documented default stops matching the
// code, so the two cannot drift apart again.

const doc = readFileSync(new URL('../docs/EXHAUSTION_TESTING.md', import.meta.url), 'utf8');

/** The documented default for each limit environment variable. */
function documentedDefaults(): Map<string, number> {
  const out = new Map<string, number>();
  const row = /^\|\s*`(FORGE_[A-Z_]+)`\s*\|\s*(\d+)\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = row.exec(doc)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

const LIMIT_FOR_ENV: Record<string, keyof ReturnType<typeof loadForgeLimits>> = {
  FORGE_MAX_FILES: 'maxFilesPerMission',
  FORGE_MAX_EDITS: 'maxEditsPerMission',
  FORGE_MAX_PATCH_BYTES: 'maxPatchBytes',
  FORGE_MAX_MODEL_CALLS: 'maxModelCalls',
  FORGE_MAX_REPAIRS: 'maxRepairAttempts',
  FORGE_MODEL_ATTEMPTS: 'modelAttempts',
  FORGE_MAX_RUNTIME_MS: 'maxRuntimeMs',
  FORGE_MAX_MISSION_ATTEMPTS: 'maxMissionAttempts',
};

test('the documented limit table is present and complete', () => {
  const doc = documentedDefaults();
  for (const env of Object.keys(LIMIT_FOR_ENV)) {
    assert.ok(doc.has(env), `docs/EXHAUSTION_TESTING.md must document ${env}`);
  }
});

test('every documented limit default matches loadForgeLimits', () => {
  const doc = documentedDefaults();
  const limits = loadForgeLimits({});
  for (const [env, field] of Object.entries(LIMIT_FOR_ENV)) {
    assert.equal(
      doc.get(env),
      limits[field],
      `${env} is documented as ${doc.get(env)} but the code default is ${limits[field]}`,
    );
  }
});
