# AGENTS.md — forge-company

Persistent notes for any agent working in this repository.

## What this repo is

`forge-company` models Forge as a software company: roles, teams, competition,
judges, and a supervisor that integrates the winners. It is **standalone**. It
does not import from or write to the Firstborn repository, and it has its own
`main`.

## Non-negotiables

1. Inspect before changing; never invent paths or capabilities.
2. Smallest change that fixes the root cause. No opportunistic refactors.
3. Real tests with observed exit codes. Never claim a test passed when it did not.
4. No secrets in code, commits, or comments.
5. Push only to isolated branches; never to `main` without explicit human consent.

## Layout

- `src/kernel/loop.ts` — the bounded, hardened agent loop + workspace-safe tools.
- `src/company/roles.ts` — the employees (mandate, authority, tools, brain).
- `src/company/team.ts` — an ordered roster working one job, posting artifacts.
- `src/company/bus.ts` — append-only typed artifact log.
- `src/company/judge.ts` — deterministic, evidence-only scoring.
- `src/company/company.ts` — the supervisor: decompose, compete, integrate.
- `scripts/company.ts` — CLI demo (deterministic scripted employees).

## Invariants to preserve

- Scoring is **evidence-only** and **scope-local**: an attempt never scores on
  another attempt's artifacts.
- Ranking is **deterministic**: ties break by attempt id.
- The company is **bounded**: `maxRoleRuns` caps total work.
- File access is **symlink-safe**: reads and writes resolve real paths and refuse
  anything outside the workspace.

## Verify

- `npm run lint` — `tsc --noEmit`; expect exit 0.
- `npm test` — 36 tests on the real filesystem; expect 0 failures.
