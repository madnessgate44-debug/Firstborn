# Forge — Requirements-to-Evidence & Acceptance Plan (TITAN-1)

This plan numbers every requirement about Forge's behaviour, states an objective
pass/fail criterion, and names the evidence that proves it. It is the audit
contract for the current milestone and the next one.

## A. Behaviour requirements for Forge (the agent under audit)

| ID | Requirement | Acceptance criterion | Evidence |
| :-- | :-- | :-- | :-- |
| A1 | Never report a requirement PASS unless a check named in that requirement's own criteria passed | A requirement whose named check fails on the final attempt is never `PASS` | `tests/forge.test.ts`; live TITAN-1 reqs are PENDING/FAIL when final lint fails |
| A2 | Implement every explicitly named required file | `plannedChanges` contains all named non-doc files | live TITAN-1 `PLANNED` line shows all 3 files |
| A3 | A repair must never silently drop an already-implemented required file | Repair merges by path; a repair omitting a required path is rejected | code + 5-run `PLANNED` retains 3 files |
| A4 | Reject syntactically unbalanced (partial-anchor) edits before applying | `isCodeBalanced` false => change rejected | `tests/titan-fixes.test.ts` |
| A5 | Each file is edited against the current post-edit state of its dependencies | later files see earlier edits | code (`evolvingContext`); observed fewer stale-context errors |
| A6 | Bounded execution: no unbounded loops; ceilings are configurable | mission terminates within `maxModelCalls`/`maxRepairAttempts` | `src/agent/limits.ts`; all runs terminate |
| A7 | Planning cannot abort the mission before the per-file engine runs | truncated bootstrap falls back to explicit files | code (`fallbackPaths`); runs 2-3 of batch 8 no longer die at planning |
| A8 | Fail honestly: unverifiable convergence reports FAIL/PENDING, never green | final failing check => not green | live TITAN-1 batch 9 |

## B. Stress-test (TITAN-1) acceptance

| ID | Requirement | Acceptance criterion | Evidence |
| :-- | :-- | :-- | :-- |
| T1 | Multi-file mission implements all 3 files | all present in plan | `PLANNED` |
| T2 | `CANCELLED` added to `TaskStatus` | `types.ts` change present | `PLANNED` includes `types.ts` |
| T3 | `cancel()` throws `RangeError` (unknown) / `Error` (terminal) | code present + lint passes | final `npm run lint=0` |
| T4 | Report includes a cancelled count | `report.ts` change present | `PLANNED` includes `report.ts` |
| T5 | Legacy dump untouched | `git diff --check` clean, file absent from plan | `PLANNED` excludes `legacy_dump.ts` |
| T6 | Final attempt green | `npm install/lint/test/build/diff` all exit 0 on final attempt | `FINAL_ATTEMPT` + `FINAL_GREEN` |

## C. Current status (evidence, not claims)

- Static gates: `npm run lint` EXIT 0; unit tests **32 passed / 0 failed**.
- FALSE PASS: **eliminated** (A1, A8).
- Silent file drop: **eliminated** (A3).
- Live TITAN-1 success is **endpoint-limited**: the keyless model writes
  non-compiling TypeScript on some runs. Forge now converges when it can and
  fails honestly when it cannot.

## D. Next milestone (M6) — smallest safe step

Harden repair convergence without any permission change:
1. A compile-driven full-file rewrite that dedupes duplicate-identifier diagnostics.
2. An inline `npm run lint` check on the staged tree before committing.
3. Acceptance: 5 live TITAN-1 runs, >=3 `FINAL_GREEN`, zero requirement PASS while a named check fails.

No secrets, tokens, or credentials appear in this document.
