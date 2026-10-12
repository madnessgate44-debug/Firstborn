# OpenHands DeepSeek Free-Model Execution Proof

Controlled mission evidence for issue #22. This document is documentation-only; it
does not describe or require any change to application code, workflows, secrets,
settings, or agent logic.

## Mission

| Field | Value |
| --- | --- |
| Mission ID | `issue-22-deepseek-proof` (GitHub issue #22) |
| Repository | `madnessgate44-debug/Firstborn` |
| Branch | `openhands/deepseek-proof-22` |
| Base branch | `main` |
| Base commit (recorded before any edit) | `6ef8d95b114cfb4f1d5f84653ded01d5140ae084` |
| Base commit subject | `Harden Forge end-to-end execution and prove keyless mode (#19)` |
| Mission date (UTC) | 2026-10-12 |

## Requirement-to-evidence traceability

| Req | Requirement | Evidence |
| --- | --- | --- |
| R1 | Inspect repository and current `main` commit before editing | Base commit recorded above from `git rev-parse HEAD` on a clean tree at `main` |
| R2 | Use the configured DeepSeek free model; do not silently substitute | Configured profile and runtime telemetry both report `openhands/deepseek-v4.1-flash`; no model switch was requested or performed |
| R3 | One documentation-only file, no application/workflow/secret/settings changes | Diff contains exactly one added file: `docs/OPENHANDS_DEEPSEEK_PROOF.md` |
| R4 | Record mission ID, base commit, actual provider/model from runtime, and checks; never guess model identity | This document, plus the runtime-evidence and limitations sections below |
| R5 | Run `npm run lint`, `npm run build`, `git diff --check` if supported | Check results section below |
| R6 | Separate branch, open a review PR, do not merge | Branch `openhands/deepseek-proof-22`; PR opened for review only; nothing merged |

## Actual provider/model reported by the runtime

The runtime used for this mission is the OpenHands agent server (v1.50.1). The
provider/model was read from runtime configuration and telemetry, not inferred
from the task text:

- Configured LLM profile (`~/.openhands/profiles/Default.json`):
  - `model`: `openhands/deepseek-v4.1-flash`
  - `base_url`: `https://llm-proxy.app.all-hands.dev`
- Conversation agent state (`agent.llm.model` in the conversation base state):
  `openhands/deepseek-v4.1-flash`
- Conversation telemetry (`usage_to_metrics.<usage_id>.model_name` in
  `ConversationStateUpdateEvent` records): `openhands/deepseek-v4.1-flash`
- Model-route tags attached to every request by the runtime:
  `model:openhands/deepseek-v4.1-flash`

### Route availability probe

The local agent server exposes an OpenAI-compatible endpoint that routes through
the configured model profile. A minimal request confirmed the route is live:

```
POST http://127.0.0.1:60000/v1/chat/completions
{"model":"openhands_Default","messages":[{"role":"user","content":"Reply with exactly: PROBE_OK"}],"max_tokens":32,"temperature":0}
```

Observed result: HTTP 200, `finish_reason=stop`, `content=PROBE_OK`,
`model=openhands_Default`. This confirms the configured route served a real
completion during the mission.

## Runtime-evidence limitations (explicit)

The following limitations are stated so the evidence is not overstated:

1. The proxy endpoint echoes the routing alias (`openhands_Default`), not the
   upstream provider identity. Upstream provider identity is therefore not
   independently observable from inside the sandbox.
2. The runtime model identifier `openhands/deepseek-v4.1-flash` is a routing name
   on the OpenHands LLM proxy. The evidence proves the request was routed through
   the configured DeepSeek model route; it does not independently prove the
   upstream weight provider beyond that routing name.
3. `accumulated_cost` for the agent usage was reported as `0.0`. This is
   consistent with a free-tier/managed route, but cost reporting is not by itself
   proof of the upstream provider.
4. No model-switch action was taken. The runtime `SwitchLLMTool` was not used and
   the configured profile was not modified.

Conclusion: the runtime verifiably served this mission through the configured
DeepSeek free-model route (`openhands/deepseek-v4.1-flash`). Any claim stronger
than the routing name cannot be verified from inside the sandbox.

## Checks executed

Commands were run in the mission sandbox at base commit
`6ef8d95b114cfb4f1d5f84653ded01d5140ae084`.

| Check | Command | Result | Exit code |
| --- | --- | --- | --- |
| Dependency install | `npm install` | 181 packages added | 0 |
| Lint | `npm run lint` (`tsc --noEmit`) | No type errors | 0 |
| Build | `npm run build` (`vite build`) | Built successfully (1660 modules) | 0 |
| Whitespace/conflict check | `git diff --check` | No whitespace or conflict-marker errors | 0 |

The build emitted a non-fatal Vite config warning about `configLoader: 'native'`
and `__dirname` in `vite.config.ts`; it did not affect the exit code.

## Diff scope

Exactly one file was added:

```
docs/OPENHANDS_DEEPSEEK_PROOF.md
```

No application code, workflow, secret, settings, or existing agent logic was
modified. The mission did not merge anything.
