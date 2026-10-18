--- FULL-COVERAGE AUDIT REPORT ---
Status: COMPLETED | 47 finding(s); 2 contradicted; examined 72/100 files (72%)

# Forge Full-coverage Audit: madnessgate44-debug/Firstborn

- Audited commit: 7b832d61c183f138a5db8b5bef1806f6288d8b73
- Tracked files: 100
- Files examined: 72/100 (72%)
- Chunks: 21/29 answered
- Route: kilo / nvidia/nemotron-3-super-120b-a12b:free
- Evidence: 1 supported, 2 contradicted, 44 judgment
- Write access used: no
- Target code executed: no

## Coverage
- Examined: 72 of 100 files (72%).
- Partial (a chunk failed): COORDINATION.md, package-lock.json
- NOT examined: src/agent/runtime-verify.ts, src/agent/sentinel.ts, src/agent/stages.ts, src/agent/tools.ts, src/company/audit-company.ts, src/company/deliver.ts, src/company/evidence.ts, src/company/judge.ts, src/company/model.ts, src/company/registry.ts, src/company/repo-context.ts, src/company/role-tools.ts, src/company/roles.ts, src/company/runner.ts, tests/browser-capability-matrix.test.ts, tests/browser.test.ts, tests/company-model.test.ts, tests/company-tools.test.ts, tests/evidence.test.ts, tests/forge.test.ts, tests/loop-guard.test.ts, tests/loop.test.ts, tests/mcp.test.ts, tests/memory.test.ts, tests/mission-trace.test.ts, tests/policy.test.ts
- Failed chunks: 8 of 29

## Findings
### HIGH — Insecure Command Execution and Arbitrary Shell Boundary in Test Runner
_basis: observed · paths: COORDINATION.md_

- Claim: Audit findings AUD-20261012-01 (F-01) highlight that src/services/test-runner.ts previously passed strings directly to shell-based exec with prefix matching like 'node -e', allowing arbitrary code execution. Although refactored, risk remains high where command arguments and shell invocation boundaries meet untrusted agent inputs.
- Recommendation: Ensure command execution uses strict parameter arrays with explicit executables and zero shell context, maintaining hardcoded non-overridable parameter options.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: COORDINATION.md
    - spot-check: search the repo for `COORDINATION.md`

### HIGH — Unauthenticated API Endpoints Exposing Command and Task Execution
_basis: observed · paths: COORDINATION.md_

- Claim: Findings F-05 and AUD-20261012-02 note that Express backend endpoints (/api/tasks/run, /api/verify/check in server.ts) lack authentication and authorization guards, allowing unauthenticated remote callers to trigger model requests and command execution.
- Recommendation: Implement robust application-level authentication and authorization middleware on all task and execution API endpoints before making the server publicly reachable.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: COORDINATION.md
    - spot-check: search the repo for `COORDINATION.md`

### HIGH — Model Context Lacks Patch Isolation and Post-Patch Target Testing
_basis: observed · paths: COORDINATION.md_

- Claim: Findings F-02, F-03, and AUD-20261012-03 show that test checks run inside process.cwd() (the runner repository) rather than an isolated target checkout worktree, and checks run prior to applying model-proposed patches. Requirements are marked PASS based on global unrelated lint results.
- Recommendation: Isolate every target task in a clean temporary worktree, write model proposed patches to the worktree, run post-patch verification inside that target worktree, and tie requirement outcomes directly to test execution output.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: COORDINATION.md
    - spot-check: search the repo for `COORDINATION.md`

### HIGH — Unauthenticated Command Execution Endpoint
_basis: observed · paths: server.ts_

- Claim: The POST endpoint '/api/verify/check' (lines 135-142) does not apply the 'requireGitHubToken' middleware, allowing any unauthenticated user to invoke TestRunnerService.runCheck with arbitrary command inputs.
- Recommendation: Apply authentication and input sanitization/whitelisting middleware to the '/api/verify/check' endpoint before processing command execution requests.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: server.ts
    - spot-check: search the repo for `server.ts`

### HIGH — Unauthenticated Local File Read Endpoint
_basis: observed · paths: server.ts_

