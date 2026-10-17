import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_ENV_NAMES,
  isKeylessOnly,
  hasProviderKeys,
  resolveKeylessMode,
  keylessOption,
  keylessAllowed,
  applyRoutingPolicy,
} from '../src/model-routing.ts';

// Both engines (src/services/model.ts and src/company/model.ts) must make the
// SAME keyless-vs-keyed decision. These tests pin the shared policy so the two
// paths cannot drift apart again.

test('routing: the keyless lock is recognized case-insensitively', () => {
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'True' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'TRUE' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'true' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'false' }), false);
  assert.equal(isKeylessOnly({}), false);
});

test('routing: hasProviderKeys is true when any credential is present', () => {
  assert.equal(hasProviderKeys({ GROQ_API_KEY: 'g' }), true);
  assert.equal(hasProviderKeys({ GEMINI_API_KEY: 'k' }), true);
  assert.equal(hasProviderKeys({ GROQ_API_KEY: '   ' }), false);
  assert.equal(hasProviderKeys({}), false);
});

test('routing: the keyless option is always true, so keyless stays a genuine last resort', () => {
  // With keys, without keys, and under the lock: the anonymous endpoints are
  // added at priority 100 (tried last). Returning 'auto' would drop them whenever
  // a key exists — the exact bug this policy removes.
  assert.equal(resolveKeylessMode({ GROQ_API_KEY: 'g' }), 'always');
  assert.equal(resolveKeylessMode({}), 'always');
  assert.equal(resolveKeylessMode({ FIRSTBORN_KEYLESS_ONLY: 'true', GROQ_API_KEY: 'g' }), 'always');
  assert.equal(keylessOption({ GROQ_API_KEY: 'g' }), true);
  assert.equal(keylessOption({}), true);
});

test('routing: keylessAllowed reflects the lock', () => {
  assert.equal(keylessAllowed({}), true);
  assert.equal(keylessAllowed({ FIRSTBORN_KEYLESS_ONLY: 'true' }), false);
});

test('routing: the strict lock strips every provider key and forces keyless', () => {
  const env: NodeJS.ProcessEnv = { FIRSTBORN_KEYLESS_ONLY: 'true', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' };
  const { keyless } = applyRoutingPolicy(env);
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.FREELM_KEYLESS, '1');
  assert.equal(keyless, true);
});

test('routing: without the lock, provider keys are left intact', () => {
  const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' };
  applyRoutingPolicy(env);
  assert.equal(env.GROQ_API_KEY, 'g');
  assert.equal(env.GEMINI_API_KEY, 'k');
  assert.equal(env.FREELM_KEYLESS, undefined);
});

test('routing: both engines read the same credential names', () => {
  for (const name of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'KILO_API_KEY']) {
    assert.ok(CREDENTIAL_ENV_NAMES.includes(name), `expected ${name} to be honoured`);
  }
});
