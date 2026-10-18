# Audit artifacts

Reports produced by Forge's read-only audit mode. These are evidence records, not
implementation changes.

| File | What it is |
|------|------------|
| `audit-c-six-items.md` | The six-item audit-C fix set (SSRF guard, workflow injection, coordination auth, `--ignore-scripts`). Item-by-item evidence, the bypass found in the specified code, the two judgment calls, and the open questions. Start here for part C. |
| `full-coverage-verdict-7b832d61.md` | Review verdict on PR #116 (`--full` sweep + shared routing policy). Explains why the full run reached 72% coverage, what #116 gets right, and the triage answers. |
| `amina-full-post-routing-fix-39083215538.md` | Full-coverage audit of `Amina` after the routing fix. Proves 46/46 answered chunks came from Gemini or Groq (zero keyless) and that the PARTIAL status guard fired. |
| `firstborn-full-7b832d61.md` | Raw full-coverage report for `Firstborn` @ `7b832d61`, as emitted by the audit CLI. |
| `amina-2c4f3b23.md` | Earlier read-only company audit of `madnessgate44-debug/Amina` @ `2c4f3b23`. |

Related runs:

- `39123453557` — **company audit of `Amina` on `fix/audit-c`**, dispatched with only `GROQ_API_KEY` and `GEMINI_API_KEY` present so the provider pool is Gemini + Groq with no keyless fallback. This is the run for the "Gemini and Groq only, on Amina" instruction.
- `39083215538` — re-run of the full sweep on Amina after the routing fix (73%, 16/62 chunks failed).
- `39074720296` — full sweep of `Firstborn` on `feat/full-coverage-audit` (72%, 8/29 chunks failed).
- `39075692475` — sampled control on `main` (routes to `google/gemini-flash-latest`).