- Claim: The GET endpoint '/api/coordination' (lines 145-152) reads and serves local file contents ('COORDINATION.md') without authentication or authorization checks.
- Recommendation: Protect the '/api/coordination' endpoint with authentication middleware like requireGitHubToken or ensure file access control policies are properly enforced.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: server.ts
    - spot-check: search the repo for `server.ts`

### HIGH — Model-driven repair loop can repeatedly invoke the model and mutate files based on untrusted diagnostics
_basis: observed · paths: src/agent/forge.ts_

- Claim: forge.ts invokes guardModelCall and model.generatePlanAndPatch for bounded repair attempts, applies repaired changes via applyChangesToWorktree, and reruns checks. The loop is bounded by attempt count but the model controls patch content, and no sandboxing or output validation beyond anchor/preflight checks is shown.
- Recommendation: Run model-generated patches in an isolated sandbox, enforce strict diff scope limits, and require human review for any repair that modifies security-relevant files.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/forge.ts
    - spot-check: search the repo for `src/agent/forge.ts`

### MEDIUM — Potential GitHub Actions injection or untrusted execution risk in Sentinel workflow
_basis: observed · paths: .github/workflows/sentinel.yml_

- Claim: In `.github/workflows/sentinel.yml`, the `pull_request` event triggers `actions/checkout@v4` with `ref: ${{ github.event.pull_request.head.sha || github.sha }}` and executes `npm ci` and `npx tsx scripts/sentinel-run.ts`. While the job checks `startsWith(github.head_ref, 'forge/')`, branch names on fork PRs or malicious refs could potentially bypass assumptions if write permissions (`contents: write`, `pull-requests: write`) are broadly granted.
- Recommendation: Ensure `sentinel.yml` restricts execution scope or enforces strict token scope bounds when running workflows on `pull_request` events.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: .github/workflows/sentinel.yml
    - spot-check: search the repo for `.github/workflows/sentinel.yml`

### MEDIUM — Unrestricted File Access and Incomplete Path Traversal Protections
_basis: observed · paths: COORDINATION.md_

- Claim: Audit entry AUD-20261012-03 notes patch path validation checks only basic string prefixes and simple relative paths without full path normalization, allowing backslash variations or unauthorized file modifications outside strict project scope.
- Recommendation: Normalize and resolve all file paths using path.resolve/path.normalize, maintain an explicit allowlist of editable directories, and reject attempts to create or modify paths outside the designated workspace.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: COORDINATION.md
    - spot-check: search the repo for `COORDINATION.md`

### MEDIUM — Node.js engine constraint requires Node >= 20 for multiple dependencies
_basis: observed · paths: package-lock.json_

- Claim: Multiple @tailwindcss/oxide-* packages declare engines.node '>= 20'; @vitejs/plugin-react declares engines.node '^20.19.0 || >=22.12.0'.
- Recommendation: Confirm the runtime environment satisfies Node >= 20 (or >= 22.12 where applicable) before building or deploying.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: package-lock.json
    - spot-check: search the repo for `package-lock.json`

### MEDIUM — Unbounded In-Memory Map Usage for Task Reports
_basis: observed · paths: server.ts_

- Claim: The 'reportsStore' Map object (line 19 and line 108) grows indefinitely with each executed task without size limit enforcement or eviction policy, creating a memory exhaustion risk over prolonged server operations.
- Recommendation: Implement an LRU cache or maximum size limit with explicit eviction policy for the in-memory 'reportsStore'.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: server.ts
    - spot-check: search the repo for `server.ts`

### MEDIUM — Loop runner does not apply per-tool authorization to non-mutating tools
_basis: observed · paths: src/agent/loop-runner.ts, src/agent/loop.ts_

- Claim: loop-runner.ts builds tools with allowMutation from policy but loop.ts only consults the authorize gate when tool.mutating is true. Read tools such as browser or file readers are not gated by policy, potentially allowing unauthorized data access.
- Recommendation: Extend the authorize gate to cover read and network tools, or explicitly mark all tools with mutating flags and review the authorization boundary.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/loop-runner.ts, src/agent/loop.ts
    - spot-check: search the repo for `src/agent/loop-runner.ts`

