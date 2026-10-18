# Full-coverage audit verdict — PR #116 must not merge yet

- **Audited target:** `madnessgate44-debug/Firstborn` @ `7b832d61c183f138a5db8b5bef1806f6288d8b73`
- **PR under review:** #116 `feat/full-coverage-audit` @ `685026b3` (draft, base `main`)
- **Run evidence:** Actions run `39074720296` (full), `39075485016` (sampled control on the PR branch),
  `39075692475` (sampled control on `main`), `38790744542` (pre-change full run on `main`)
- **Verdict:** the sweep and its coverage ledger are correct and worth keeping. The shared
  routing policy bundled into the same PR is **not** safe to merge as written.
- **No writes were made to the target, no branches were created on the target, no target code
  was executed.** All actions were read-only plus a local, throwaway `freelm` probe.

---

## 1. Acceptance test and result

The merge rule set for this work was explicit:

> If the report shows `Files examined: N/N (100%)` and every chunk answered, merge #116.
> If any chunk failed, send me the report and we'll see why before merging.

Observed result of the full run (`39074720296`, 2026-10-17):

```
Status: COMPLETED | 47 finding(s); 2 contradicted; examined 72/100 files (72%)
- Files examined: 72/100 (72%)
- Chunks: 21/29 answered
- Failed chunks: 8 of 29
- Route: kilo / nvidia/nemotron-3-super-120b-a12b:free
```

**72%, not 100%. Eight chunks failed.** The acceptance condition was not met, so #116 was
not merged and no branch was pushed to the target.

The failure mode is identical in all eight chunks. From the run artifact
(`company-audit-full.json` → `chunkNotes`):

| Chunk | Files | Note |
|-------|-------|------|
| chunk-4  | 1 | model returned no parseable JSON |
| chunk-10 | 1 | model returned no parseable JSON |
| chunk-16 | 3 | model returned no parseable JSON |
| chunk-17 | 2 | model returned no parseable JSON |
| chunk-19 | 2 | model returned no parseable JSON |
| chunk-20 | 7 | model returned no parseable JSON |
| chunk-24 | 4 | model returned no parseable JSON |
| chunk-27 | 8 | model returned no parseable JSON |

The 26 files never examined include `src/company/model.ts`, `src/company/evidence.ts`,
`src/company/registry.ts`, `src/company/deliver.ts`, `src/company/judge.ts`,
`src/company/roles.ts`, `src/agent/tools.ts`, and 12 test files — that is, most of the
engine this PR touches.

---

## 2. Correction to an earlier claim

An earlier analysis asserted that `freelm` gives keyless endpoints `priority: 100` meaning
they are tried **first**, and described the routing change as a "priority inversion".
**That claim was wrong and is withdrawn.** The ordering was measured directly rather than
inferred from reading minified code:

```
keyless:true -> google(p=0) , groq(p=0) , kilo(p=100) , ovh(p=100)
keyless:auto -> google(p=0) , groq(p=0)
```

Lower number wins. Keyed providers sort **first**; the anonymous keyless endpoints sort
**last**. The premise stated in #116 — that keyless is a genuine last resort — is correct.

What follows is the mechanism that actually holds, established by test, not by reading.

---

## 3. Root cause

The defect is not ordering. It is **pool membership**.

On `main`, hard-tier work used:

```ts
keyless: hasProviderKeys ? 'auto' : true,   // keyed-only pool when keys exist
```

#116 replaced this for every tier with:

```ts
keyless: keylessOption(this.env),           // always true
```

`'auto'` builds a keyed-only pool when keys are present. `true` **always appends** the
anonymous Kilo/OVHcloud routes to the pool. A controlled probe of what that changes when a
keyed free tier is rate-limited (`429`):

```
keyless:true   -> calls: groq,kilo,ovh,google,groq,kilo   WINNER: kilo
keyless:'auto' -> calls: groq,google,groq,google,google   ERROR: NoProvidersAvailable
```

The fallback is real and is reached last. But the outcome — which model actually answers —
is what matters, and the runs measure it directly.

### The runs, same secrets, same target, same hour

| Ref | Path | Route actually used |
|-----|------|---------------------|
| `main` | sampled | `google/gemini-flash-latest`, `gemini-3.5-flash`, `gemini-2.5-flash` |
| `feat/full-coverage-audit` | sampled | `kilo/nvidia/nemotron-3.5-super-vl:free` |
| `feat/full-coverage-audit` | full | `kilo/nvidia/nemotron-3-super-120b-a12b:free` |

The `main` control run was dispatched deliberately: identical secrets, identical target,
dispatched within the same minute. `main` routes to Gemini. The #116 branch routes to a
keyless NVIDIA model. That isolates the routing change as the differentiator.

The consequence for the sweep: the anonymous Kilo endpoint is capped at **~3 requests per
minute per IP** (`static tiers = { free: { rpm: 3, rpd: null } }`). A 29-chunk sweep exceeds
that, and a weaker model begins answering in prose rather than JSON — which is exactly the
recorded failure, `model returned no parseable JSON`.

### What is inferred rather than observed

`ModelService.complete` accumulates a `routeErrors[]` array from `onEvent`, but the audit
CLI never prints it. The logs therefore do **not** state why the keyed providers did not
serve these calls (quota exhaustion vs. model discovery vs. hedging). The routing change is
proven to be the differentiator by the control run; the specific trigger is inferred.

This is a reporting gap worth fixing on its own: an audit that silently degrades to a weaker
route while recording the reason and never surfacing it is a truthfulness defect of the same
family this work order exists to close.

