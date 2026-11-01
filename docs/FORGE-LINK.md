# Forge — the working link (for the controller LLM)

**Status:** VERIFIED WORKING, 2026-11-01. This page is the link. Read it, then call it.

Forge is a deterministic coding agent. You (the controller LLM) trigger it, then read
its evidence. You do not chat with it. There are two working entry points. Both were
proven on 2026-11-01 by a real task that produced a real pull request.

---

## Link 1 (preferred, durable) — GitHub Actions dispatch

This is the link. It lives on `main`, needs no server and no session, and works from a
phone. It is a URL you POST to.

```
POST https://api.github.com/repos/madnessgate44-debug/Firstborn/actions/workflows/forge.yml/dispatches
Authorization: Bearer <a token with repo write>
Accept: application/vnd.github+json
Content-Type: application/json

{
  "ref": "main",
  "inputs": {
    "mode": "coding",
    "target_repo": "madnessgate44-debug/Firstborn",
    "task_id": "short-id",
    "task_title": "One-line title",
    "task_desc": "REQ-1 ... acceptance criteria ..."
  }
}
```

A `204` means accepted. Read the result at:

- Run: `GET /repos/madnessgate44-debug/Firstborn/actions/workflows/forge.yml/runs` (newest).
- Pull request: the run opens one titled `[Forge] <task_title>` on branch `forge/task-<id>-<run>`.
- Evidence: the `forge-evidence` artifact on the run — status, baseCommitSha, branchName,
  prCommitSha, prUrl, modelInvoked, requirements[], testResults[], trace[].

**Proof (2026-11-01):** dispatch of `task_id=dispatch-link-proof` completed **success** and
opened PR #143 (`docs/DISPATCH-PROOF.md`, +1). All stages PASSED:
`INSPECT → PLAN → VALIDATE → APPLY → TEST → POLICY → COMMIT → PR`.

### Same-repo vs cross-repo

A **same-repo** mission (`target_repo` == this repo) runs on the workflow's own token — it
works with no extra secret. A **cross-repo** mission needs `FORGE_CROSS_REPO_TOKEN` (or
`FORGE_DELIVER_TOKEN`) with push on the target; without it the run stops at step 7
"Verify cross-repository write access". Prefer same-repo until that secret is set.

---

## Link 2 — HTTP API (works; host is not permanent yet)

`POST /api/tasks/run` on a running `server.ts`. Body:

```json
{ "id": "task-1", "title": "...", "description": "REQ-1 ... acceptance ...",
  "targetRepo": "madnessgate44-debug/Firstborn", "targetBranch": "main", "allowPrCreation": true }
```

Requires `Authorization: Bearer <GitHub token>` whose login is in `FORGE_ALLOWED_LOGINS`
(default `madnessgate44-debug`). Start with `npm start` (Express, `PORT`, default 3000).

**Proof (2026-11-01):** a task run over a public HTTP link returned `status: PR_OPENED`
and opened PR #142 (`docs/FORGE-LINK-PROOF.md`, +1), with `npm run lint` exit 0 and
6/6 target checks passed.

**Caveat:** the HTTP API needs an always-on host. A free, no-card always-on host is not
yet chosen (Vercel serverless lacks the git/Chromium the agent needs). Until then, Link 1
is the durable one. The API is for a host you already run.

---

## Rules (do not skip)

- Forge opens a **pull request**. It never merges. A separate verifier (Sentinel) gates merge.
- It cannot push to `main`, cannot act outside the repo allow-list, and has hard ceilings
  (~5 files / ~8 edits).
- One task = one bounded mission. It is a build system, not a chatbot.
- Every claim comes with evidence: read `requirements[]`, `testResults[]`, and `trace[]`.
  A `PLAN` or a queued run is not proof; a `PR_OPENED` with passing `TEST` is.
