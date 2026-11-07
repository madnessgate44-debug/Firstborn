# Follow-up verification record — controlled new-source-event E2E (2026-10-25)

Status: **VERIFIED — live controlled run, manually dispatched. Scheduled (unattended)
operation is NOT claimed and is NOT active.**

This record answers the reviewer's follow-up order on PR #134 (issue #131). Every claim
below is backed by a raw command and its captured output under
`docs/conversation-sync/evidence/`. Nothing here is a read-back of pre-existing historical
conversations: the `new` and `fault` phases create a **fresh** source event and prove it
reaches GitHub.

Distinction the reviewer asked for:

- **Live manual polling evidence** — the runs below were dispatched by hand from this
  session against the real OpenHands Cloud API and the real GitHub API.
- **Scheduled operation** — **not active.** See "Scheduled operation" below.

---

## 1. Controlled new-source-event test (not a historical read-back)

Two fresh OpenHands Cloud sessions were created for this verification (harmless markers,
no work performed):

| Purpose | Conversation id | Source marker | Source events |
| --- | --- | --- | --- |
| new / idempotency | `58705495154e4fdd9c1873c9e9e34387` | `SYNC-E2E-CONTROLLED 2026-10-25T17:15Z …` | 2 (`user` + `assistant ACK`) |
| write-failure / retry | `4580cc3157c246a7af4bd60cc3776cd7` | `SYNC-E2E-FAULT2 2026-10-25 …` | 2 (`user` + `assistant ACK`) |

Exact source event ids and text (from the live read, `e2e-controlled-run-2026-10-25.txt`):

```
[e2e] source event id=ed2b7f0a-d989-4ac3-9d28-8f5cb4843f6a speaker=user ts=2026-10-25T17:10:38.739278
      text="SYNC-E2E-CONTROLLED 2026-10-25T17:15Z marker: harmless verification message. Do not perform any work; reply with the sin"
[e2e] source event id=4167f300-4cda-491b-8fde-1b7a90f2408c speaker=assistant ts=2026-10-25T17:10:40.714282 text="ACK"
```

Committed GitHub artifact (read back independently through the GitHub contents API —
`e2e-new-readback-transcript.md`):

`madnessgate44-debug/Firstborn @ conversation-sync-e2e` →
`docs/conversation-sync/transcripts/openhands/58705495154e4fdd9c1873c9e9e34387.md`

The read-back matches the source message-for-message (id, speaker, timestamp, text):

```
[e2e] PASS new: transcript was committed to GitHub — docs/conversation-sync/transcripts/openhands/58705495154e4fdd9c1873c9e9e34387.md
[e2e] PASS new: read-back matches source message-for-message — 2 archived vs 2 source
[e2e] PASS new: archived text contains the source marker verbatim
```

## 2. Second run — no duplicate / no new commit

```
[e2e] PASS new2: transcript blob is byte-identical (no duplicate write) — 6defd528ac36 -> 6defd528ac36
[e2e] PASS new2: addedThisRun is 0 for the already-synced conversation — 0
[e2e] PASS new2: checkpoint file is unchanged
[e2e] PASS new2: still exactly one archived copy of every source event
```

The transcript blob SHA and the checkpoint file SHA are unchanged across the second run;
`addedThisRun` is `0` and the note is `no new messages`.

## 3. Injected write failure after source read → no checkpoint advance → retry archives once

Failure injected at the **commit** step (after the source read returned 2 messages):

```
[e2e] PASS fault: the run reported the injected failure
[e2e] PASS fault: the conversation is marked ERROR — commit failed: injected write failure (test): the transcript commit was refused
[e2e] PASS fault: the failed run does not claim a successful sync
[e2e] PASS fault: the committed checkpoint did not advance for the failed conversation — checkpoint contains 4580cc3157c246a7af4bd60cc3776cd7: false -> false
[e2e] PASS fault: no transcript was committed for the failed conversation
```

Retry, same source event:

```
[e2e] PASS retry: the run has no errors
[e2e] PASS retry: the transcript is now committed
[e2e] PASS retry: read-back matches source message-for-message — 2 archived vs 2 source
[e2e] PASS retry: the checkpoint advanced exactly to the source message count — syncedCount=2
[e2e] PASS retry: the archived event appears exactly once
```

The committed checkpoint after retry (`e2e-checkpoints-readback.json`) shows
`4580cc3157c246a7af4bd60cc3776cd7` with `syncedCount: 2` — exactly the source message count,
no double count. The failure was `ERROR`-visible (not silent) and the retry repaired it.

## 4. Source inventory and event-count / pagination checks in the run output

The CLI now prints an explicit completeness block every run (see
`dryrun-2026-10-25.txt`, `--- COMPLETENESS CHECKS ---`):

