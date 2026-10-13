# Forge Internal Checks Verified

This document confirms that the Forge agent now runs the full documented check set before opening a pull request.

## Verified Pre-PR Checks

Forge executes the following checks in sequence before attempting to open a PR:

1. **Lint Check**: `npm run lint` (TypeScript compilation check)
2. **Test Check**: `npm run test` (test suite execution)
3. **Build Check**: `npm run build` (Vite build verification)
4. **Model Smoke Check**: `npm run model:smoke` (keyless LLM route validation)

These checks are run as part of Forge's validation stage to ensure code quality, test coverage, buildability, and model accessibility before proposing changes.

## Evidence Source

This verification is based on inspection of Forge's execution logic in:
- `src/agent/forge-runner.ts` (CLI entry point)
- `src/agent/forge.ts` (core task execution)
- `src/services/test-runner.ts` (test execution service)
- Package.json script definitions

All checks must pass for Forge to proceed to PR creation.
