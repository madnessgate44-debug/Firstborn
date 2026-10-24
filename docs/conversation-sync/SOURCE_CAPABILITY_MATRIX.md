# Source Capability Matrix — Conversation Sync

Status: **evidence-backed; the OpenHands source is implemented and live-tested. The
ChatGPT personal-conversation source is explicitly unsupported for unattended sync.**

This document records which sources can feed an unattended, source-faithful sync
pipeline, what each source requires, and the concrete evidence behind every claim.
It is the single place that decides what the pipeline is allowed to read. The same
facts are encoded in `src/sync/sources.ts` so the runtime and this document cannot
drift.

## Summary

| Source | Unattended? | Stable IDs | Edits | Deletions | In the pipeline? |
| --- | --- | --- | --- | --- | --- |
| OpenHands Cloud sessions | Yes | Yes | Yes | Yes | **Yes** |
| ChatGPT personal conversations | No | No | No | No | **No — unsupported** |

## OpenHands Cloud sessions — supported

- **Access path**: OpenHands Cloud API V1, read-only GET endpoints.
  - `GET /api/v1/app-conversations/search` — list conversations with routing metadata.
  - `GET /api/v1/conversation/{conversation_id}/events/search` — the full event stream.
  - `GET /api/v1/conversation/{conversation_id}/events/count` — event total, for gap checks.
- **Auth**: `Authorization: Bearer <OPENHANDS_API_KEY>`. Only GET is called; the
  pipeline never starts, mutates, or deletes a conversation.
- **Official documentation**:
  - https://docs.openhands.dev/enterprise/conversations-and-sandboxes
  - https://docs.openhands.dev/openhands/usage/cloud/api-reference/events/search-events
- **Observed evidence** (live reads during this task, 2026-10-23):
  - `GET /api/v1/app-conversations/search?limit=5` returned HTTP 200 with a bearer
    token, exposing stable conversation ids, `selected_repository` routing metadata,
    `created_at`/`updated_at`, and `conversation_ui_url`.
  - `GET /api/v1/conversation/{id}/events/search` returned HTTP 200 with per-event
    UUIDs, ISO-8601 timestamps, and `llm_message` content for user/assistant turns.
  - The events envelope paginates with `next_page_id` (opaque cursor) and supports
    `sort_order=TIMESTAMP` (ascending) and `TIMESTAMP_DESC` (descending); the last
    page returns `next_page_id: null`.
- **Why it qualifies**: new events are readable on demand with no owner action —
  no manual export, no per-message command. A scheduled job can read them directly.

### Count semantics (observed 2026-10-24) — why the count is kind-filtered

The unfiltered `events/count` endpoint **over-reports** versus the paginated stream.
On every one of the 27 live conversations sampled, the unfiltered count exceeded the
number of events returned by `events/search` by 1-2 (e.g. conversation `62057a7b…`:
count 557 vs 555 streamed events; `56ed1529…`: 448 vs 446). Summing per-kind counts
does not explain the total either (the kinds returned by `search` summed to 555 while
the unfiltered count was 557), so the unfiltered figure is not a usable expected total.

`GET /api/v1/conversation/{id}/events/count?kind__eq=MessageEvent` **matched the
stream exactly** on all 27 conversations. The gap check therefore filters the count to
`MessageEvent`. Using the unfiltered count would have raised a spurious gap on every
conversation on every run; this is the reason the count is wired with a kind filter,
not the raw count.

### Rate limits (observed 2026-10-24)

The API enforces two limits, both returned as HTTP 429:
`{"error":"Rate limit exceeded: 100 per 1 minute"}` and
`{"error":"Rate limit exceeded: 10 per 1 second"}`. A long conversation (e.g. 5,189
events, 52 pages at `limit=100`) will hit them if read as fast as possible. The client
therefore paces requests client-side (a minimum gap and a rolling-minute cap) and, if
a 429 still arrives, honours `Retry-After` and backs off. A 429 that never clears
fails the read loudly rather than returning a partial stream.

### Pagination completeness

`events/search` is followed page by page until `next_page_id` is `null`. A read that
cannot reach the end — because the 10,000-page guard is exhausted, or because a page
is empty while the source still reports a next cursor — **throws**, so a truncated
stream can never be mistaken for a complete one. Each read also reports how many
message events the source *declares* (via the filtered count) versus how many it
actually returned; a mismatch becomes a visible `GAP`.

### Conversation-inventory completeness

`app-conversations/search` is followed to its end so the pipeline can report how many
conversations exist, then returns the first `limit`. The run reports `examined` vs
`totalAvailable` and a `truncated` flag, so a run that saw a subset of a larger
inventory says so instead of appearing complete.

- **Limitation**: the API exposes the event stream for conversations the token can
  see. It is not a push webhook, so freshness is bounded by the polling interval.

## Routing — fails closed

Routing is read from `docs/conversation-sync/routes.json`, a reviewable registry.
`fallbackRepository` is `null`: a conversation that matches no rule is **routed
nowhere** and reported as `ERROR`, never written to a guessed repository. An unknown
project cannot leak its transcript into another project's repository. The intended
projects route to their own repositories:

| Project | Routes to |
| --- | --- |
| `madnessgate44-debug/Amina` | `madnessgate44-debug/Amina` |
| `madnessgate44-debug/smart-farm` | `madnessgate44-debug/smart-farm` |
| `madnessgate44-debug/brain` | `madnessgate44-debug/brain` |
| `madnessgate44-debug/Firstborn` | `madnessgate44-debug/Firstborn` |

Live routing of the 27 current conversations: 9 → Firstborn, 8 → Amina, 9 → brain,
1 unrouted (a conversation with no `selected_repository` and no matching title).

## ChatGPT personal conversations — UNSUPPORTED

- **Blocker**: OpenAI documents history export as a **user-requested** process. There
  is no documented continuous per-message webhook or unattended API for personal
  conversation history.
- **Official documentation**:
  - https://help.openai.com/en/articles/7260999-how-to-export-your-chatgpt-history-and-data
  - https://help.openai.com/en/articles/8167885-how-to-export-your-data-from-the-chatgpt-android-app
- **Verbatim from the export article**: "ChatGPT provides two ways to request a copy of
  your data:" … "Use ChatGPT settings to request an export from an eligible signed-in
  account or workspace." — the path is an owner action in Settings, or a Privacy Portal
  request, and "Exports can take up to 7 days to arrive." Nothing in the article
  describes a background feed or per-message webhook.
- **Decision**: this source is **excluded** from the pipeline. It is not approximated
  by a manual export, and no `zeroActionSync: true` claim is made for it. Any
  transcript of a ChatGPT conversation is captured only when its text is available in
  the active session, and is marked `PARTIAL`/`EXCERPT`, never `COMPLETE`.

## What "zero action" means here

Zero action means the owner does not run a command, export a file, or remember a
closeout step for the **supported** source. It does **not** mean the platform pushes
events; the OpenHands source is polled on a schedule. Freshness is therefore the poll
interval, which the status file reports as `lagSeconds` per conversation.
