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
npm test              # 18 tests, no model, no network
npm run company -- "add a health check endpoint"
```

With no model configured, the company runs with deterministic scripted employees,
so the org mechanics are exercisable and auditable offline. A model-backed roster
plugs in at the same `rosterFor` boundary.

## Status

The kernel and the org logic (teams, competition, judging, integration, budget,
containment) are implemented and tested. Model-backed brains are the next slice;
they attach at the role boundary without touching the org logic.
