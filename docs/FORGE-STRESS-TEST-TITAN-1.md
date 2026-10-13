# FORGE STRESS TEST — MISSION `TITAN-1`

An adversarial, independently-gradable mission designed to test whether Forge can complete a
*complicated* multi-file engineering task at a level comparable to a capable human/agent coder —
and to expose exactly where its mission engine breaks.

- **Author**: OPENHANDS (auditor)
- **Status**: DESIGN — not yet run
- **Target of test**: the merged Forge on `main` (`30e4f41`)
- **Design principle**: every requirement is objectively checkable; the reference solution is
  reproducible by an independent agent, so Forge can be graded against a known-good answer.

---

## 1. Purpose and success bar

Forge today excels at *single-edit, single-file* missions. `TITAN-1` forces six coupled
capabilities at once and is designed so a partial engine fails visibly rather than silently:

| Capability forced | Why single-file missions don't test it |
| :-- | :-- |
| Cross-file API change | Forge must keep a type, its producer, and its consumers consistent |
| Ordered, dependent stages | Stage 2's correct anchor only exists after Stage 1 applies |
| Duplicate-anchor disambiguation | A naive `find` string appears twice; Forge must widen it |
| Large-file refusal / bounded context | A >16,000-char file must be skipped or blocked, not half-read |
| Guards / compile-time invariants | The new logic must throw on malformed input, and `tsc` must prove it |
| Green build + tests | `npm run lint`, `npm test`, `npm run build` must all exit 0 |

**Success bar**: Forge reaches `PR_OPENED` (or `VERIFYING` with all checks green) with a patch
that is *semantically equivalent* to the reference solution and passes every hidden check.

---

## 2. The target repository seed

`TITAN-1` runs against a small, purpose-built Node/TypeScript repo so the task can be graded
deterministically. Seed it once (owner/repo chosen by the operator, e.g.
`madnessgate44-debug/firstborn-titan`):

```
firstborn-titan/
├─ package.json          # scripts: lint (tsc --noEmit), test (node --test), build (tsc)
├─ tsconfig.json
├─ AGENTS.md             # "inspect before editing; minimal changes; no unrelated files"
├─ src/
│  ├─ types.ts           # TaskStatus union, Mission interface  <-- ANCHOR A
│  ├─ ledger.ts          # class MissionLedger              <-- ANCHOR B (duplicate-anchor trap)
│  ├─ report.ts          # builds a MissionReport from a MissionLedger
│  ├─ legacy_dump.ts     # >16,000 chars; must be skipped or blocked, never half-edited
│  └─ index.ts           # re-exports
└─ tests/
   └─ ledger.test.ts     # pre-seeded tests that MUST continue to pass
```

The seed deliberately contains:
1. A **duplicate anchor** — the line `return this.entries.length;` appears in two methods of
   `ledger.ts`, so a naive edit for one is ambiguous.
2. A **large decoy file** (`legacy_dump.ts`) that exceeds the 16,000-char read limit.
3. A **type coupling** — `TaskStatus` in `types.ts` is consumed by both `ledger.ts` and `report.ts`.
4. **Pre-seeded passing tests** that a wrong patch will break.

---

## 3. The mission prompt (exact text given to Forge)

> **Title**: Add lifecycle transitions and an auditable ledger
>
> **Description**: In `src/types.ts` add a new status value `'CANCELLED'` to the `TaskStatus`
> union. In `src/ledger.ts` add a method `cancel(id: string)` that moves a task from any
> non-terminal status to `'CANCELLED'`, throws a `RangeError` for an unknown id, and throws an
> `Error` if the task is already terminal (`'DONE'` or `'CANCELLED'`). In `src/report.ts` include a
> `cancelled` count derived from the ledger. Do not modify `legacy_dump.ts`, `package.json`, or the
> existing tests. Every requirement's acceptance criteria MUST be a check command that exists in
> the repo (`npm run lint`, `npm test`, `npm run build`).

This is deliberately *hard for a single-shot model*: it needs 3 coupled files, a disambiguated
anchor, correct error semantics, and it must not touch the decoy or manifests.

---

## 4. Independent reference solution (the answer key)

An independent agent (me) produces this exact outcome; Forge is graded against it:

1. `src/types.ts`
   - `export type TaskStatus = 'PENDING' | 'ACTIVE' | 'DONE' | 'CANCELLED';`
2. `src/ledger.ts`
   - Add `cancel(id: string): void` that:
     - looks up the entry; `throw new RangeError(\`Unknown task id: ${id}\`)` if absent;
     - if status is `'DONE'` or `'CANCELLED'` → `throw new Error('Task is already terminal')`;
     - else sets `status = 'CANCELLED'`.
   - The edit anchor must be widened past the duplicate `return this.entries.length;`.
3. `src/report.ts`
   - `cancelled: this.ledger.list().filter((e) => e.status === 'CANCELLED').length` added to the
     report object.
