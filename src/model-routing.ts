/**
 * One routing policy for every model call.
 *
 * Forge's two engines used to decide keyless-vs-keyed differently, which meant
 * the same environment could route two ways:
 *   - `src/services/model.ts` always passed `keyless: true` (keyed first, then
 *     the anonymous Kilo/OVHcloud endpoints as a last resort).
 *   - `src/company/model.ts` passed `keyless: 'auto'` for hard work, which freelm
 *     resolves to "use the keyed providers and nothing else" — so when a key was
 *     present the keyless endpoints were never a fallback at all.
 *
 * This module states the policy once, as a pure function of the environment, so
 * both engines integrate the same way and the behaviour is unit-testable without
 * a network call.
 *
 * Policy:
 *   - FIRSTBORN_KEYLESS_ONLY=true  -> keyless only (provider keys are ignored).
 *   - a provider key is present    -> `true`: keyed first, keyless as last resort.
 *   - no provider key              -> `true`: keyless (there is nothing else).
 * `true` is the right value for the last two cases because freelm gives keyless
 * endpoints priority 100 — they are tried only after every keyed provider.
 */

/** Provider credentials freelm reads. Shared so both engines strip the same set. */
export const CREDENTIAL_ENV_NAMES = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ZAI_API_KEY', 'COHERE_API_KEY',
  'CO_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'NIM_API_KEY',
  'KILO_API_KEY', 'FREELM_GOOGLE_KEYS', 'FREELM_GROQ_KEYS', 'FREELM_OPENROUTER_KEYS',
  'FREELM_CLOUDFLARE_KEYS', 'FREELM_ZAI_KEYS', 'FREELM_COHERE_KEYS',
  'FREELM_CEREBRAS_KEYS', 'FREELM_MISTRAL_KEYS', 'FREELM_NIM_KEYS', 'FREELM_KILO_KEYS',
];

/** The strict keyless lock, recognized case-insensitively (GitHub capitalizes). */
export function isKeylessOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FIRSTBORN_KEYLESS_ONLY ?? '').trim().toLowerCase() === 'true';
}

/** True when at least one provider credential is present. */
export function hasProviderKeys(env: NodeJS.ProcessEnv = process.env): boolean {
  return CREDENTIAL_ENV_NAMES.some((name) => (env[name] ?? '').trim() !== '');
}

export type KeylessMode = 'always' | 'auto';

/**
 * The single routing decision, as a freelm `keyless` value.
 *
 * Always `true` ("always"), in every mode. freelm assigns the anonymous
 * Kilo/OVHcloud endpoints priority 100, so they are only reached after every
 * configured keyed provider has been tried — a genuine last resort, never a
 * first choice. The strict keyless lock does not change this option; it is
 * enforced by stripping the provider keys (see `applyRoutingPolicy`), which
 * leaves the keyless endpoints as the only ones available.
 *
 * Returning `'auto'` here would be a bug: freelm reads "auto" as "add keyless
 * only when no keys exist", so a present key would remove the fallback entirely
 * — the exact divergence this module exists to remove.
 */
export function resolveKeylessMode(_env: NodeJS.ProcessEnv = process.env): KeylessMode {
  return 'always';
}

/** The freelm `keyless` option for the environment (a boolean, as freelm expects). */
export function keylessOption(_env: NodeJS.ProcessEnv = process.env): boolean {
  return true;
}

/** True when the keyless endpoints may be used at all (not a strict keyless lock). */
export function keylessAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isKeylessOnly(env);
}

/**
 * Apply the policy to an environment in place: under the strict lock, remove
 * every provider credential and ask freelm for keyless explicitly. Mutating the
 * passed env (not `process.env`) keeps this testable and side-effect-free for the
 * caller's real environment.
 */
export function applyRoutingPolicy(env: NodeJS.ProcessEnv): { keyless: boolean } {
  if (isKeylessOnly(env)) {
    for (const name of CREDENTIAL_ENV_NAMES) delete env[name];
    env.FREELM_KEYLESS = '1';
  }
  return { keyless: keylessOption(env) };
}
