# Forge Self-Approval Verification

This document confirms that the Forge agent can approve its own verification run.

Forge operates under the policy defined in `src/agent/policy.ts` where:
- The default `review` profile allows branch creation, commits, and opening PRs
- Merge is intentionally never granted
- Caller consent (`allowPrCreation`) remains mandatory for write operations

For verification runs, Forge can self-approve when:
1. Operating in an environment with `GITHUB_TOKEN` provided
2. The `allowPrCreation` flag is set to `true` in the task configuration
3. The target repository is within `FORGE_ALLOWED_REPOS` (if configured)
4. The target branch follows `FORGE_ALLOWED_BRANCH_PREFIX` (default: `forge/task-`)

This self-approval capability enables Forge to autonomously execute verification tasks while maintaining security boundaries through:
- Isolated branch usage (`forge/task-*`)
- No merge capabilities
- Human-approval cap via `FORGE_REQUIRE_HUMAN_APPROVAL`
- Repository restrictions via `FORGE_ALLOWED_REPOS`

Verification completed successfully.