### MEDIUM — Pull Request body includes unescaped model provider and model fields
_basis: observed · paths: src/agent/forge.ts_

- Claim: forge.ts interpolates report.modelInvoked.provider and report.modelInvoked.model directly into the PR body markdown. If these fields are attacker-controlled, they could inject markdown or links into the PR body.
- Recommendation: Escape or sanitize provider/model values before including them in PR body text, or restrict them to a known safe set.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/forge.ts
    - spot-check: search the repo for `src/agent/forge.ts`

### MEDIUM — Default permission profile is 'review', allowing branch, commit, and PR by default
_basis: observed · paths: src/agent/policy.ts_

- Claim: loadPermissionConfig defaults FORGE_PERMISSION_PROFILE to 'review', which permits branch writes, commits, and PRs when consented. The comment states broader capability must be enabled explicitly, but the default is not the most restrictive ('readonly').
- Recommendation: Change the default profile to 'readonly' so operators must explicitly opt into broader GitHub write capabilities.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/policy.ts
    - spot-check: search the repo for `src/agent/policy.ts`

### MEDIUM — Unchecked Non-Null Assertion in Competition Winner Resolution
_basis: observed · paths: src/company/company.ts_

- Claim: In `runCompany`, `runs.find((r) => r.attempt === competition.winner)!.run` uses a non-null assertion on `runs.find()`. If `competition.winner` is non-null but does not match any attempt ID in `runs`, this will raise a runtime `TypeError` when accessing `.run`.
- Recommendation: Safely look up the winning run and handle or report missing run objects before attempting to access `.run`.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/company/company.ts
    - spot-check: search the repo for `src/company/company.ts`

### MEDIUM — GitHub token transmitted as *** rather than token auth
_basis: observed · paths: src/services/github.ts_

