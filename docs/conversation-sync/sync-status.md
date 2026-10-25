# Conversation Sync Status

- Generated: 2026-10-25T17:22:27.120Z
- Source: openhands
- Last successful sync: (never)
- Scope: **run** — this file lists the conversations examined by this run only; a short run is not total coverage
- Inventory: examined 1 of 1 conversation(s)
- Totals (this run): 1 conversations, 0 messages, 0 gaps, 1 errors
- Cumulative archive: 2 conversations, 4 messages

## Conversations

| Conversation | Repository | Messages (total) | Added this run | Lag (s) | State | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `4580cc3157c246a7af4bd60cc3776cd7` | `madnessgate44-debug/Firstborn` | 0 | 0 | — | ERROR | commit failed: injected write failure (test): the transcript commit was refused |

## Source read completeness

The source declares a message count for each conversation; the read reports how many it observed and whether pagination reached the last page. A declared/observed mismatch or an incomplete pagination is a `GAP`, never a silent `COMPLETE`.

| Conversation | Declared | Observed | Pages | Pagination |
| --- | --- | --- | --- | --- |
| `4580cc3157c246a7af4bd60cc3776cd7` | 2 | 2 | 1 | complete |

## Unsupported sources

- ChatGPT personal conversations: UNSUPPORTED for unattended sync: OpenAI documents history export as a user-requested process with no documented background API or webhook for personal conversations. No zero-action source exists, so this source is excluded from the pipeline rather than approximated by manual export.
