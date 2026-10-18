# Audit artifacts

Reports produced by Forge's read-only audit mode. These are evidence records, not
implementation changes.

| File | What it is |
|------|------------|
| `full-coverage-verdict-7b832d61.md` | Review verdict on PR #116 (`--full` sweep + shared routing policy). Explains why the full run reached 72% coverage, what #116 gets right, and the triage answers. Start here. |
| `amina-full-post-routing-fix-39083215538.md` | Full-coverage audit of `Amina` after the routing fix. Proves 46/46 answered chunks came from Gemini or Groq (zero keyless) and that the PARTIAL status guard fired. 168 findings, 16 failed chunks explained. |
| `firstborn-full-7b832d61.md` | Raw full-coverage report for `Firstborn` @ `7b832d61`, as emitted by the audit CLI (47 findings, 8 failed chunks). |
| `amina-2c4f3b23.md` | Earlier read-only company audit of `madnessgate44-debug/Amina` @ `2c4f3b23` (9 findings). |

Related runs:

- `39083215538` — **re-run of the full sweep on Amina after the routing fix** (73%, 16/62 chunks failed). 46/46 answered chunks came from Gemini or Groq; **zero keyless**. Status correctly reported PARTIAL and the step failed.
- `39074720296` — full sweep of `Firstborn` on `feat/full-coverage-audit` (72%, 8/29 chunks failed)
- `39075485016` — sampled control on the same branch (routes to `kilo/nvidia/nemotron-3.5-super-vl:free`)
- `39075692475` — sampled control on `main` (routes to `google/gemini-flash-latest`)
- `38790744542` — pre-change full run on `main`
