# Forge Capability Audit — 2026-10-12

## Executive verdict

**Forge is a bounded coding agent with useful safety and verification primitives, not yet a proven general-purpose repository engineer.** It can inspect GitHub metadata/source, plan bounded edits, validate exact anchors, run a fixed command registry, record evidence, and open review PRs when permissions permit. Key gaps remain in cross-language verification, source-level audit depth, requirement-evidence precision, and repeatable end-to-end proof.

This is a read-only capability assessment of Firstborn's current `main` plus review of relevant open work. No Smart Farm files were changed. This report itself does not change agent behavior.

## Requirements and acceptance criteria

1. **Repository understanding:** identify repo, base branch/SHA, repository instructions, language, dependencies, build/test entry points, CI and relevant source before planning. Report actual inspected files and distinguish missing files from API/permission errors.
2. **Root-cause audit:** trace defects across source and tests; cite exact file/line evidence; include severity, confidence and reproducible failure path; label confirmed versus suspected.
3. **Safe implementation:** make bounded changes on isolated branches, preserve unrelated work, validate paths/anchors and stop safely on failed stages. Never write directly to default branch.
4. **Portable verification:** select target checks from repository manifests and CI, execute approved commands in an isolated no-secrets environment, and preserve command, output, exit code and duration. Unsupported environments must be BLOCKED, not falsely passed.
5. **Requirement-level proof:** each numbered requirement maps to objective acceptance criteria and direct evidence. Unproven behavioral/manual criteria remain PENDING.
6. **Failure recovery:** distinguish transient provider/runtime errors, malformed plans, patch failures, target-test failures and permission blockers. Retries must be bounded and diagnostics must inform repairs.
7. **End-to-end proof:** demonstrate task intake → inspect → plan → edit → target checks → diff review → commit → PR/evidence on representative existing repositories. The tested tree must match the committed tree.

## Implementation map

| Capability | Evidence on current main | Assessment |
| --- | --- | --- |
| Repository metadata and source retrieval | `src/services/github.ts`: repository inspection, branch SHA, file reads, recursive tree listing. | **Partial.** Useful API foundation; some methods return empty lists/null on failures, which can obscure the cause. |
| Persistent instructions | `AGENTS.md`: inspect-first, requirements-to-evidence, minimal diffs, real tests, no direct-main writes. | **Policy present.** Runtime enforcement and test coverage still require independent verification. |
| Plan and patch validation | `src/agent/forge.ts`, `src/agent/stages.ts`: plan-shape checks, protected paths, bounded patch, exact-anchor edits and staged validation. | **Useful foundation.** Model-generated anchors and plans can still fail; bounded retries reduce risk but do not guarantee completion. |
| Retry ceilings | `src/agent/limits.ts` and `forge.ts`: bounded files/edits/patch bytes/model calls/repairs/runtime and failure classification. | **Present.** Need a current, repeatable live failure matrix. |
| Target test execution | `src/services/test-runner.ts`: fixed command allowlist, `spawn` with `shell:false`, minimal environment and timeouts. | **Safe but narrow.** Primarily npm/TypeScript/Git; no Gradle/Android or general project-aware command discovery. |
| Requirement evidence | `evaluateRequirementEvidence` in `src/agent/forge.ts`; `tests/forge.test.ts` covers basic pass/pending/fail behavior. | **Partial.** Text matching can associate checks heuristically; a green build does not prove arbitrary behavior. |
| Cross-repository audit | Current `.github/workflows/forge.yml` on main has coding mode. PR #37 proposes a separate read-only inventory. | **Not deployed on main.** Proposed PR #37 explicitly marks runtime checks NOT_RUN and does not execute target code. |
| Live multi-repo engineering | Historical bounded missions have passed; PR #36 reports 7/8 live missions reached apply with green target checks after a proposed fix. | **Not general-purpose proven.** Narrow successes do not establish arbitrary repository or multi-stage reliability. |

## Findings

### G1 — Audit mode is inventory-first, not a deep code audit
**Evidence:** PR #37 describes metadata, file inventory, manifests, workflows and key excerpts; it explicitly does not execute target scripts/builds and marks runtime checks `NOT_RUN`.

**Impact:** useful for prerequisites and orientation, but cannot substantiate many behavioral defects or verify fixes.

**Required change:** separate phases for inventory, source tracing, test mapping and optional sandboxed execution. Keep static conclusions separate from observed runtime results.

### G2 — Verification commands are too narrow for arbitrary repositories
**Evidence:** `src/services/test-runner.ts` authorizes npm/TypeScript/Git commands. Smart Farm is Android/Kotlin; its CI checks were run outside Forge.

**Impact:** Forge cannot independently verify many non-JavaScript projects.

**Required change:** detect candidate commands from trusted manifests and CI, then execute approved templates in an isolated no-secrets environment. Never execute arbitrary model-supplied shell strings. Start with npm and Gradle/Android.

### G3 — GitHub API failures can be confused with missing content
**Evidence:** `GitHubService.listRepositoryFiles` can return an empty list on API failure; `fetchFile` can return null. Callers may not distinguish missing content from denial, rate limit or network error.

**Impact:** audits can omit evidence or misdiagnose access issues as repository gaps.

