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
- **Limitation**: the API exposes the event stream for conversations the token can
  see. It is not a push webhook, so freshness is bounded by the polling interval.

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
