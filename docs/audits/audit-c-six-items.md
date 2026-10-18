# Audit part C — six-item fix set

- **Working repo:** `madnessgate44-debug/Firstborn`
- **Branch:** `fix/audit-c`, one branch off `main` @ `14b7bf3`
- **Pull request:** #118 (open, not merged)
- **Audited company (the instruction's target):** `madnessgate44-debug/Amina`
- **Provider policy for the Amina run:** Gemini + Groq only. `company-audit.yml`
  passes only `GROQ_API_KEY` and `GEMINI_API_KEY`, so the pool is keyed-only and
  no anonymous keyless route is added.
- **Nothing was merged.** #116 was merged earlier only after the owner gave
  explicit authorization; #118 is open and awaits the same.

---

## 1. What was asked, and what each item became

| # | Item | File(s) | Status |
|---|------|---------|--------|
| 1 | Command injection in the audit workflow | `.github/workflows/company-audit.yml` | done |
| 2 | SSRF guard | `src/services/url-guard.ts` (new), `tests/url-guard.test.ts` | done |
| 3 | `fetch_url` uses the guard, manual redirects, streaming cap | `src/agent/tools.ts` | done |
| 4 | Browser open guard + context request guard | `src/services/browser.ts` | done |
| 5 | `/api/coordination` authentication | `server.ts`, `src/App.tsx` | done |
| 6 | `--ignore-scripts` on every workflow install | 7 workflow files, `tests/workflow-install.test.ts` | done |

---

## 2. Item 1 — workflow command injection

`company-audit.yml` put the dispatch input straight into the shell script:

```yaml
npx tsx scripts/audit.ts --full "${{ inputs.target_repo }}"
```

A `target_repo` containing shell metacharacters is interpolated before the shell
sees the line, so quoting does not help. The fix passes it through the environment
and references the variable instead:

```yaml
env:
  TARGET_REPO: ${{ inputs.target_repo }}
run: |
  npx tsx scripts/audit.ts --full "$TARGET_REPO"
```

I scanned every workflow for interpolations inside `run:` blocks.
`company-audit.yml` was the only match; `company-deliver.yml` and `forge.yml`
already used the environment. This matches the `company-deliver.yml` pattern.

---

## 3. Item 2 — the SSRF guard, and a real bypass in the specified code

`assertPublicHttpUrl(raw, { allowLoopback })` rejects any scheme other than
http(s), resolves the host, and refuses private, link-local, and metadata
addresses. Tests use IP literals only, so they never touch DNS or the network.

**The specified dotted-decimal check for IPv4-mapped IPv6 addresses did not work.**
Node's WHATWG `URL` normalizes `http://[::ffff:10.0.0.1]/` to the hostname
`[::ffff:a00:1]`. So `addr.slice(7)` is `"a00:1"`, `"a00:1".split('.').map(Number)`
is `[NaN]`, and every comparison against `NaN` is `false`. The address was judged
public. The branch now decodes the hex groups as well:

```ts
const [hi, lo] = tail.split(':').map((g) => Number.parseInt(g, 16));
return isPrivateAddress(
  `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`,
  allowLoopback
);
```

`tests/url-guard.test.ts` includes "an IPv4-mapped IPv6 private address is blocked",
which fails against the original code.

---

## 4. Item 3 — `fetch_url`

- The guard runs on **every hop**, not only the first URL.
- Redirects are followed by hand (`redirect: 'manual'`, maximum 3). A public URL
  that returns `302` to `169.254.169.254` is refused, not followed.
- The body is read through a streaming cap (`readCappedBody`, 20 KB), so an
  endless body cannot be buffered into memory.

`tests/fetch-guard.test.ts` proves all four behaviours against a real local
fixture: blocked scheme, blocked metadata address, redirect into metadata,
redirect limit, and the size cap.

---

## 5. Item 4 — browser

- `open()` runs the guard on the URL it is given.
- `ensurePage()` installs a `context.route('**/*')` guard so a page cannot fetch
  an internal address itself. `data:` and `blob:` pass; blocked requests are
  aborted with `blockedbyclient`.

`tests/browser-url-guard.test.ts` drives real Chromium: it refuses the metadata
address, still reaches a local dev server, and confirms a page's own fetch to the
metadata address is blocked.

---

## 6. Item 5 — `/api/coordination` authentication

The route served a repository file with no authentication. It now uses the same
`requireGitHubToken` middleware as every other `/api` route, and the client sends
the same Bearer token it already sends for `/api/github/inspect` and
`/api/tasks/run`.

**How the authentication was decided.** The instruction delegated this: "the law
you figure it out I can't tell you how that call should authenticate." The law
was read from the repository, not invented:

1. Guarded routes use `requireGitHubToken`.
2. The token lives in React state (`githubToken`), pasted by the user in the UI.
   It is not in the page, so it cannot be sent automatically.
3. The other guarded client calls send exactly `Authorization: Bearer <token>`.

The client change also needed a second `useEffect` keyed on `githubToken`. Without
it the document never loads: the mount-time call carries an empty token and is
refused, and nothing retries when the token is set.

`tests/coordination-auth.test.ts` boots the real server and asserts `401` without
a token, and checks the client still sends the header.

---

## 7. Item 6 — `--ignore-scripts`

Every install step in every workflow now passes it, so a dependency's lifecycle
script cannot run with the workflow's secrets in scope.
`tests/workflow-install.test.ts` scans all workflows and fails if any install step
omits it, so a new workflow cannot regress this.

---

## 8. Two judgment calls

**Loopback is allowed** in both the `fetch_url` guard and the browser guard.
This was not free choice. `tests/browser-capability-matrix.test.ts` and the
website-scenario matrix fetch `127.0.0.1` fixture servers, and the repository's
own documentation describes Forge verifying its local dev server. Blocking
loopback broke `fetch_url retrieves a local HTTP response` on the first full run.
The response was to change the code to match behaviour the suite already asserts —
metadata and private ranges stay blocked — **not** to weaken the test. No existing
test was modified.

**One existing test failed on the first run** (`npm test`, exit 1, 320/321). It
was fixed by correcting the code, and the whole suite was re-run from a clean
install.

---

## 9. Verification (raw output)

Local, after `rm -rf node_modules`, using the exact CI commands including
`--ignore-scripts`:

```
npm ci --ignore-scripts -> added 241 packages, and audited 242 packages in 6s
npm run lint            -> tsc --noEmit
npm run build           -> ✓ built in 214ms
npm test                -> ℹ tests 330  ℹ pass 330  ℹ fail 0  ℹ skipped 0
CHAIN EXIT=0
```

CI on the PR head `b792cf0` (`verify`) independently reports:

```
# tests 330
# pass 330
# fail 0
```

330 pass, 0 fail, 0 skipped — up from 311; all 19 new tests pass. `sentinel`
skipped, which is expected for this trigger. `mergeable_state` is `clean`.
No dependency, lockfile, or existing-test changes. No secrets in the diff.

---

## 10. Open questions and notes

1. **The Amina run used CI keys, not local keys.** `GROQ_API_KEY` and
   `GEMINI_API_KEY` are not present in the local environment; only
   `OPENHANDS_API_KEY` is. The keys exist as Actions secrets, so the
   Gemini+Groq-only run was dispatched on `company-audit.yml`
   (run `39123453557`) rather than run locally. A local run without those keys
   would use the keyless router, which is explicitly not what was asked for.

2. **Loopback is a deliberate exception.** If loopback must be blocked as well,
   the two fixture-server test files have to change first, and that is a
   behavioural change to the product, not a fix — it should be a separate,
   explicit decision.

3. **`requireGitHubToken` validates against GitHub and an allowlist.** The client
   token is the operator's own GitHub token. If a non-GitHub auth scheme is
   wanted for `/api/coordination`, that is a larger change than this item and was
   not assumed.

4. **#118 is open and unmerged** and awaits the owner's decision, consistent with
   the standing rule.

No secrets, tokens, or credentials appear in this document.
