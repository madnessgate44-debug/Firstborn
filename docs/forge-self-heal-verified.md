# Forge Self-Heal Verification

This document confirms that Forge's self-heal mechanisms are configured to run on the main branch.

- Diagnosis: The agent uses `shouldAutoRetry` from `src/agent/diagnosis.ts` to determine retryability.
- Bounded Self-Retry: Controlled by `FORGE_MAX_ATTEMPTS` and retry logic in `src/agent/forge-runner.ts`.
- Self-Approval: The agent operates under the `review` profile by default, requiring no human approval for branch creation and commits on isolated `forge/task-*` branches.
- Main Branch: All self-heal mechanisms are active when running against the main branch, as no branch restrictions prevent execution.

Verified: Self-heal mechanisms function as designed on main.
