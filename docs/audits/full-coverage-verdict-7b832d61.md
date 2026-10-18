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

## 8. Related item — "PR C" is ambiguous

"PR C" is **ambiguous**, and neither reading should be asserted as fact:

- **In the owner's Claude session**, "PR C" means the **security-hardening task**: injection-safe
  workflow inputs, a private-IP guard for `fetch_url` and browser open, and authentication on
  `/api/coordination`. **It has not been run.**
- **In the Amina work order** (`Amina/docs/AMINA_PROJECT_MEMORY_AND_FORGE_ORDERS.md`), **Phase C
  — verify and report** is items 13–17: run lint/type checks/build/tests; add student-journey
  scenario tests; report each requirement as PASS / PARTIAL / FAIL / BLOCKED / NOT VERIFIED with
  evidence; list changed files, risks, and the PR link; and do not mark the product "sellable"
  merely because the build passes.

Both readings are recorded. Which one is meant is the owner's call, not something this review
can settle from the repository: no `fix/audit-c` branch exists, and no PR is titled "PR C".

---

## 9. Triage — the four live questions

### "Make Amina deployable / can you see the link"

Amina is **not** a static site, so a Vercel/Netlify link is the wrong shape for it. Verified
from the Amina repository at the audited commit:

- It is a long-running Node server: `server.ts` (40 KB Express app), `start` =
  `NODE_ENV=production tsx server.ts`, and `/api/health` as the health check.
- It ships **both** a `Dockerfile` and a `render.yaml` Render blueprint (service `amina`,
  region `frankfurt`, `healthCheckPath: /api/health`,
  `buildCommand: npm ci --legacy-peer-deps --include=dev && npm run build`).
- There is **no `vercel.json`, no `netlify.toml`, and no `api/` serverless directory**, and
  `dist/` is a Vite build output that is not committed.

A static host would serve the built SPA but **not** `/api/*`, so the app's routes would 404.
That is exactly what happened when probing candidate Render URLs: every guess returned 404 on
`/api/health`, which is inconclusive (the real hostname is not in the repository).

**The link cannot be produced from here, and this is not a missing step.** The blueprint
already exists and is correct. Deployment is blocked on two things only the owner holds:

1. A Render account, with "New → Blueprint" pointed at the repository (the `render.yaml` says
   so explicitly).
2. `GEMINI_API_KEY` set in the Render dashboard. `render.yaml` declares it with `sync: false`,
   which means "not in the repo, set it in the dashboard" — deliberately. Without it the app
   still runs but the AI routes return degraded fallbacks.

Render's default hostname is `<service-name>-<hash>.onrender.com`; the service is named
`amina`, so the live URL ends in `.onrender.com`. If a link was shared in a chat, it is not
visible here and would need to be pasted in.

Separately: the one live URL that does resolve, `https://amina.vercel.app`, is **not this app**.
It serves a static "Amina Bouymajjane : Portfolio" page — a different site. Recorded so it is
not mistaken for the school app.

### Every open PR in Firstborn is a draft

| PR | Branch | State |
|----|--------|-------|
| #116 | `feat/full-coverage-audit` | **draft**, open, mergeable |
| #117 | `forge/full-coverage-audit-verdict` | open, docs only |
| #111 | `feat/audit-full-read-runtime` | draft |
| #110 | `docs/coordination-amina-audit` | draft |
| #109 | `feat/audit-static-crash-scan` | draft |

Only #116 is the active work. None are merged, and nothing was merged by this review.

### "PR C"

`fix/audit-c` does not exist. Remote branches are `fix/audit-a`, `fix/audit-b`,
`fix/audit-followup`, `fix/audit-hardening`; there is no `fix/audit-c`, and no PR titled
"PR C". The name is ambiguous — see section 8 for both readings.

---

## 10. Triage of the 47 findings

The 47 findings in `firstborn-full-7b832d61.md` were checked one by one against the code at
their cited paths. The distinction that matters is **false** (the finding is wrong) versus
**true** (the finding holds).

### False — the finding does not hold

- **`/api/verify/check` is unauthenticated.** False. `server.ts:151` reads
  `app.post('/api/verify/check', requireGitHubToken, async (req, res) => {` — it is guarded.
- **`/api/tasks/run` is unauthenticated.** False, and it was already fixed: `server.ts:102` reads
  `app.post('/api/tasks/run', requireGitHubToken, async (req, res) => {`.
- **The token is sent as `***`.** False. `requireGitHubToken` reads the `Authorization` header,
  strips `^Bearer\s+`, and re-sends the token as `Authorization: Bearer <token>` to
  `https://api.github.com/user` (`server.ts:23–45`). It is a Bearer token, not `***`.
- **The single SUPPORTED credential finding.** False. The "literal credential is present in the
  source" check matched the fake key `AIzaSyA1234567890abcdefghijklmnopqrs` in
  `tests/evidence.test.ts` — a test fixture, not a shipped secret. Fixed in #116:
  `isNonSourcePath` (`src/company/evidence.ts:36`) now skips `tests/`, `*.test.ts`, `*.spec.ts`,
  and `docs/` by path only, never by value, so a fixture can no longer manufacture a "hardcoded
  secret" claim.

### True — the finding holds

- **`/api/coordination` is unauthenticated.** True. `server.ts:162` reads
  `app.get('/api/coordination', async (req, res) => {` — no guard, unlike its neighbours. This is
  exactly what the "PR C" security-hardening task is meant to add.
- **`reportsStore` is unbounded.** True. `server.ts:21` declares
  `const reportsStore = new Map<string, any>()`, written at `:122` and read at `:143`. There is no
  `delete` or `clear` anywhere in `server.ts`, so the map grows for the life of the process.
- **`ModelService` deletes environment variables.** True on `main`, and **removed in #116**. On
  `main`, `src/services/model.ts:162` runs
  `for (const name of KEYLESS_CREDENTIAL_ENV_NAMES) delete process.env[name];`, mutating the
  process environment globally. On `feat/full-coverage-audit` that deletion is gone from both
  `src/services/model.ts` and `src/company/model.ts`; the keyless lock is now applied by
  filtering the client's credentials, not by editing `process.env`.

### Honest limit

This triage covers the findings whose claims can be settled by reading the cited file. The
remaining findings are `judgment` — model reasoning with a cited path — and are neither
confirmed nor dismissed here.

---

## 11. Guarantees for this review

- No target-repository writes, branches, commits, pull requests, or merges.
- No target-repository code or build scripts executed.
- No secrets, tokens, or credentials are reproduced in this document.
- `freelm` was exercised only through a local, throwaway script in the audit workspace,
  since deleted.