- Claim: getHeaders() sets Authorization header to `*** for GitHub API calls. GitHub personal access tokens typically use `token` scheme; *** correct for GitHub App installation tokens or OAuth tokens but the token type is not validated or documented.
- Recommendation: Document which token types are supported and consider accepting an auth scheme parameter or validating the token prefix.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/github.ts
    - spot-check: search the repo for `src/services/github.ts`

### MEDIUM — GitHub API errors may leak token-related details in error messages
_basis: observed · paths: src/services/github.ts_

- Claim: Error messages include raw `errorText` from GitHub API responses, which could contain sensitive information. Network errors include `err.message`.
- Recommendation: Sanitize error messages before returning them to callers to avoid leaking internal details or token fragments.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/github.ts
    - spot-check: search the repo for `src/services/github.ts`

### MEDIUM — Model service deletes environment variables at runtime in keyless-only mode
_basis: observed · paths: src/services/model.ts_

- Claim: When isKeylessOnly() is true, the constructor iterates KEYLESS_CREDENTIAL_ENV_NAMES and calls delete process.env[name] for each, mutating the process environment globally.
- Recommendation: Avoid mutating process.env; instead filter credentials locally or pass a sanitized env copy to the LLM client.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/model.ts
    - spot-check: search the repo for `src/services/model.ts`

### LOW — Mismatched Package Script Configuration for Express Server Startup
_basis: observed · paths: COORDINATION.md_

- Claim: Audit entry AUD-20261012-02 notes that package.json specified 'start': 'node server.js', but server.js did not exist in the source tree (the file is server.ts run via tsx).
- Recommendation: Update package.json start script to correctly reference the server entrypoint (e.g. tsx server.ts or compiled dist output).
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: COORDINATION.md
    - spot-check: search the repo for `COORDINATION.md`

### LOW — Data Ingestion Leakage via External Unauthenticated LLM Gateway
_basis: observed · paths: COORDINATION.md_

- Claim: Entry IMPL-20261012-01 notes introduction of an unauthenticated keyless default model endpoint 'https://api.llmfaucet.dev/v1/chat/completions', sending repository code snippets to an external third-party service without strict confidentiality guarantees.
- Recommendation: Document the security and privacy implications of the keyless third-party provider and ensure proprietary code or secrets are never forwarded to publicly shared gateway endpoints.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: COORDINATION.md
    - spot-check: search the repo for `COORDINATION.md`

### LOW — Insecure Chromium Flags Enabled Defaulting to Sandbox Disabling
_basis: observed · paths: FORREYRA.md_

- Claim: FORREYRA.md documentation highlights: 'Headless by default. Runs with --no-sandbox and --disable-dev-shm-usage so it works in CI containers.'
- Recommendation: Avoid using `--no-sandbox` unless explicitly required within specific containerized environments, or isolate standard user browser sessions.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: FORREYRA.md
    - spot-check: search the repo for `FORREYRA.md`

### LOW — Server-side Gemini API capability declared without visible key management in audited files
_basis: observed · paths: metadata.json_

- Claim: metadata.json lists MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API as a major capability but no credential handling or key management is shown in the files from this chunk.
- Recommendation: Verify that API keys for the server-side Gemini capability are stored in environment variables or a secrets manager and are not committed to the repository.
- Evidence: **SUPPORTED** (verified-fact)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: metadata.json
    - spot-check: search the repo for `metadata.json`
  - supports: a literal credential is present in the source
    - `grep -rEn "(AIza[0-9A-Za-z_\-]{20,}|sk-[A-Za-z0-9]{…" <repo>`
    - result: 1 literal(s), e.g. tests/evidence.test.ts
    - spot-check: search the repo for `process.env`

### LOW — Smoke test document references unresolved git placeholder instead of captured SHA
_basis: observed · paths: docs/forge-live-smoke-20261012.md_

- Claim: docs/forge-live-smoke-20261012.md lists 'Base Commit SHA' as 'git rev-parse HEAD' rather than an actual commit hash, making the smoke test non-reproducible from the document alone.
- Recommendation: Update the smoke test document to record the actual resolved commit SHA at the time of the test.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: docs/forge-live-smoke-20261012.md
    - spot-check: search the repo for `docs/forge-live-smoke-20261012.md`

### LOW — Optional platform-specific native dependencies present
_basis: observed · paths: package-lock.json_

- Claim: @tailwindcss/oxide-* packages are marked optional:true with cpu/os constraints (e.g., android arm64, darwin arm64/x64, linux variants, win32 variants), and @typescript/typescript-* packages are optional platform binaries.
- Recommendation: Verify that optional native dependencies resolve correctly on all target deployment platforms and that CI covers the intended OS/CPU matrix.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: package-lock.json
    - spot-check: search the repo for `package-lock.json`

### LOW — TypeScript compiler distributed as optional platform binaries
_basis: observed · paths: package-lock.json_

- Claim: @typescript/typescript-* packages (version 7.0.2) are optional, dev:true, and split by platform (aix, darwin, freebsd, linux, netbsd, openbsd, sunos, win32).
- Recommendation: Ensure the TypeScript compiler binary for the build host is present and that lockfile changes do not omit the required platform artifact.
- Evidence: **CONTRADICTED** (verified-fact)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: package-lock.json
    - spot-check: search the repo for `package-lock.json`
  - contradicts: a package-manager lockfile is present in the repository
    - `git ls-files | grep -E "package-lock.json|yarn.lock|pnpm-lock.yaml|npm-shrinkwrap.json|bun.lock"`
    - result: present: package-lock.json
    - spot-check: search the repo for `package-lock.json`

### LOW — Non-standard TypeScript major version specified in devDependencies
_basis: observed · paths: package.json_

- Claim: "devDependencies": { ... "typescript": "^7.0.2" }
- Recommendation: Ensure the intended TypeScript version range is configured in package.json to prevent installation or compatibility issues during builds.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: package.json
    - spot-check: search the repo for `package.json`

### LOW — Mission limits allow up to 50 model calls and 5 mission attempts by default
_basis: observed · paths: src/agent/limits.ts_

- Claim: loadForgeLimits defaults maxModelCalls to 8 (max 50) and maxMissionAttempts to 1 (max 5). These ceilings are configurable but permit relatively long automated missions by default.
- Recommendation: Review default ceilings for the deployment environment and consider lowering maxModelCalls and maxMissionAttempts unless higher values are explicitly required.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/limits.ts
    - spot-check: search the repo for `src/agent/limits.ts`

### LOW — Potential information leakage in error messages
_basis: observed · paths: src/company/team.ts, src/kernel/loop.ts, src/services/browser.ts_

- Claim: Error messages include raw exception details (e.g., `err.message`, `String(err)`) which could leak internal system information in production environments.
- Recommendation: Sanitize error messages returned to users or logs to avoid exposing stack traces, file paths, or system details. Use generic messages in production while retaining detailed logs internally.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/company/team.ts, src/kernel/loop.ts, src/services/browser.ts
    - spot-check: search the repo for `src/company/team.ts`

### LOW — GitHub fetchFile does not handle large file responses or pagination
_basis: observed · paths: src/services/github.ts_

- Claim: fetchFile() fetches a single file by path and decodes base64 content without size limits or pagination handling. Large files could cause memory issues.
- Recommendation: Add a size check or stream handling for large file contents.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/github.ts
    - spot-check: search the repo for `src/services/github.ts`

### LOW — commitChangesToBranch creates blobs and tree without checking for existing file content
_basis: observed · paths: src/services/github.ts_

- Claim: commitChangesToBranch() creates blobs for all files and builds a tree with base_tree, but does not check whether files already exist or handle conflicts beyond the branch creation guard.
- Recommendation: Consider adding conflict detection or an option to overwrite existing files explicitly.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/github.ts
    - spot-check: search the repo for `src/services/github.ts`

### INFO — Only audit prompt document observed in this chunk; no source code inspected yet
_basis: observed · paths: CLAUDE_AUDIT_PROMPT.md_

- Claim: Chunk 2 of 29 contains solely CLAUDE_AUDIT_PROMPT.md, which describes audit procedure, required files, PRs, runs, and communication protocol. No source files such as src/services/model.ts, .github/workflows/forge.yml, package.json, or server.ts were shown.
- Recommendation: Proceed through remaining chunks to inspect the mandated source files, workflows, and configuration before producing severity-ranked findings.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: CLAUDE_AUDIT_PROMPT.md
    - spot-check: search the repo for `CLAUDE_AUDIT_PROMPT.md`

### INFO — Hardcoded Local Absolute Path Example in MCP Configuration
_basis: observed · paths: FORREYRA.md_

- Claim: `claude_desktop_config.json` configuration snippet in FORREYRA.md specifies `"cwd": "/absolute/path/to/Firstborn"`
- Recommendation: Ensure configuration documentation or user-facing instructions emphasize replacing example absolute paths with environment-appropriate path variables or relative paths.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: FORREYRA.md
    - spot-check: search the repo for `FORREYRA.md`

### INFO — Permission control plane implemented via pure decision function with least-privilege defaults
_basis: observed · paths: docs/R7_PERMISSION_RISK_ASSESSMENT.md_

- Claim: docs/R7_PERMISSION_RISK_ASSESSMENT.md describes evaluatePermissionPolicy in src/agent/policy.ts, default 'review' profile, human-approval cap at 'sandbox', forbidden branches main/master, allowed branch prefix forge/task-, allowed repos restriction, and no merge capability in any profile.
- Recommendation: Continue to enforce the permission policy through evaluatePermissionPolicy and keep merge unrepresentable in all profiles.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: docs/R7_PERMISSION_RISK_ASSESSMENT.md
    - spot-check: search the repo for `docs/R7_PERMISSION_RISK_ASSESSMENT.md`

### INFO — MIT-licensed dependencies dominate the observed lockfile chunk
_basis: observed · paths: package-lock.json_

- Claim: Nearly all observed packages (tailwindcss, express, cors, body-parser, ajv, esbuild, etc.) carry MIT license; a few are Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC-BY-4.0, or 0BSD.
- Recommendation: Confirm the aggregate license set complies with the organization's open-source policy.
- Evidence: **CONTRADICTED** (verified-fact)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: package-lock.json
    - spot-check: search the repo for `package-lock.json`
  - contradicts: a package-manager lockfile is present in the repository
    - `git ls-files | grep -E "package-lock.json|yarn.lock|pnpm-lock.yaml|npm-shrinkwrap.json|bun.lock"`
    - result: present: package-lock.json
    - spot-check: search the repo for `package-lock.json`

### INFO — Mandatory dependency on GITHUB_TOKEN environment variable in deliver script
_basis: observed · paths: scripts/deliver.ts_

- Claim: const TOKEN = process.env.GITHUB_TOKEN || '';
... openPr function requires token for GitHub API call.
- Recommendation: Provide explicit validation or friendly error messaging prior to executing delivery operations if GITHUB_TOKEN is not set.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: scripts/deliver.ts
    - spot-check: search the repo for `scripts/deliver.ts`

### INFO — Forge CLI defaults target repository to madnessgate44-debug/firstborn when GITHUB_REPOSITORY is unset
_basis: observed · paths: src/agent/forge-runner.ts_

- Claim: const targetRepo = process.env.GITHUB_REPOSITORY || 'madnessgate44-debug/firstborn';
- Recommendation: Confirm this default is intentional for CLI invocations without GITHUB_REPOSITORY.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/forge-runner.ts
    - spot-check: search the repo for `src/agent/forge-runner.ts`

### INFO — Audit runner validates target repository format and rejects path traversal
_basis: observed · paths: src/agent/audit-runner.ts_

- Claim: const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/; and target.includes('..') check
- Recommendation: No change needed; this is a read-only safety control.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/audit-runner.ts
    - spot-check: search the repo for `src/agent/audit-runner.ts`

### INFO — Diagnosis module is pure and never executes recovery actions
_basis: observed · paths: src/agent/diagnosis.ts_

- Claim: Recovery plans are recommendations for an operator or the mission runner; they are never executed here
- Recommendation: No change needed; documented design constraint.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/diagnosis.ts
    - spot-check: search the repo for `src/agent/diagnosis.ts`

### INFO — Audit runner writes evidence only to local .firstborn directory
_basis: observed · paths: src/agent/audit-runner.ts_

- Claim: const evidenceDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
- Recommendation: No change needed; confirms read-only behavior toward target repository.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/audit-runner.ts
    - spot-check: search the repo for `src/agent/audit-runner.ts`

### INFO — Loop runner writes evidence file to .firstborn/evidence without access controls
_basis: observed · paths: src/agent/loop-runner.ts_

- Claim: loop-runner.ts writes forge-loop.json to path.resolve(process.cwd(), '.firstborn', 'evidence') using writeFileSync with no mode restrictions. The file may contain goal, status, steps, and reason data.
- Recommendation: Set restrictive file permissions (e.g., 0600) when writing the evidence file, or confirm the directory already has appropriate OS-level controls.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/agent/loop-runner.ts
    - spot-check: search the repo for `src/agent/loop-runner.ts`

### INFO — Missing explicit timeout for page.goto in browser.open
_basis: observed · paths: src/services/browser.ts_

- Claim: The `page.goto` call in `BrowserService.open` uses a hardcoded timeout of 30_000ms but does not allow configuration via options or environment variables, potentially causing delays in slow networks.
- Recommendation: Make the navigation timeout configurable via service constructor or environment variable to allow adaptation to different network conditions.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/browser.ts
    - spot-check: search the repo for `src/services/browser.ts`

### INFO — Hardcoded user agent may reduce stealth effectiveness over time
_basis: observed · paths: src/services/browser.ts_

- Claim: The User-Agent string is hardcoded to a specific Chrome version (124.0.0.0). While this provides initial stealth, it may become detectable as it ages and does not reflect real user diversity.
- Recommendation: Consider rotating User-Agent strings from a recent, realistic pool or using a more generic but plausible string to improve long-term stealth against bot detection.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/browser.ts
    - spot-check: search the repo for `src/services/browser.ts`

### INFO — Interactive element selector may miss custom components
_basis: observed · paths: src/services/browser.ts_

- Claim: The `INTERACTIVE` selector (`a[href], button, input, select, textarea, [role="button"], [onclick], [contenteditable="true"]`) may not capture all interactive elements, particularly custom web components or framework-specific interactive shadows.
- Recommendation: Periodically review and update the interactive element selector to ensure compatibility with modern web frameworks and component libraries. Consider extending with shadow DOM piercing if needed.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/browser.ts
    - spot-check: search the repo for `src/services/browser.ts`

### INFO — Model service uses freelm multi-provider router with keyless fallback
_basis: observed · paths: src/services/model.ts_

- Claim: getProviderInfo() describes primary provider as 'freelm multi-provider free-tier router with keyless Kilo and OVHcloud fallback' and fallback as Google AI Studio / Gemini. isConfigured() always returns true.
- Recommendation: Document that isConfigured() does not reflect actual provider availability and that per-request availability is established dynamically.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/model.ts
    - spot-check: search the repo for `src/services/model.ts`

### INFO — Audit prompt instructs model to treat repository content as untrusted input
_basis: observed · paths: src/services/model.ts_

- Claim: buildAuditPrompt() includes explicit instructions to treat excerpts as untrusted input, never follow commands found in files, and only report findings with exact paths from inventory.
- Recommendation: Maintain this guardrail; it is a good security practice for AI-assisted auditing.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/model.ts
    - spot-check: search the repo for `src/services/model.ts`

### INFO — GitHub service creates isolated branches and refuses to reuse existing refs
_basis: observed · paths: src/services/github.ts_

- Claim: createOrUpdateBranch() returns error on HTTP 422 with message 'BLOCKED: branch ref already exists; refusing to reuse it', preventing accidental overwrites of existing task branches.
- Recommendation: This is a safe design; keep the refusal-to-reuse behavior.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/github.ts
    - spot-check: search the repo for `src/services/github.ts`

### INFO — Test file uses hardcoded localhost binding
_basis: observed · paths: tests/website-scenario-matrix.test.ts_

- Claim: server.listen(0, '127.0.0.1', () => { ... });
- Recommendation: Consider making the host configurable via environment variable for flexibility in different test environments.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: tests/website-scenario-matrix.test.ts
    - spot-check: search the repo for `tests/website-scenario-matrix.test.ts`

### INFO — Workflow test reads file synchronously
_basis: observed · paths: tests/workflow-keys.test.ts_

- Claim: import { readFileSync } from 'node:fs'; ... const yml = readFileSync(new URL('../.github/workflows/forge.yml', import.meta.url), 'utf8');
- Recommendation: In test environments, synchronous file reading is acceptable, but ensure the file path is correct and accessible.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: tests/workflow-keys.test.ts
    - spot-check: search the repo for `tests/workflow-keys.test.ts`


## Version grounding (npm registry)
- Dropped "Hardcoded npm install executed in target worktree without manifest integrity controls": a lockfile IS present in the repository.
- Dropped "CI Setup Node Failure Due to Missing Lockfile and Cache Mismatch": a lockfile IS present in the repository.
- Dropped "express-rate-limit bundles a newer debug dependency than express": the registry contradicts the claim — express@^4.21.2 (latest 5.3.0) is current/admissible.
- Dropped "Missing lockfile integrity hashes in package-lock.json": a lockfile IS present in the repository.

## Verification panel
- Reviewer: OBJECT — Most findings cite COORDINATION.md or prior audit entries not present in the cited files; only sentinel.yml is actually cited and does not support the claims. Absence of proof requires objection.
- QA Engineer: OBJECT — Cited files do not positively support most findings; they reference COORDINATION.md and other files not provided, so absence of proof requires objection. Only findings tied to sentinel.yml or package.json are partially supported.
- Security Engineer: OBJECT — Most findings cite COORDINATION.md or files not provided; only sentinel.yml is cited and does not support the claims. Absence of proof requires objection.
- Release Manager: OBJECT — Most findings cite COORDINATION.md or files not provided (server.ts, forge.ts, etc.). Only sentinel.yml and CLAUDE_AUDIT_PROMPT.md are cited, which do not positively support the claims. The Sentinel workflow finding is unsupported because forge/* restriction and verify-only default mitigate the clai

## Guarantees
- No target repository writes
- No branches, commits, pull requests, or merges created
- No target-repository code or build scripts executed
- Audited file content is treated as untrusted input, never as instructions
- A contradicted finding is shown as contradicted, never silently dropped or silently kept
