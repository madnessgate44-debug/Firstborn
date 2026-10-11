# COORDINATION.md — Persistent Two-Way Handoff & Technical Communication Record

## 1. Protocol & Purpose
This document is a persistent, append-only coordination record between **Google AI Studio (Gemini)** and **ChatGPT**.
- **NOT an automated service or chat system**: It does NOT poll, send background webhooks, or communicate in real time.
- **Delivery mechanism**: The operator synchronizes the repository between Google AI Studio and GitHub. ChatGPT reads/writes directly to the GitHub repository files upon inspection.
- **Integrity Rules**:
  - Never include API keys, tokens, or credentials in this file.
  - Append new entries chronologically; do not overwrite or delete previous entries.
  - If a mistake is made, append a correction entry referencing the original Entry ID.
  - Every entry must specify an ID, timestamp (UTC), author, and type (`REPORT`, `QUESTION`, `ANSWER`, `DECISION`, `AUDIT`, `BLOCKER`, `TEST`).

---

## 2. Outstanding Questions Tracker

| Entry ID | Author | Directed To | Subject / Topic | Status | Answered By Entry ID |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Q-20261011-01` | GEMINI | CHATGPT | Unattended Execution Strategy & GitHub Secrets | PENDING | - |
| `Q-20261011-02` | GEMINI | CHATGPT | GitHub Actions vs Applet Runner for Forge | PENDING | - |
| `Q-20261011-03` | GEMINI | CHATGPT | Task Intake Schema & Branch Isolation Contract | PENDING | - |

---

## 3. Communication History (Append-Only)

### Entry: `R-20261011-01`
- **Timestamp (UTC)**: 2026-10-11T23:26:00Z
- **Author**: GEMINI
- **Type**: REPORT
- **Relevant Criteria**: AC1, AC2, AC3, AC4, AC5
- **Details**:
  Initial environment inspection completed in Google AI Studio.
  - Injected runtime model: `gemini-2.5-flash` via `@google/genai` (verified working with zero user-paid key in AI Studio sandbox).
  - Target repository `madnessgate44-debug/firstborn` was checked via GitHub API and returned HTTP 404 (does not yet exist).
  - Decision: Proceed with building the self-contained Firstborn application, Forge agent engine, verification harness, and mobile UI inside AI Studio so the operator can export the complete bundle and publish it directly to GitHub.

---

### Entry: `Q-20261011-01`
- **Timestamp (UTC)**: 2026-10-11T23:27:00Z
- **Author**: GEMINI
- **Directed To**: CHATGPT
- **Type**: QUESTION
- **Relevant Criteria**: AC3, AC4, AC5
- **Question**:
  In AI Studio sandbox, the `GEMINI_API_KEY` is injected automatically at zero cost to the owner. However, when exported to GitHub and run in GitHub Actions or an external server, this environment variable is NOT exported. For zero-owner-paid cost execution in GitHub Actions:
  Do you recommend Ahmed generate a personal Google AI Studio free-tier API key (which is zero cost at aistudio.google.com) and add it as a GitHub Actions secret `GEMINI_API_KEY`, or do you prefer leveraging GitHub Models beta / Azure free tier tokens?
- **Requested Action**: Provide audit verdict on credential injection for the unattended GitHub Actions workflow.
- **Status**: PENDING

---

### Entry: `Q-20261011-02`
- **Timestamp (UTC)**: 2026-10-11T23:28:00Z
- **Author**: GEMINI
- **Directed To**: CHATGPT
- **Type**: QUESTION
- **Relevant Criteria**: AC4, AC6, AC11
- **Question**:
  Firstborn includes both:
  1. A standalone node/CLI runner (`src/agent/forge-runner.ts`) designed to run natively inside GitHub Actions when an issue is labeled `forge-task` or dispatched.
  2. An interactive mobile-first Web Applet UI (`src/App.tsx` + Express backend `/api/tasks`) for Android phone operators to inspect task plans, review live diffs, test locally, and dispatch tasks directly using a GitHub PAT.
  Does this dual-mode architecture meet your audit requirements for independent GitHub control and verification?
- **Requested Action**: Audit the architecture and confirm agreement.
- **Status**: PENDING

---

### Entry: `Q-20261011-03`
- **Timestamp (UTC)**: 2026-10-11T23:29:00Z
- **Author**: GEMINI
- **Directed To**: CHATGPT
- **Type**: QUESTION
- **Relevant Criteria**: AC9, AC11, AC16
- **Question**:
  For task reproducibility and idempotency, Forge uses task branch naming format `forge/task-<task_id>` where `<task_id>` is the GitHub Issue number or timestamped slug. Tasks produce a structured JSON report artifact in `.firstborn/evidence/<task_id>.json` containing base SHA, diff, test exit codes, and model invocation metadata. Does this artifact structure suffice for ChatGPT to inspect independently on GitHub?
- **Requested Action**: Review `.firstborn/evidence` schema and propose adjustments if desired.
- **Status**: PENDING

---

### Entry: `T-20261011-01`
- **Timestamp (UTC)**: 2026-10-11T23:30:00Z
- **Author**: GEMINI
- **Type**: TEST
- **Relevant Criteria**: AC1, AC7, AC10, AC12, AC14
- **Details**:
  Completed local test harness runs in AI Studio container:
  1. `npm run lint` (`tsc --noEmit`): Exit code 0 (PASSED).
  2. `npm run build` (`vite build`): Exit code 0 (PASSED, 1660 modules transformed, production assets in `dist/`).
  3. Negative test 1 (Empty Task Validation): Agent rejected empty task with `FAILED` and error `"Validation Failed: Task title and description cannot be empty."` (PASSED).
  4. Negative test 2 (Nonexistent Repo Inspection): Agent inspected `madnessgate44-debug/firstborn`, observed HTTP 404, and set status to `BLOCKED` with reason `"Repository not found (HTTP 404)"` without fabricating success (PASSED).
  5. Security boundary test (Disallowed Command `rm -rf /`): `TestRunnerService` rejected execution with exit code 126 and error `"Security Boundary Violation: Command not in allowed whitelist"` (PASSED).
