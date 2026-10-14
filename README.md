# forge-company

Forge as a **software company**. One goal in; a small org of employees works it —
some collaborating on the same job, some competing — and a judge picks the winner
on evidence. It is a standalone project: its own folder, its own repository, its
own `main`. It does not depend on, and never writes to, the Firstborn repository.

## The org model

- **Roles** (`src/company/roles.ts`) — the employees. Each has a mandate, a scoped
  toolset, an authority level (`read-only` or `branch-write`) and a brain. Default
  roster: PM, Architect, Implementer, Reviewer, QA, Security, Release.
- **Teams** (`src/company/team.ts`) — an ordered roster that works one job. Each
  role runs the hardened loop, then posts a typed artifact to the shared bus;
  later roles read what earlier roles produced. That explicit handoff is how the
  employees integrate.
- **Bus** (`src/company/bus.ts`) — append-only, typed artifact log. Every handoff
  is inspectable after the fact.
- **Judges** (`src/company/judge.ts`) — the "teachers". Scoring is deterministic
  and **evidence-only**: a claim earns nothing, a passing check earns points.
  Every lookup is scoped to the attempt being scored, so nobody wins on someone
  else's evidence. Ties break by attempt id, so ranking never depends on order.
- **Company / supervisor** (`src/company/company.ts`) — the CEO. Decomposes the
  goal into work items, runs a **competition** per item (N independent attempts),
  judges them, integrates only the winners, and re-verifies. Bounded by a
  company-wide budget on total role-runs.

## Kernel

`src/kernel/loop.ts` is the company's own engine, self-contained. It carries the
hardening from the Firstborn adversarial review (PR #83):

- a **per-call deadline**, so a hung brain or tool cannot defeat the ceiling;
- an optional **completion verifier**, so `finish` is not automatically success;
- **symlink-aware workspace containment** for every file read and write.

## Run it

```bash
npm install
npm run lint          # tsc --noEmit
npm test              # 36 tests, no network
npm run company -- "add a health check endpoint"                 # deterministic scripted employees
npm run company -- --model "add a health check endpoint"         # model-backed employees
npm run company -- --model --target "add getHealth() to index.js"  # real workspace: read/write/run checks
npm run company -- --model --workspace /path/to/repo "goal"      # against a real directory
```

With no model configured, the company runs with deterministic scripted employees,
so the org mechanics are exercisable and auditable offline.

### Real work, not just artifacts

In `--target` / `--workspace` mode every employee is handed the real workspace
tools (`read_file`, `write_file`, `run_check`). Only `branch-write` roles may
write, writes are confined to allowed roots, and `run_check` runs only an
authorized command, with no shell metacharacters and a hard timeout. QA's evidence
is derived from the checks it actually ran, so an attempt can only win by making a
real change and passing the real checks.

Verified live: `--model --target "Add a getHealth() function to index.js that
returns { status: 'ok' }"` completed with a perfect score (16/16) and really
rewrote `index.js`.

### Keys — the same ones as Forge

The company uses the **same credentials as Forge** (`src/company/model.ts` mirrors
Forge's `src/services/model.ts`). Nothing new to configure:

- keyless-first **freelm** router (Kilo / OVHcloud) — works with no key at all;
- provider keys read from the same environment variables: `GROQ_API_KEY`,
  `OPENROUTER_API_KEY`, `KILO_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, ...;
- optional `GEMINI_API_KEY` fallback (`gemini-2.5-flash`);
- `FIRSTBORN_KEYLESS_ONLY=true` strips all provider keys and disables the
  fallback, exactly as in Forge.

`FORGE_COMPANY_ATTEMPTS` sets how many attempts compete per work item.

## Status

The kernel and the org logic (teams, competition, judging, integration, budget,
containment) are implemented and tested, the model path is wired to Forge's keys,
and the company now does real work: model-backed roles read, write, and run checks
in a real workspace, with QA evidence taken from the checks that actually passed.