```
Inventory: examined 31 of 31 conversation(s); scan complete; truncated=false
Event count vs stream: 0 mismatch(es) of 31 (declared MessageEvent count vs observed messages)
Pagination: 0 incomplete read(s) of 31 (every non-error read must reach the source's last page)
Unrouted (fail closed): 1 conversation(s) written nowhere
  - 13ba118db5e9455a8fac654e3ba53730: no route matched (unrouted); not written anywhere
```

- **Declared vs observed count** is now carried per conversation into the status file
  (`declaredMessages`, `observedMessages`, `pages`, `paginationComplete`) and rendered as a
  `## Source read completeness` table in `sync-status.md`. A mismatch is a `GAP`.
- **Pagination completeness** is reported per conversation; an incomplete read is a `GAP`.
- **Unrouted fails closed**: the one conversation with no `selected_repository` and no
  matching title is reported as `ERROR` and written to **no** repository. Live routing in
  the dry run: 13 → Firstborn, 8 → Amina, 9 → brain, 1 unrouted.
- **Rate limiting observed and handled**: this run hit a real `HTTP 429
  {"error":"Rate limit exceeded: 100 per 1 minute"}` on one long conversation; the client
  retried and, when it still could not clear, failed that read **loudly** (marked `ERROR` /
  `INCOMPLETE`) rather than returning a short stream. Exit code 1.

## 5. Scheduled operation — NOT claimed, NOT active

- `GET /repos/madnessgate44-debug/Firstborn/actions/runs?event=schedule` returns
  `total_count: 0`. No schedule-triggered run has ever executed.
- `.github/workflows/conversation-sync.yml` exists only on this draft PR branch, **not on
  `main`** (`GET /contents/.github/workflows/conversation-sync.yml?ref=main` → HTTP 404).
  GitHub cannot run a workflow schedule until the file is on the default branch.
- Therefore: the evidence above is **manual, live polling**. Unattended scheduled operation
  is a follow-up that requires merging the workflow to `main`; it is not claimed here.

### Secret preflight limitation (reported plainly)

The connected GitHub integration cannot inspect Actions secret **values or presence**:
`GET /repos/madnessgate44-debug/Firstborn/actions/secrets` → HTTP 403
`Resource not accessible by integration`. So this session cannot confirm whether
`OPENHANDS_API_KEY` / `SYNC_GITHUB_TOKEN` are configured as repository secrets. The workflow
itself performs a presence-only preflight (prints "configured"/"not configured", never a
value) and fails hard when the source token is missing, so an inert schedule cannot
masquerade as a working one. **Presence of the repository secrets is UNVERIFIED from here.**

## 6. Scope boundaries

- **ChatGPT personal conversations remain unsupported.** No documented unattended API or
  webhook exists; the pipeline reports the source as unsupported rather than approximating it
  with a manual export.
- **No `main` writes, no merge.** All controlled evidence lands on the isolated
  `conversation-sync-e2e` branch. The production pipeline writes only to `conversation-sync`.
- **No credentials exposed.** Token values are never printed; the controlled sessions contain
  only harmless marker text and an `ACK`.

## Reproduce

```bash
# Controlled E2E (needs a read-only OPENHANDS_API_KEY and a write GITHUB_TOKEN)
SYNC_E2E_NEW_CONVERSATION=58705495154e4fdd9c1873c9e9e34387 \
SYNC_E2E_FAULT_CONVERSATION=<a fresh controlled session id> \
  npx tsx scripts/sync-e2e.ts --phase=all

# Full pipeline dry run (read-only; no writes)
npx tsx scripts/sync.ts --dry-run --limit=50
```

`npm run sync:e2e` is the same harness. A phase that cannot prove its assertion exits
non-zero, so a green run means the evidence was actually observed.

## Verification ledger

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run lint` | PASS (exit 0) |
| Non-live sync tests | `npx tsx --test tests/sync-{checkpoint,client,pipeline,render,router,routes-registry,transcript,workflow}.test.ts` | PASS (74 pass, 0 fail) |
| Live sync tests | `OPENHANDS_API_KEY=… npx tsx --test tests/sync-live.test.ts` | PASS (3 pass, 0 fail) |
| Controlled E2E | `npx tsx scripts/sync-e2e.ts --phase=all` | PASS (0 failures) |
| Full dry run | `npx tsx scripts/sync.ts --dry-run --limit=50` | Observed: 31 conversations, 1 unrouted, 1 loud 429 failure (exit 1) |
| Scheduled runs | `GET …/actions/runs?event=schedule` | `total_count: 0` — not active |
| Workflow on main | `GET …/contents/.github/workflows/conversation-sync.yml?ref=main` | HTTP 404 — not on main |
| Secret presence | `GET …/actions/secrets` | HTTP 403 — cannot inspect from this integration |
