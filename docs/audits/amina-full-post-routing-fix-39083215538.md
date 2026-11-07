# Full-coverage audit: `madnessgate44-debug/Amina` @ `2c4f3b23` (post-routing-fix)

Run `39083215538`, dispatched on `feat/full-coverage-audit` with `full=true`, Gemini + Groq
only. Raw output: `company-audit-full.json` (artifact of that run). Read-only: no target writes,
no target code executed.

## Headline

| Field | Value |
|-------|-------|
| Status | **PARTIAL** |
| Files examined | 98/133 (73%) |
| Chunks | 46/62 answered, 16 failed |
| Findings | 168 — HIGH 17, MEDIUM 44, LOW 54, INFO 53 |
| Evidence | 0 supported, 13 contradicted, 155 judgment |
| Routes used | Gemini + Groq only, 46/46 answered chunks. **Zero keyless.** |

The status guard did its job: the CLI printed PARTIAL and exited non-zero, so the workflow
failed. The previous run on this branch printed `COMPLETED` over a 72% read.

## The routing fix, proven

```
Routes used: Google AI Studio / Gemini / gemini-2.5-flash (18 chunks);
             google / gemini-3.1-flash-lite (16 chunks);
             groq / qwen/qwen3.8-27b (11 chunks);
             google / gemini-3.5-flash (1 chunk)
```

Every answered chunk came from a keyed provider. The prior run (`39074720296`) landed on
`kilo/nvidia/nemotron-3-super-120b-a12b:free`. `keylessOption(env, 'hard')` returning `'auto'`
removed the anonymous endpoint from the pool, as intended.

## Why 16 chunks failed — two defects, not a routing regression

The failed-chunk notes carry the reasons (new in this branch):

| Chunks | Reason | Nature |
|--------|--------|--------|
| 13 | `[google] 429 — You exceeded your current quota` | Google key quota exhausted |
| 1 (chunk-6) | `[groq] 400 — reasoning_effort must be one of low, medium, or high` | **Bug in our request** |
| 1 (chunk-47) | `google/gemini-3.5-flash:RateLimited(429); groq/openai/gpt-oss-120b:BadRequest(400)` | All keyed routes exhausted |

The 13 quota failures are the deliberate trade-off of this change: with a key present the pool
is keyed-only, so a 429 on the Gemini key is terminal for that chunk. The alternative is
silently landing on a 3-rpm anonymous endpoint and returning weaker answers — the failure this
branch exists to remove.

The chunk-6 failure is a plain bug: `src/company/model.ts` sends `reasoning_effort: 'none'`,
which Groq rejects. Worth its own fix.

## The verification panel is honest

All four roles reported UNVERIFIED. That is correct, not a failure. With 168 findings the cited
corpus exceeds the 60000-char budget, so the panel refuses to confirm findings it was not shown.
The same situation previously produced four false OBJECTs, because `renderCitedFiles` stopped at
the first file that did not fit and never showed the panel the rest.

## HIGH findings

Real, path-cited, and mostly `observed`. The XSS claims marked CONTRADICTED are correctly
contradicted: `{msg.content}` and `<img src={photoDataUrl}>` in React JSX are escaped or
attribute-set by React, so "direct DOM injection" is not supported by the cited text. That is
the deterministic evidence layer working.

- CI pipeline ignores type-check failures — `.github/workflows/ci.yml` (`continue-on-error: true` on `npm run lint`)
- Package with install script — `package-lock.json` (`protobufjs` `hasInstallScript: true`)
- Production server runs uncompiled TS via `tsx` — `package.json`, `render.yaml` (CONTRADICTED)
- Prompt injection in AI prompt construction — `server.ts` (several `/api/*` handlers interpolate user input)
- XSS via direct rendering — `src/components/companion/CompanionChatScreen.tsx` (CONTRADICTED)
- Unsafe access to undefined property — `src/components/curriculum/ConceptDetailModal.tsx`
- Client-side mission creation without backend persistence — `src/components/curriculum/CurriculumBrowser.tsx`
- Prompt injection via untrusted input — `src/components/dayRecord/DayRecordFlowModal.tsx`
- Missing keyboard accessibility for closing — `src/components/home/DailyReviewModal.tsx`
- Hardcoded student name — `src/components/layout/ChildTopMenu.tsx`
- XSS — `src/components/mastery/EvidenceLogViewer.tsx`, `KnowledgeMap.tsx` (CONTRADICTED)
- XSS via photo data URL — `src/components/missions/HomeworkRunner.tsx` (CONTRADICTED)
- Plaintext PIN storage — `src/services/parent/parentService.ts`
- Sensitive data in LocalStorage — `src/services/storage/IndexedDBStorageService.ts`
- Sensitive data in export — `src/services/storage/IndexedDBStorageService.ts`
- Test suite writes to filesystem on failure — `src/services/teaching/__tests__/teachingSession.test.ts`
- Insecure base path via env var — `vite.config.ts`

## Honest limits

- 35 of 133 files were not read (the 16 failed chunks). Findings are reported against the files
  that were read; absence of a finding for an unread file is not a clean bill of health.
- 155 of 168 findings are `judgment`, not machine-settled. They are model reasoning with a cited
  path, not proof.
- The Google key hit its quota. A full 100% read needs either a higher quota or the bounded
  keyless retry described in the #116 discussion.