**Required change:** typed outcomes such as FOUND, NOT_FOUND, DENIED, RATE_LIMITED, TRUNCATED and NETWORK_ERROR, plus explicit pagination/truncation reporting.

### G4 — Acceptance evidence remains partly heuristic
**Evidence:** `evaluateRequirementEvidence` matches criterion text to command names; existing tests cover basic cases, not ambiguous matches or behavioral requirements.

**Impact:** automated PASS may overstate what a check proves.

**Required change:** explicit criterion-to-check mapping and evidence types (automated, static, manual). Default to PENDING unless evidence directly covers the criterion.

### G5 — Patch-anchor reliability fix is proposed but not on main
**Evidence:** PR #36 changes `src/agent/forge.ts`, `src/services/model.ts` and `tests/forge.test.ts`. Its description reports 8 live keyless missions and improvement from 5/8 to 7/8 missions reaching apply with green checks. Branch comparison shows PR #36 is one commit ahead of main; it is open and draft.

**Impact:** current main cannot be credited with the proposed fix, and the remaining create-test failure shows that the full mission is not yet reliable.

**Required change:** review the complete diff and checks, verify the regression suite, then repeat the live mission matrix on the tested commit. Do not infer readiness from PR description alone.

### G6 — Workflow feature claims must be tied to deployed revision
**Evidence:** main's `.github/workflows/forge.yml` is coding-only; PR #37 has the separate audit workflow. PR #37 is open and draft.

**Impact:** operators may believe audit mode is active before it is merged and run.

**Required change:** every capability report should name branch/SHA, workflow path and actual run URL.

## Priority roadmap

1. **P0 — Establish baseline:** record current main SHA; inspect open PRs and latest checks; compare PR #36 and #37 with main. Do not merge automatically.
2. **P1 — Portable verification:** define a command-discovery contract grounded in repository manifests/CI; implement safe templates for npm and Gradle/Android first. Preserve `shell:false`, minimal environment, timeouts, no secrets and no default-branch writes.
3. **P1 — Accurate evidence:** replace fuzzy text association with explicit criterion-to-check links; keep unsupported requirements PENDING.
4. **P1 — Real audit pipeline:** add source-level finding evidence, test mapping, severity/confidence, and separate static/runtime sections. Runtime must be sandboxed and must never receive write credentials.
5. **P2 — Controlled compatibility matrix:** Firstborn (TypeScript), Smart Farm (Android/Kotlin), and one additional non-JS repository. Begin with read-only inspection, then a tiny approved patch, then tests/PR only when authorized.
6. **P2 — Failure matrix:** test malformed JSON, wrong anchors, provider rate limits, failed tests, timeouts, missing wrapper/toolchain and GitHub 403. Report denominators, raw evidence and final statuses.

## Controlled acceptance tests

| Test | Pass condition |
| --- | --- |
| Read-only repository inspection | Correct repo/branch/SHA, instructions, source/test/config inventory; no writes. |
| Static defect audit | Every finding has exact source evidence, severity, confidence and reproducible reasoning; uncertain claims are labeled. |
| Missing toolchain | Explicit BLOCKED; no false PASS or unsafe workaround. |
| Tiny single-file change | Isolated branch, correct diff, relevant target checks pass, no unrelated changes. |
| Multi-file staged change | Each stage has a check; failure skips remaining stages and prevents successful final claims. |
| Requirement proof | PASS only with direct evidence; behavioral/manual requirements stay PENDING without it. |
| Failure/permissions | Retries terminate within ceilings; failed checks prevent commit/PR; permission errors remain BLOCKED. |
| Full mission | Evidence ties base SHA, patch, raw checks, tested tree SHA, commit, PR and requirement matrix together. |

## Decision

**Do not treat Forge as fully autonomous for arbitrary repositories yet.** The next engineering milestone should combine safe cross-language verification with accurate evidence semantics, then prove both through controlled live runs. Do not merge PRs solely because their descriptions claim success; inspect diffs and latest checks against the current base first.

## Source links

- Current workflow: https://github.com/madnessgate44-debug/Firstborn/blob/main/.github/workflows/forge.yml
- Core agent: https://github.com/madnessgate44-debug/Firstborn/blob/main/src/agent/forge.ts
- GitHub inspection service: https://github.com/madnessgate44-debug/Firstborn/blob/main/src/services/github.ts
- Safe command registry: https://github.com/madnessgate44-debug/Firstborn/blob/main/src/services/test-runner.ts
- Stage validation: https://github.com/madnessgate44-debug/Firstborn/blob/main/src/agent/stages.ts
- Requirement evidence tests: https://github.com/madnessgate44-debug/Firstborn/blob/main/tests/forge.test.ts
- PR #36, anchor reliability fix proposal: https://github.com/madnessgate44-debug/Firstborn/pull/36
- PR #37, read-only audit proposal: https://github.com/madnessgate44-debug/Firstborn/pull/37
- Smart Farm CI unit checks: https://github.com/madnessgate44-debug/smart-farm/actions/runs/38283636747
- Smart Farm Android debug APK build: https://github.com/madnessgate44-debug/smart-farm/actions/runs/38283699012

## Limitations

This report is based on source/API inspection and previously observed CI/missions. Firstborn's test suite was not executed in a local runtime during this audit. No Smart Farm code was changed.