4. `tests/ledger.test.ts` — **unchanged**, still passes.
5. `legacy_dump.ts`, `package.json`, `tsconfig.json` — **unchanged**.

---

## 5. Grading rubric (objective, 12 checks)

Each check is pass/fail with raw evidence required. Forge is judged per-check, and a mission
score is the fraction of *applicable* checks passed.

| # | Check | Method | Expected |
| :-- | :-- | :-- | :-- |
| G1 | `TaskStatus` includes `'CANCELLED'` | grep `src/types.ts` | present |
| G2 | `cancel(id: string)` exists | grep `src/ledger.ts` | present |
| G3 | Unknown id throws `RangeError` | run seeded test `cancel(unknown)` | throws RangeError |
| G4 | Terminal task throws `Error` | run seeded test `cancel(done)` | throws Error |
| G5 | Happy path sets `'CANCELLED'` | run seeded test | status becomes CANCELLED |
| G6 | Report exposes `cancelled` count | grep `report.ts` + seeded test | correct integer |
| G7 | Duplicate anchor handled (not ambiguous) | Forge logs: no "anchor is ambiguous" failure | resolved |
| G8 | Large decoy untouched | `git diff --name-only` | no `legacy_dump.ts` |
| G9 | Manifests untouched | `git diff --name-only` | no `package.json`/`tsconfig.json` |
| G10 | `npm run lint` on patched tree | exit code | 0 |
| G11 | `npm test` on patched tree | exit code | 0 |
| G12 | `npm run build` on patched tree | exit code | 0 |

**Scoring**
- **Tier A (matches capable agent)** — G1–G12 all pass, mission `VERIFYING`/`PR_OPENED`.
- **Tier B (near-miss)** — ≥9 pass and every failure is reported honestly (no false PASS).
- **Tier C (fails silently)** — any requirement reported `PASS` without criterion evidence, or a
  modified file that was never tested. This is the critical failure mode.

---

## 6. What this test is engineered to expose (predicted from the code audit)

These are concrete, code-grounded weaknesses I expect `TITAN-1` to hit. Each is a candidate
workstream for ChatGPT's stress-testing plan.

1. **R5 staging is not wired into `executeTask`.** `runStagedMission` exists and is unit-tested,
   but `executeTask` applies the whole patch at once (`applyChangesToWorktree`). *Definition of
   done for M3 is therefore load-bearing* — without it, "ordered dependent stages" (G7) relies on
   one model call getting everything right.
2. **`maxRuntimeMs` and `maxRepairAttempts` are dead config.** They are defined and tested in
   `limits.ts` but never read by `executeTask`. Repair counts are hardcoded (`< 2`, `attempt < 3`)
   instead of using `loadForgeLimits().maxRepairAttempts`. A mission can exceed the advertised
   runtime ceiling.
3. **`guardModelCall` is only enforced on the JSON path.** Anchor repairs (line 632) and
   target-check repairs (line 784) and the JSON-repair retry add to `callsCount` without checking
   the ceiling, so `FORGE_MAX_MODEL_CALLS` can be exceeded.
4. **`maxPatchBytes` uses two different enforcement points** (`validatePatch` and the per-file
   16,000-char read limit) with unrelated values; a patch between the two limits is validated but
   never testable.
5. **No file-level dedup in `filesToCommit`.** If the model returns the same path twice, both are
   passed to the commit API; behavior is unverified.
6. **No per-requirement check execution.** Checks run once for the whole patch; a requirement that
   names its own `checkCommands` is graded against global results, so per-criterion independence
   (G3/G4/G5 vs G10–G12) is weaker than the matrix implies.

---

## 7. How the audit is performed (so ChatGPT can reproduce it)

1. Seed the `firstborn-titan` repo from §2 and record its base SHA.
2. Run Forge via the runner with the §3 prompt, `allowPrCreation: false` (grade locally first).
3. Capture the full Forge report JSON (status, requirements[], testResults[], logs, plannedChanges).
4. Apply the same rubric (§5) to the report and to `git diff` of the produced branch.
5. Independently produce the §4 reference solution, run the same hidden tests, and diff the two
   outcomes. **Forge passes Tier A only if its patch is semantically equivalent to the reference
   and no requirement is a false PASS.**

Raw artifacts to attach for ChatGPT: the mission prompt, base/head SHAs, `git diff`, report JSON,
and the rubric table filled with observed exit codes.

---

## 8. Why this is the right "complicated" test

It is small enough to grade exactly, yet it forces the four things single-edit missions never
exercise: cross-file consistency, dependent ordering, anchor disambiguation under a trap, and
refusal to touch forbidden/large files. A capable agent completes it; a partial engine fails *in a
way the rubric localizes to a specific code path* — which is precisely what a stress test should
deliver to the fix plan.