---

## 4. This was not a flake

Two earlier runs on the same branch were already degraded and were read as successes:

| Run | Coverage | Failed chunks | Route |
|-----|----------|---------------|-------|
| `39054165571` | 127/133 (95%) | 3 of 62 | `kilo/nvidia/nemotron-3.5-super-vl:free` |
| `39055849703` | 121/133 (90%) | 4 of 62 | `kilo/nvidia/nemotron-3-super-120b-a12b:free` |

Both reported `Status: COMPLETED` in the headline. Nothing surfaced that the run had quietly
fallen back to a weaker route and lost chunks. The coverage ledger added by #116 is what made
the 72% run legible at all — the feature works, and it is what caught this.

---

## 5. What #116 gets right (keep all of it)

- **The coverage ledger is correct and load-bearing.** It refused to round 72% up to 100%.
  This is the single most important requirement of the work order and it is satisfied.
- **Whole-file chunking works.** No file was silently truncated; the failure is the model's
  answer, not the input.
- **The verification panel's four OBJECT verdicts were not evidence the findings were wrong.**
  They were caused by the cited files not being shown to the panel at all: `renderCitedFiles`
  used `break` when a file did not fit the budget, so one large first file stopped every later
  cited file from reaching the prompt. The panel was asked to judge findings against files it
  had never been given. That budget bug is fixed in #116 (skip instead of break, per-file cap
  12000, total 60000, most-cited file first, and the prompt now lists the files that were not
  provided so the panel reports them UNVERIFIED instead of objecting).

The defect was confined to the routing line and the panel budget. The sweep itself is sound.

---

## 6. Recommended minimal fix

**Status: implemented on `feat/full-coverage-audit` (PR #116).**

1. Restore tiered routing: `'auto'` for hard work, keeping the shared policy module from
   `src/model-routing.ts` as the single source of truth. **Done** — `keylessOption(env, tier)`
   returns `'auto'` only when `tier === 'hard'` and a provider key is present and the keyless
   lock is off. `src/services/model.ts` calls it with no tier and keeps `true`, so Forge's
   primary engine is unchanged.
2. Keep the sweep, the coverage ledger, and the whole-file chunking unchanged. **Done** — the
   sweep, ledger, and chunking are untouched; the status is now COMPLETED | PARTIAL | BLOCKED,
   with COMPLETED requiring zero failed chunks and every file examined.
3. Surface `routeErrors` in the audit CLI output, so a degraded route is visible rather than
   recorded and discarded. **Done** — the report carries a "Routes used" line with per-route
   chunk counts, a "DEGRADED ROUTE" warning when any answering route is Kilo/OVHcloud, and a
   failed chunk's note now carries the last three route errors.
4. Re-run the full sweep. Merge only on `Files examined: N/N (100%)` with every chunk answered.
   **Pending** — the CLI exits non-zero for any status other than COMPLETED, so the re-run
   cannot be read as green unless it is genuinely complete.

Caution: the routing line also governs `src/services/model.ts`, so changing it is a
behavioural change to Forge's primary engine, not only the audit path. It should be made
deliberately and reviewed as such.

---

## 7. "globe" comments — most likely "Claude"

A request was made to "check globe comments on the changes that we made". "globe" most likely
means **Claude**: those comments are chat messages in the owner's Claude session, not GitHub
comments. They are not visible to, or stored by, this repository, and nothing here can read
them.

What is verifiable is the GitHub side, and it is empty:

- **PR #116: zero comments, zero reviews, zero review threads** — checked via the REST
  reviews and comments endpoints, GraphQL `reviewThreads`, and commit-level comments.
- Every PR and issue in both `madnessgate44-debug/Firstborn` and `madnessgate44-debug/Amina`:
  the only commenters that have ever existed are `madnessgate44-debug` and
  `openhands-ai[bot]`. No third party and no bot named "globe".
- The only literal match in the account is Amina PR #5, whose comment refers to the
  **globe icon** in the Codespaces UI beside the forwarded port. That is a UI element, not
  review feedback.

So: **no such comments exist on GitHub.** If Claude raised specific points in that session,
they need to be pasted in, because they are not retrievable from here.

---

## 8. Related item — "PR C" is Phase C of the Amina work order

"PR C" is not a pull request. It is **Phase C — verify and report** in
`Amina/docs/AMINA_PROJECT_MEMORY_AND_FORGE_ORDERS.md` (items 13–17):

- 13: run lint, type checks, build, existing tests, and new targeted tests.
- 14: add scenario tests for the real student journey (FEED swipe → Nour; curriculum lesson →
  Nour; Library → lesson → Nour; HOME schedule/review from evidence; interrupted-session resume).
- 15: report each requirement as PASS / PARTIAL / FAIL / BLOCKED / NOT VERIFIED, with evidence,
  distinguishing static tests from browser/runtime verification.
- 16: list changed files and why, unresolved risks, owner decisions, the PR link, and the exact
  verification status.
- 17: do not mark the product "sellable" merely because the build passes.

It correctly waits on the outcome of this audit. Verified present in the Amina repository at the
audited commit; the file and the five items exist as described.

---

## 9. Guarantees for this review

- No target-repository writes, branches, commits, pull requests, or merges.
- No target-repository code or build scripts executed.
- No secrets, tokens, or credentials are reproduced in this document.
- `freelm` was exercised only through a local, throwaway script in the audit workspace,
  since deleted.
