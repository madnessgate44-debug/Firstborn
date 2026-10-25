# Conversation Sync Status

- Generated: 2026-10-25T17:22:23.182Z
- Source: openhands
- Last successful sync: 2026-10-25T17:22:23.182Z
- Scope: **run** — this file lists the conversations examined by this run only; a short run is not total coverage
- Inventory: examined 1 of 1 conversation(s)
- Totals (this run): 1 conversations, 2 messages, 0 gaps, 0 errors
- Cumulative archive: 1 conversations, 2 messages

## Conversations

| Conversation | Repository | Messages (total) | Added this run | Lag (s) | State | Note |
| --- | --- | --- | --- | --- | --- | --- |
| `58705495154e4fdd9c1873c9e9e34387` | `madnessgate44-debug/Firstborn` | 2 | 0 | 702 | OK | no new messages |

## Source read completeness

The source declares a message count for each conversation; the read reports how many it observed and whether pagination reached the last page. A declared/observed mismatch or an incomplete pagination is a `GAP`, never a silent `COMPLETE`.

| Conversation | Declared | Observed | Pages | Pagination |
| --- | --- | --- | --- | --- |
| `58705495154e4fdd9c1873c9e9e34387` | 2 | 2 | 1 | complete |

## Unsupported sources

- ChatGPT personal conversations: UNSUPPORTED for unattended sync: OpenAI documents history export as a user-requested process with no documented background API or webhook for personal conversations. No zero-action source exists, so this source is excluded from the pipeline rather than approximated by manual export.
