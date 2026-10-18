<!-- Full-coverage company audit of madnessgate44-debug/Amina.
     Actions run 39115970237, branch fix/audit-d @ 23df6eb0.
     Status COMPLETED: 133/133 files (100%), 62/62 chunks answered, 0 failed.
     Routes: Gemini only (google), 62 calls, 5 min 41 s. Zero keyless, zero 429.
     This file is the report as emitted, with only the GitHub log prefix stripped. -->

# Forge Full-coverage Audit: madnessgate44-debug/Amina

- Status: COMPLETED
- Audited commit: 86c1e73cf760069b1dd58fba994f3f3f0f49a00c
- Tracked files: 133
- Files examined: 133/133 (100%)
- Chunks: 62/62 answered
- Route: google / gemini-flash-latest
- Routes used: google / gemini-3.5-flash (22 chunks); google / gemini-flash-latest (19 chunks); google / gemini-3.7-flash (17 chunks); google / gemini-3.5-flash-lite (4 chunks)
- Model calls: 62
- Wall time: 5 min 41 s
- Evidence: 1 supported, 2 contradicted, 65 judgment
- Write access used: no
- Target code executed: no

## Coverage
- Examined: 133 of 133 files (100%).
- Every chunk returned a usable answer.

## Findings
### HIGH — Parent PIN stored and verified in plaintext without hashing or constant-time comparison
_basis: observed · paths: src/services/parent/parentService.ts_

- Claim: In `linkParentAccount`, `account.pin` is saved as `data.pin.trim()`, and `verifyPin` compares via `account.pin.trim() === enteredPin.trim()`, persisting and evaluating PINs in plaintext without salt, hashing, or timing-safe checks.
- Recommendation: Hash parent PINs using a secure password hashing mechanism (or salted KDF) before persisting to storage, and verify entered PINs against hashed digests using constant-time comparison.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/parent/parentService.ts
    - spot-check: search the repo for `src/services/parent/parentService.ts`

### MEDIUM — CI type check step set to continue on error
_basis: observed · paths: .github/workflows/ci.yml_

- Claim: continue-on-error: true # ponytail: remove continue-on-error once the pre-existing type errors are 0
- Recommendation: Resolve pre-existing type errors and remove 'continue-on-error: true' so that broken type checks fail the build and block invalid PRs.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: .github/workflows/ci.yml
    - spot-check: search the repo for `.github/workflows/ci.yml`

### MEDIUM — Unbounded in-memory TTS cache allows memory exhaustion
_basis: observed · paths: server.ts_

- Claim: server.ts declares `const ttsCache = new Map<string, string>();` and sets keys on `/api/tts` (`ttsCache.set(cacheKey, base64Audio);`) without an eviction policy, max size cap, or TTL.
- Recommendation: Introduce an LRU cache or bounded cache structure with TTL and maximum item limits to prevent heap memory exhaustion under sustained usage.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: server.ts
    - spot-check: search the repo for `server.ts`

### MEDIUM — Unauthenticated and unthrottled AI endpoints allow resource and quota exhaustion
_basis: observed · paths: server.ts_

- Claim: Endpoints `/api/chat`, `/api/stt`, `/api/tts`, `/api/tutor-explain`, `/api/tutor-reply`, `/api/check-homework`, and `/api/reconstruct-day` accept arbitrary requests with up to 15mb JSON payload without client authentication or per-IP/user rate limiting.
- Recommendation: Add request authentication or session tokens along with rate-limiting middleware (e.g. express-rate-limit) to protect upstream Gemini API quota and server resources.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: server.ts
    - spot-check: search the repo for `server.ts`

### MEDIUM — Unsynchronized state between CollectionsScreen local state and global context
_basis: observed · paths: src/components/collections/CollectionsScreen.tsx_

- Claim: CollectionsScreen fetches collections and saved items into local state via storageService directly on mount (`storageService.getSavedItems`, `ensureDefaultCollections`), rather than subscribing to or using AppContext (`savedItems`, `collections`), causing changes made via SaveLikeButton or SaveToCollectionModal to be out of sync.
- Recommendation: Consume collections and savedItems directly from useApp context or trigger a refetch upon context updates so collection changes reflect immediately.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/collections/CollectionsScreen.tsx
    - spot-check: search the repo for `src/components/collections/CollectionsScreen.tsx`

### MEDIUM — Unchecked property access on possibly undefined recheck question object
_basis: observed · paths: src/components/teacher/VirtualTeacherClassroom.tsx_

- Claim: const rq = recheckQuestion || teacherContext.recheckQuestion; followed directly by rq.promptAr, rq.options.map(...), and rq.thinkingPromptAr without verifying rq exists.
- Recommendation: Add a defensive guard or fallback UI check before rendering recheck question stations to prevent runtime crashes if neither recheckQuestion nor teacherContext.recheckQuestion is populated.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/teacher/VirtualTeacherClassroom.tsx
    - spot-check: search the repo for `src/components/teacher/VirtualTeacherClassroom.tsx`

### MEDIUM — Parent authentication PIN passed in plaintext across frontend actions
_basis: observed · paths: src/context/AppContext.tsx_

- Claim: Methods such as linkParent, verifyAndEnterParentMode, updateParentPrefs, and unlinkParent accept a plaintext string `pin` and store/verify it via client-side storage without visible hashing or rate limiting.
- Recommendation: Ensure parent PIN is hashed using a standard slow-hash or salted key derivation function before storage and verification, and implement client lockout/rate-limiting on failed PIN attempts.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/context/AppContext.tsx
    - spot-check: search the repo for `src/context/AppContext.tsx`

### MEDIUM — Monotonic union in saveItem prevents removing saved items from collections
_basis: observed · paths: src/services/collections/collectionService.ts_

- Claim: In `saveItem`: `item.collectionIds = Array.from(new Set([...item.collectionIds, ...payload.collectionIds]));` merges existing and new collectionIds. Later sync logic checks `const shouldContain = payload.collectionIds.includes(col.id);` and removes it from `col.itemIds`, leaving `item.collectionIds` desynchronized with `col.itemIds` and preventing un-assigning an item from collections on update.
- Recommendation: When updating an existing item in saveItem, set `item.collectionIds` to `payload.collectionIds` directly or clarify the diffing semantics between `item.collectionIds` and the collection entities to prevent data drift.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/collections/collectionService.ts
    - spot-check: search the repo for `src/services/collections/collectionService.ts`

### MEDIUM — Deterministic quiz generator always sets index 0 as correct answer
_basis: observed · paths: src/services/content/contentGenerator.ts_

- Claim: In `getQuizQuestionsForConcept`, q1 has `correctAnswer: 0` with options `['صحيح (True)', 'خطأ (False)']`, q2 has `correctAnswer: 0` with the first option being `concept.descriptionAr`, and q3 has `correctAnswer: 0` with the first option being the correct explanation. In `getReelForConcept`, `quickCheck` also hardcodes `correctIndex: 0`.
- Recommendation: Shuffle question options dynamically or randomize the correct option placement to prevent predictable answer patterns.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/content/contentGenerator.ts
    - spot-check: search the repo for `src/services/content/contentGenerator.ts`

### MEDIUM — Overly permissive substring matching in student answer evaluation causes false positive grades
_basis: observed · paths: src/services/homework/homeworkGenerator.ts_

- Claim: In evaluateStudentAnswer for short_answer and fill_in_the_blank: 'const isMatch = normStudent === normTarget || cleanStudent === cleanTarget || normStudent.includes(normTarget) || normTarget.includes(normStudent);'. When normStudent is a substring of normTarget (e.g. typing a single letter or prefix such as 'ا' or 'الم' when the answer is 'المعلمون'), normTarget.includes(normStudent) evaluates to true and marks the question full correct.
- Recommendation: Remove asymmetric 'normTarget.includes(normStudent)' or enforce minimum token length and word boundary matching before accepting partial substring containment.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/homework/homeworkGenerator.ts
    - spot-check: search the repo for `src/services/homework/homeworkGenerator.ts`

### MEDIUM — Parent preferences bedtime property schema mismatch between services
_basis: observed · paths: src/services/missions/missionPlanner.ts, src/services/parent/parentService.ts_

- Claim: In `missionPlanner.ts`, bedtime logic reads `parentPreferences?.bedtimeLimit` (`parentPreferences.bedtimeLimit.split(':')`), whereas `DEFAULT_PARENT_PREFERENCES` and `isPastBedtime` in `parentService.ts` define and read `preferences.bedtime`.
- Recommendation: Standardize property naming across the domain types and services to use either `bedtime` or `bedtimeLimit` consistently so bedtime constraints actually trigger during mission planning.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/missions/missionPlanner.ts, src/services/parent/parentService.ts
    - spot-check: search the repo for `src/services/missions/missionPlanner.ts`

### MEDIUM — Synthetic fallback data injected into generated weekly review metrics
_basis: observed · paths: src/services/review/weeklyReviewGenerator.ts_

- Claim: In generateWeeklyReview(), if dayRecords have no lessons, hardcoded placeholder lessons are pushed: 'lessonsCovered.push({ subject: isAr ? 'الرياضيات' : 'Mathematics', topic: ... })'. Similarly, if formatEffectiveness is empty, hardcoded retention scores (0.92, 0.85) and sample counts (5, 6) are inserted, and if quiz evidence count is 0, averageQuizScore defaults to 84.
- Recommendation: Return empty collections or zero-valued statistics when no user activity records exist rather than generating synthetic progress data that misrepresents actual student performance.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/review/weeklyReviewGenerator.ts
    - spot-check: search the repo for `src/services/review/weeklyReviewGenerator.ts`

### MEDIUM — Unreachable Code After Return Statement
_basis: observed · paths: src/services/teacher/teacherContextEngine.ts_

- Claim: The main function returns inside its final 'else' branch, but subsequent code block starting with `// 7. Curriculum-grounded fallback...` and its corresponding code remains placed after that return statement.
- Recommendation: Remove or properly integrate the unreachable fallback code block located after the final return statement.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/teacher/teacherContextEngine.ts
    - spot-check: search the repo for `src/services/teacher/teacherContextEngine.ts`

### MEDIUM — Overly broad subject check forces all math lessons to decimal recheck logic
_basis: observed · paths: src/services/teacher/teacherContextEngine.ts_

- Claim: In `buildRecheckQuestionForConcept`: `if (lesson.subjectId === 'subj_math' || lesson.subjectId === 'subj_math' || conceptTitle.includes('عشري') ...)`
- Recommendation: Remove the duplicated condition and do not trigger decimal-specific re-check questions for every math lesson regardless of concept (e.g. geometry or non-decimal topics).
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/teacher/teacherContextEngine.ts
    - spot-check: search the repo for `src/services/teacher/teacherContextEngine.ts`

### MEDIUM — Unsanitized User Input Reflected in Application State Structure
_basis: observed · paths: src/services/teaching/teachingSession.ts_

- Claim: In `advanceSession()`, `studentInput.trim()` is appended directly into `offBookQuestions` (`parentNote` and `question`) and returned as part of `TeachingSession` object without HTML/script sanitization: `parentNote: ... "${studentInput.trim()}"`
- Recommendation: Sanitize `studentInput` or ensure that any consumer displaying `offBookQuestions` or parent notes renders input strictly as text (or explicitly escapes HTML/JS control characters before storing or displaying).
- Evidence: **CONTRADICTED** (verified-fact)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/teaching/teachingSession.ts
    - spot-check: search the repo for `src/services/teaching/teachingSession.ts`
  - contradicts: an unsafe HTML sink exists that could render untrusted content
    - `grep -rn "dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document.write|eval(|new Function(" <repo>`
    - result: 0 matches across 133 files
    - spot-check: search the repo for `dangerouslySetInnerHTML`

### MEDIUM — VisualRenderer renders hardcoded sample SVGs instead of structured data
_basis: observed · paths: src/services/visuals/visualRenderer.tsx_

- Claim: In `renderContent()`, helper functions like `renderStrokeGuide`, `renderMapLike`, `renderTimeline`, `renderDiagram`, `renderComparisonTable`, `renderConceptMap`, and `renderNumberLine` accept `visual: StructuredVisualData`, but all render hardcoded static graphics, texts, and dates (e.g. static Battle of Badr events in `renderTimeline`, static Western vs Eastern desert in `renderComparisonTable`) ignoring visual-specific properties and data payloads.
- Recommendation: Map `visual` object properties (nodes, points, steps, data rows) dynamically into the SVG rendering pipeline instead of rendering hardcoded static content.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/visuals/visualRenderer.tsx
    - spot-check: search the repo for `src/services/visuals/visualRenderer.tsx`

### MEDIUM — Unresolved Promise when Web Speech API is absent and MediaRecorder fallback is active
_basis: observed · paths: src/services/voice/voiceService.ts_

- Claim: In `startListening`: when `this.recognition` is falsy but `recorderActive` is true, the `else` block only checks `if (!recorderActive) { onStatusChange('error'); return reject(new Error('voice_unsupported')); }` followed by comments `// Wait for stopListening to be called / Handler will be resolved when stopListening is triggered`, but `stopListening()` does not keep or resolve any reference to the outer promise's `resolve` or `reject`, leaving the returned promise pending indefinitely.
- Recommendation: Retain the pending promise executor controls (`resolve`/`reject`) or establish an event-driven completion mechanism so that `stopListening()` stops the MediaRecorder and resolves the promise with the Gemini fallback transcript.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/voice/voiceService.ts
    - spot-check: search the repo for `src/services/voice/voiceService.ts`

### LOW — 404 redirect discards deep routing subpaths
_basis: observed · paths: public/404.html_

- Claim: var parts = location.pathname.split('/').filter(Boolean);
if (parts.length > 1) location.replace('/' + parts[0] + '/');
else if (parts.length === 1) location.replace('/');
- Recommendation: If deep linking support is intended for SPA deployment on static hosts, store the full target path in session storage or url parameters prior to redirecting to root.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: public/404.html
    - spot-check: search the repo for `public/404.html`

### LOW — Direct prompt interpolation of untrusted input in tutor endpoints
_basis: observed · paths: server.ts_

- Claim: In `/api/tutor-reply`, user input is interpolated directly into prompt text: `parts: [{ text: `Amina said: "${studentInput}". Context: Lesson "${lessonTitle}" (${subjectName}). Reply to her as Nour!` }]`. A similar raw interpolation pattern is used in `/api/tutor-explain` without input sanitization.
- Recommendation: Sanitize or delimit user-provided string fields and instruct the model to treat user turns strictly as untrusted content, matching the defensive pattern used in `/api/check-homework`.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: server.ts
    - spot-check: search the repo for `server.ts`

### LOW — Unhandled rejection during collection creation and item save
_basis: observed · paths: src/components/collections/SaveToCollectionModal.tsx_

- Claim: In `handleCreateCollection`, `await createCollection(...)` has no try/catch block. In `handleSave`, errors during `saveContent(...)` are not caught or surfaced to the user, leaving the modal open or unhandled on rejection.
- Recommendation: Wrap asynchronous calls in try/catch blocks and display error feedback to the user.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/collections/SaveToCollectionModal.tsx
    - spot-check: search the repo for `src/components/collections/SaveToCollectionModal.tsx`

### LOW — Unused imported Lucide icons
_basis: observed · paths: src/components/curriculum/ConceptDetailModal.tsx_

- Claim: Icons `ShieldCheck`, `AlertTriangle`, `Layers`, and `HelpCircle` are imported from 'lucide-react' at lines 23-28 but never referenced in the component.
- Recommendation: Remove unused icon imports to reduce bundle size and clean up module dependencies.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/ConceptDetailModal.tsx
    - spot-check: search the repo for `src/components/curriculum/ConceptDetailModal.tsx`

### LOW — Unhandled rejection risk in async evidence and decay toggle actions
_basis: observed · paths: src/components/curriculum/ConceptDetailModal.tsx_

- Claim: In `handleApplyEvidence`, `recordEvidence` is called within a try/finally block without a catch block; in `handleToggleLog`, `await toggleShowEvidenceLog(nextVal)` is called without try/catch handling.
- Recommendation: Wrap asynchronous invocations with appropriate error handling (or UI toast notification) to prevent unhandled promise rejections.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/ConceptDetailModal.tsx
    - spot-check: search the repo for `src/components/curriculum/ConceptDetailModal.tsx`

### LOW — Unused imported components, icons, and context variables in CurriculumBrowser
_basis: observed · paths: src/components/curriculum/CurriculumBrowser.tsx_

- Claim: Imports `formatMasteryView`, `BookOpen`, `GraduationCap`, `Play`, `Sparkles`, `CheckCircle2`, `AlertCircle`, `Layers`, `Filter`, `Bookmark`, `ExternalLink`, `HelpCircle`, `FileText`, `Clock`, `Check`, and context destructurings `getMasteryForConcept` and `startMission` are never referenced in the component.
- Recommendation: Remove unused imports and context variables to reduce bundle overhead and improve maintainability.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/CurriculumBrowser.tsx
    - spot-check: search the repo for `src/components/curriculum/CurriculumBrowser.tsx`

### LOW — Unused icon imports bloating bundle and cluttering imports
_basis: observed · paths: src/components/curriculum/CurriculumSubjectPickerModal.tsx_

- Claim: The file imports 'BookOpen', 'Sparkles', 'Play', 'Layers', 'CheckCircle2', and 'GraduationCap' from 'lucide-react' but none of these components are referenced or rendered in the file.
- Recommendation: Remove unused imports from 'lucide-react' to keep bundle size minimal and code clean.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/CurriculumSubjectPickerModal.tsx
    - spot-check: search the repo for `src/components/curriculum/CurriculumSubjectPickerModal.tsx`

### LOW — Outer clickable div lacks keyboard accessibility and role attributes
_basis: observed · paths: src/components/curriculum/CurriculumSubjectPickerModal.tsx_

- Claim: In 'LessonCard', the outer card has an 'onClick={onSelect}' handler and 'cursor-pointer', but lacks 'role="button"', 'tabIndex', or 'onKeyDown' handlers. Furthermore, an inner '<button>' inside the div also handles selection, creating nested interactive elements.
- Recommendation: Refactor LessonCard so the entire interactive element is an accessible button or link, or ensure standard keyboard handlers (e.g. Enter / Space) and ARIA attributes are applied without invalid button nesting.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/CurriculumSubjectPickerModal.tsx
    - spot-check: search the repo for `src/components/curriculum/CurriculumSubjectPickerModal.tsx`

### LOW — Unhandled edge case when options array is undefined in handleSelectOption
_basis: observed · paths: src/components/curriculum/LessonStudyModal.tsx_

- Claim: In handleSelectOption: `const chosenOption = options ? options[optionIdx] : ''; const isCorrect = chosenOption === expectedAnswer;` If `options` is undefined, `chosenOption` defaults to `''`, which could incorrectly evaluate to true if `expectedAnswer` happens to be empty string or falsy, or trigger false negatives.
- Recommendation: Add explicit checks ensuring `options` and `options[optionIdx]` exist before evaluating correctness, or disable option selection when options are missing.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/LessonStudyModal.tsx
    - spot-check: search the repo for `src/components/curriculum/LessonStudyModal.tsx`

### LOW — Missing key prop or non-unique key usage in list renderings
_basis: observed · paths: src/components/dayRecord/DayRecordFlowModal.tsx, src/components/dayRecord/EditDayRecordModal.tsx_

- Claim: In DayRecordFlowModal.tsx, `proposedRecord.lessonsCovered.map((l, i) => (<div key={i}>` and `proposedRecord.homeworkAssigned.map((h, i) => (<div key={i}>` use array index `i` as key. In EditDayRecordModal.tsx, `lessons.map((lesson, idx) => (<div key={idx}>` uses index `idx` as key when items are dynamic and mutable (added/removed).
- Recommendation: Use unique identifier properties or generated IDs for list item keys instead of array indices to prevent React re-rendering glitches during list modification.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/dayRecord/DayRecordFlowModal.tsx, src/components/dayRecord/EditDayRecordModal.tsx
    - spot-check: search the repo for `src/components/dayRecord/DayRecordFlowModal.tsx`

### LOW — Unused component imports and duplicate symbol declarations
_basis: observed · paths: src/components/home/HomeScreen.tsx_

- Claim: Icons like Badge, CheckCircle, AlertCircle, Sun, Moon, PlusCircle, Calendar, CheckCircle2, Heart are imported but unused in HomeScreen.tsx. Additionally, CheckCircle2 and Heart are imported twice in the same import block from 'lucide-react'.
- Recommendation: Clean up unused icon imports and remove duplicate declarations from the Lucide react import list.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/home/HomeScreen.tsx
    - spot-check: search the repo for `src/components/home/HomeScreen.tsx`

### LOW — Unused imported components in MissionRunnerModal
_basis: observed · paths: src/components/missions/MissionRunnerModal.tsx_

- Claim: MissionRunnerModal imports TeachingSessionModal, Sparkles, ArrowRight, ArrowLeft, CheckCircle, and Lightbulb from their respective modules, but none of these imported symbols are referenced anywhere in the component body.
- Recommendation: Remove unused imports (TeachingSessionModal, Sparkles, ArrowRight, ArrowLeft, CheckCircle, Lightbulb) to keep the codebase clean and avoid bundle bloat.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/missions/MissionRunnerModal.tsx
    - spot-check: search the repo for `src/components/missions/MissionRunnerModal.tsx`

### LOW — Uncancelled setTimeout on fast unmount or step transition
_basis: observed · paths: src/components/onboarding/OnboardingFlow.tsx_

- Claim: In handleSelectOption: setTimeout(() => { setCurrentQuestionIndex((prev) => prev + 1); }, 250); is scheduled without storing a timer reference or clearing it on unmount / navigation.
- Recommendation: Store the timer ID in a ref and clear it in a useEffect cleanup or cancel pending timers when changing steps or unmounting.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/onboarding/OnboardingFlow.tsx
    - spot-check: search the repo for `src/components/onboarding/OnboardingFlow.tsx`

### LOW — Parent PIN validation does not enforce numeric digits
_basis: observed · paths: src/components/parent/ParentAuthModal.tsx_

- Claim: The form labels and error messages describe PIN as digits ('PIN must be at least 4 digits.', 'PIN (4 digits):'), but the validation only checks `pin.length < 4` without enforcing numeric characters (`/^\d{4,6}$/`).
- Recommendation: Validate that the PIN consists strictly of numeric digits matching the expected length before calling linkParent or verifyAndEnterParentMode.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/parent/ParentAuthModal.tsx
    - spot-check: search the repo for `src/components/parent/ParentAuthModal.tsx`

### LOW — ProgressScreen displays fabricated mock data for 13 of the last 14 days
_basis: observed · paths: src/components/progress/ProgressScreen.tsx_

- Claim: dailyActivity calculates minutes and concepts using hardcoded modulo arithmetic: `let minutes = (i % 3 === 0 ? 30 : i % 2 === 0 ? 20 : 0); let conceptsTouched = (i % 3 === 0 ? 3 : i % 2 === 0 ? 2 : 0);` instead of retrieving actual historical daily sessions or logs from storage/context.
- Recommendation: Aggregate actual session time and concept records from history/storage for past days, and display 0 or an empty state when no historical data exists instead of synthetic non-zero demo numbers.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/progress/ProgressScreen.tsx
    - spot-check: search the repo for `src/components/progress/ProgressScreen.tsx`

### LOW — Unused imported symbols in ProfileScreen
_basis: observed · paths: src/components/profile/ProfileScreen.tsx_

- Claim: Imports `voiceService`, `CheckCircle2`, `AlertTriangle`, and `Compass` are imported from their respective modules but never referenced anywhere in ProfileScreen.tsx.
- Recommendation: Remove unused imports `voiceService`, `CheckCircle2`, `AlertTriangle`, and `Compass` to reduce bundle overhead and clean up code.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/profile/ProfileScreen.tsx
    - spot-check: search the repo for `src/components/profile/ProfileScreen.tsx`

### LOW — Hardcoded mock latencies mixed with telemetry breakdown fallback
_basis: observed · paths: src/components/settings/DeveloperPanel.tsx_

- Claim: In DeveloperPanel.tsx, targets display hardcoded values like `~15ms` for quiz and `~120ms` for home load, while chat latency falls back to `~1850`ms (`{todaySummary.endpointBreakdown['/api/chat']?.avgLatencyMs || '~1850'}ms`), which may misrepresent measured system performance as actual telemetry when no metrics exist.
- Recommendation: Show an explicit empty or unmeasured state (e.g., 'N/A' or '-') when real telemetry data is not yet recorded rather than hardcoded mock strings.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/settings/DeveloperPanel.tsx
    - spot-check: search the repo for `src/components/settings/DeveloperPanel.tsx`

### LOW — Client-side telemetry log purge relies solely on window.confirm
_basis: observed · paths: src/components/settings/DeveloperPanel.tsx_

- Claim: In DeveloperPanel.tsx, handleClearLogs uses `if (!confirm(isAr ? '...' : 'Clear all telemetry logs?')) return; costLatencyService.clearLogs();`, relying on standard browser confirm dialogues which can easily be accidentally triggered or bypassed in certain embedded browser views.
- Recommendation: Implement a dedicated in-app modal confirmation matching the pattern used in SettingsScreen for resetting profile data.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/settings/DeveloperPanel.tsx
    - spot-check: search the repo for `src/components/settings/DeveloperPanel.tsx`

### LOW — Non-interactive div elements used with click handlers without keyboard interaction roles
_basis: observed · paths: src/components/teacher/VirtualTeacherClassroom.tsx_

- Claim: In activeStation === 'vocab', cards are rendered as `<div key={idx} onClick={() => handleSelectVocabCard(idx)} className="... cursor-pointer ...">` without role="button", tabIndex={0}, or onKeyDown handlers.
- Recommendation: Convert the vocabulary card container div into a semantic `<button>` or add role="button", tabIndex={0}, and an onKeyDown handler for accessibility compliance.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/teacher/VirtualTeacherClassroom.tsx
    - spot-check: search the repo for `src/components/teacher/VirtualTeacherClassroom.tsx`

### LOW — Missing cleanup for ongoing speech synthesis on unmount
_basis: observed · paths: src/components/voice/TaskInstructionSpeaker.tsx_

- Claim: TaskInstructionSpeaker triggers `tutorSpeechService.speakTaskInstruction` and `tutorSpeechService.speakEncouragingFeedback` in `useEffect`, but neither hook returns a cleanup callback calling `tutorSpeechService.stopSpeaking()`.
- Recommendation: Return a cleanup function from the `useEffect` hooks calling `tutorSpeechService.stopSpeaking()` so audio stops immediately if the user navigates away or closes the modal.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/voice/TaskInstructionSpeaker.tsx
    - spot-check: search the repo for `src/components/voice/TaskInstructionSpeaker.tsx`

### LOW — Missing validation for time range ordering when adding or editing timetable slots
_basis: observed · paths: src/components/timetable/TimetableScreen.tsx_

- Claim: In `handleSaveSlot`, `slotStartTime` and `slotEndTime` are saved directly to `newSlot` without verifying that `slotStartTime < slotEndTime`.
- Recommendation: Add a validation check in `handleSaveSlot` verifying `slotEndTime > slotStartTime` and present a validation message if the end time is earlier than or equal to the start time.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/timetable/TimetableScreen.tsx
    - spot-check: search the repo for `src/components/timetable/TimetableScreen.tsx`

### LOW — Stale closure in VoiceSpeakButton unmount cleanup leaves speech active
_basis: observed · paths: src/components/voice/VoiceSpeakButton.tsx_

- Claim: In VoiceSpeakButton.tsx lines 31-38: useEffect has dependency array [text, autoPlay, settings.companionVoiceEnabled]. The return cleanup checks 'if (isPlaying) { voiceService.cancelSpeech(); }'. Because isPlaying is captured from render closure at the time the effect ran (often false), cancelling speech upon component unmount fails to fire when playback starts afterwards.
- Recommendation: Use a mutable ref (e.g., isPlayingRef) or always invoke voiceService.cancelSpeech() during unmount regardless of the state variable.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/voice/VoiceSpeakButton.tsx
    - spot-check: search the repo for `src/components/voice/VoiceSpeakButton.tsx`

### LOW — Hardcoded Arabic placeholder in VoiceInputControl textarea
_basis: observed · paths: src/components/voice/VoiceInputControl.tsx_

- Claim: In VoiceInputControl.tsx line 249: placeholder="اكتب أو عدل النص هنا..." is hardcoded in Arabic instead of using localized strings from useApp().t context.
- Recommendation: Replace the hardcoded string with a localized key from t.voice.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/voice/VoiceInputControl.tsx
    - spot-check: search the repo for `src/components/voice/VoiceInputControl.tsx`

### LOW — Potential timer leak on unmount during push-to-talk hold
_basis: observed · paths: src/components/voice/VoiceInputControl.tsx_

- Claim: In VoiceInputControl.tsx line 47 and lines 76-85: pressTimerRef.current is scheduled via setTimeout in handleMouseDown, but there is no useEffect cleanup on component unmount to clearTimeout if the component unmounts while holding.
- Recommendation: Add a cleanup useEffect returning () => { if (pressTimerRef.current) clearTimeout(pressTimerRef.current); }.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/voice/VoiceInputControl.tsx
    - spot-check: search the repo for `src/components/voice/VoiceInputControl.tsx`

### LOW — Toast timer unmount leak risk with naked setTimeout
_basis: observed · paths: src/context/AppContext.tsx_

- Claim: showToast sets state via setTimeout without capturing the timeout ID or clearing it upon unmount: setTimeout(() => { setToastMessage((prev) => (prev === msg ? null : prev)); }, 3500);
- Recommendation: Store the timeout reference in a useRef or cleanup effect to prevent state updates on unmounted components.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/context/AppContext.tsx
    - spot-check: search the repo for `src/context/AppContext.tsx`

### LOW — Inline arrow function instantiated within memoized AppContext value
_basis: observed · paths: src/context/AppContext.tsx_

- Claim: dismissGentleNudge: () => setGentleCompanionNudge(null), inside useMemo return value in AppContext.tsx
- Recommendation: Define handleDismissGentleNudge with useCallback or a stable reference outside the useMemo block so consumers relying on reference stability for dismissGentleNudge do not re-render unnecessarily.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/context/AppContext.tsx
    - spot-check: search the repo for `src/context/AppContext.tsx`

### LOW — Unit numbering mismatch with theme structure in Islamic curriculum
_basis: observed · paths: src/data/curriculum/islamicCurriculum.ts_

- Claim: In `ISLAMIC_CURRICULUM_LESSONS`, the second lesson defines `unitNumber: 2`, but `unitNameAr: 'المحور الأول: أكتشف ذاتي — العبادات'`, `unitNameEn: 'Theme 1: Worship — Prayer & Purification'`, and `sourceRef.unit: 'المحور الأول: العبادات'`.
- Recommendation: Align `unitNumber` with the corresponding curriculum theme/unit metadata or clarify unit indexing conventions to avoid confusion across curriculum queries.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/data/curriculum/islamicCurriculum.ts
    - spot-check: search the repo for `src/data/curriculum/islamicCurriculum.ts`

### LOW — Inconsistent language content in mathCurriculum lesson
_basis: observed · paths: src/data/curriculum/mathCurriculum.ts_

- Claim: In src/data/curriculum/mathCurriculum.ts (unit 6, lesson 1), objectives and readingText are written in French (e.g. 'Appliquer l\'ordre des opérations mathématiques...', 'L\'ordre fondamental des opérations (p. 121) :') while titleAr, vocabulary definitions, and exercises are in Arabic, unlike other lessons in standard math curricula.
- Recommendation: Ensure language consistency across lesson fields or provide explicit multilingual versions aligned with the lesson's target language.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/data/curriculum/mathCurriculum.ts
    - spot-check: search the repo for `src/data/curriculum/mathCurriculum.ts`

### LOW — Potential type incompatibility with null readingText in curriculum item
_basis: observed · paths: src/data/curriculum/scienceFrCurriculum.ts_

- Claim: In lesson 'off_scifr_u2_l1_matiere', 'readingText: null' is provided while other curriculum lessons define it as a string (`readingText: null, // Clearly marked as pending rather than fabricated!`). If `OfficialCurriculumLesson` expects `string | undefined` or non-nullable `string`, this causes runtime type assumptions to break if consuming components run string operations without null checks.
- Recommendation: Ensure `readingText` in `OfficialCurriculumLesson` explicitly allows `null` (`readingText?: string | null`) or use an empty string / `undefined` to adhere to standard optional string typing across consumers.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/data/curriculum/scienceFrCurriculum.ts
    - spot-check: search the repo for `src/data/curriculum/scienceFrCurriculum.ts`

### LOW — Incomplete French locale structure compared to Arabic and English
_basis: observed · paths: src/i18n/translations.ts_

- Claim: In `src/i18n/translations.ts`, the `settings` object in `fr` defines `french: 'Français (Français)'`, whereas `ar` and `en` do not declare a `french` key in `settings`. Additionally, differences in curriculum labels (e.g. `8 Matières Officielles` vs `٣ مواد أساسية` / `3 Core Subjects`) indicate schema asymmetry across supported languages.
- Recommendation: Ensure all language objects in `translations` adhere to a strictly typed TypeScript interface to prevent missing translation keys or structural drift at runtime.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/i18n/translations.ts
    - spot-check: search the repo for `src/i18n/translations.ts`

### LOW — Potential streak miscalculation due to daylight saving and UTC/local date string diffing
_basis: observed · paths: src/services/gamification/gamificationService.ts_

- Claim: In `updateForgivingStreak`: `const diffDays = Math.round((todayTime - lastTime) / (1000 * 3600 * 24));` using dates parsed directly from `localDateStr()` via `new Date(string).getTime()` can be impacted by daylight saving transitions or clock shifts.
- Recommendation: Use calendar day arithmetic (e.g. comparing year, month, and day components or UTC midnight timestamps) instead of millisecond division.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/gamification/gamificationService.ts
    - spot-check: search the repo for `src/services/gamification/gamificationService.ts`

### LOW — Hardcoded concept question generator ignores concept metadata and grade level
_basis: observed · paths: src/services/homework/homeworkGenerator.ts_

- Claim: generateQuestionsForConcept checks only whether concept.subjectId === 'subj_math' or 'subj_arabic', and otherwise falls back to a single hardcoded set of science questions about ecosystems, regardless of which concept or grade level was actually matched.
- Recommendation: Map question generation dynamically to concept IDs/subtopics or generate concept-specific questions rather than returning a static preset based solely on broad subject.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/homework/homeworkGenerator.ts
    - spot-check: search the repo for `src/services/homework/homeworkGenerator.ts`

### LOW — Subject struggle classification only maps three hardcoded subjects
_basis: observed · paths: src/services/parent/parentService.ts_

- Claim: In `generateParentWeeklySummary`, `sName` maps `subj_math` to Mathematics, `subj_arabic` to Arabic, and defaults every other subject ID (`subj_english`, `subj_science`, `subj_social`, `subj_ict`, etc.) directly to 'Science' / 'العلوم'.
- Recommendation: Use a dynamic subject lookup or helper matching curriculum subjects (like `getSubjectDisplayName`) instead of a ternary that collapses all non-math and non-arabic subjects into Science.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/parent/parentService.ts
    - spot-check: search the repo for `src/services/parent/parentService.ts`

### LOW — Loose substring matching causes normalized subject collisions
_basis: observed · paths: src/services/reconstruction/dayRecordReconciliation.ts_

- Claim: In normalizeSubject(), 'clean.includes("رياض") || clean.includes("حساب") || clean.includes("math")' returns 'math', but later 'clean.includes("رياضي") || clean.includes("pe") ...' is checked for physical education ('pe'). Arabic words containing 'رياضي' (e.g. 'رياضيات' or 'تربية رياضية') will match the earlier 'رياض' check and classify as 'math' instead of 'pe', or match 'math_fr' depending on position.
- Recommendation: Check more specific terms before generic substrings, or use exact/word-boundary pattern matching when categorizing subjects.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/reconstruction/dayRecordReconciliation.ts
    - spot-check: search the repo for `src/services/reconstruction/dayRecordReconciliation.ts`

### LOW — Redundant repeated identity comparisons in conditionals
_basis: observed · paths: src/services/teacher/teacherContextEngine.ts_

- Claim: In `buildRecheckQuestionForConcept`: `lesson.subjectId === 'subj_math' || lesson.subjectId === 'subj_math'`. In `buildTargetedIntervention`: `lesson.subjectId === 'subj_math' || lesson.subjectId === 'subj_math'` and `lesson.subjectId === 'subj_science' || lesson.subjectId === 'subj_science'`.
- Recommendation: Remove redundant identical operands from logical OR expressions.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/teacher/teacherContextEngine.ts
    - spot-check: search the repo for `src/services/teacher/teacherContextEngine.ts`

### LOW — Unit test side-effect writing to disk during execution
_basis: observed · paths: src/services/teaching/__tests__/teachingSession.test.ts_

- Claim: In teachingSession.test.ts, helper function assert uses node:fs writeFileSync('teaching-test-failure.txt', message, 'utf8') to persist failure output directly to local disk on assertions.
- Recommendation: Avoid writing output files to disk during unit tests; rely on standard test runner reporting (console/stdout) or jest assertions to handle assertion failures cleanly.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/teaching/__tests__/teachingSession.test.ts
    - spot-check: search the repo for `src/services/teaching/__tests__/teachingSession.test.ts`

### LOW — Potential timer leak in instrumentedFetch on synchronous exceptions prior to fetch completion
_basis: observed · paths: src/services/telemetry/costLatencyService.ts_

- Claim: In `instrumentedFetch`, `timer = setTimeout(() => controller.abort(), timeout)` is scheduled before `fetch`. If an exception occurs synchronously before or during setup, or if execution enters the catch block, `clearTimeout(timer)` is called in both try and catch blocks, but the timer handle is not cleaned up if an error is rethrown or if an unexpected exception occurs before reaching the catch block's clearTimeout call. More reliably, cleanup should occur in a `finally` block.
- Recommendation: Move `clearTimeout(timer)` to a `finally` block to guarantee the timeout handle is always cleared regardless of the exit path.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/telemetry/costLatencyService.ts
    - spot-check: search the repo for `src/services/telemetry/costLatencyService.ts`

### LOW — Unbounded in-memory session state in tutorEngine module
_basis: observed · paths: src/services/tutor/tutorEngine.ts_

- Claim: `const sessionStates: Map<string, TutorState> = new Map();` stores state keyed by `${studentId}_${conceptId}_${sessionId}` without an eviction policy, max size cap, or TTL. Over long-running single-page application sessions, this map will grow indefinitely as new sessions or concepts are created.
- Recommendation: Introduce a maximum size limit or LRU eviction mechanism to `sessionStates` to avoid unbounded memory growth in long-running client sessions.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/tutor/tutorEngine.ts
    - spot-check: search the repo for `src/services/tutor/tutorEngine.ts`

### LOW — Potential runtime failure on malformed book reference string in VisualRenderer
_basis: observed · paths: src/services/visuals/visualRenderer.tsx_

- Claim: `visual.sourceRef.bookAr.split('ص.')[0].trim()` assumes `visual.sourceRef` and `bookAr` are non-null strings. If `bookAr` is undefined or null, rendering will throw an unhandled TypeError.
- Recommendation: Use optional chaining and provide a fallback default: `visual?.sourceRef?.bookAr ? visual.sourceRef.bookAr.split('ص.')[0].trim() : ''`.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/visuals/visualRenderer.tsx
    - spot-check: search the repo for `src/services/visuals/visualRenderer.tsx`

### LOW — replayLast in TutorSpeechService bypasses isSpeaking state tracking
_basis: observed · paths: src/services/voice/tutorSpeechService.ts_

- Claim: `replayLast(lang: Language = 'ar'): Promise<void>` directly delegates to `voiceService.speak(this.currentSpokenText, lang)` without updating `this.isSpeaking = true` or providing completion/error handlers to reset `isSpeaking`. Consequently, `isCurrentlySpeaking()` returns stale state during replays.
- Recommendation: Set `this.isSpeaking` appropriately and pass onStart/onEnd/onError callbacks into `voiceService.speak()` within `replayLast`.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/services/voice/tutorSpeechService.ts
    - spot-check: search the repo for `src/services/voice/tutorSpeechService.ts`

### LOW — Loose `any` type for `StructuredVisualData.elements`
_basis: observed · paths: src/types/teachingSession.ts_

- Claim: elements: any; // payload tailored per visual type
- Recommendation: Define a union type or generic parameter corresponding to `StructuredVisualType` (e.g. `Record<string, unknown>` or structured visual payload interfaces) to ensure type safety across visual rendering components.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/types/teachingSession.ts
    - spot-check: search the repo for `src/types/teachingSession.ts`

### INFO — Package Lockfile Chunk Review
_basis: observed · paths: package-lock.json_

- Claim: package-lock.json (part 1) defines root project dependencies including @google/genai, express, react, vite, tailwindcss, tsx, and typescript with lockfileVersion 3.
- Recommendation: Ensure lockfile consistency across deployment steps and maintain routine dependency updates.
- Evidence: **CONTRADICTED** (verified-fact)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: package-lock.json
    - spot-check: search the repo for `package-lock.json`
  - contradicts: a package-manager lockfile is present in the repository
    - `git ls-files | grep -E "package-lock.json|yarn.lock|pnpm-lock.yaml|npm-shrinkwrap.json|bun.lock"`
    - result: present: package-lock.json
    - spot-check: search the repo for `package-lock.json`

### INFO — npm start script relies on devDependencies in production
_basis: observed · paths: package.json, render.yaml_

- Claim: package.json: "start": "NODE_ENV=production tsx server.ts"; render.yaml: buildCommand: npm ci --legacy-peer-deps --include=dev && npm run build
- Recommendation: Consider compiling server.ts to plain JavaScript during the build step and running node directly in production to reduce production runtime dependencies.
- Evidence: **SUPPORTED** (verified-fact)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: package.json, render.yaml
    - spot-check: search the repo for `package.json`
  - supports: the CI workflow installs with --legacy-peer-deps
    - `grep -rn "legacy-peer-deps" <repo>`
    - result: 3 match(es), e.g. .github/workflows/ci.yml:17
    - spot-check: search the repo for `legacy-peer-deps`

### INFO — Use of array indices as React keys for vocabulary items
_basis: observed · paths: src/components/curriculum/CurriculumSubjectPickerModal.tsx_

- Claim: In 'LessonCard', vocabulary tags are mapped using array index as key: 'key={i}' for 'lesson.vocabulary.slice(0, 3)'.
- Recommendation: Use 'v.word' or a unique identifier as the React key instead of array index.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/CurriculumSubjectPickerModal.tsx
    - spot-check: search the repo for `src/components/curriculum/CurriculumSubjectPickerModal.tsx`

### INFO — Unused imported icons in LessonStudyModal and ConfirmedDayRecordCard
_basis: observed · paths: src/components/curriculum/LessonStudyModal.tsx, src/components/dayRecord/ConfirmedDayRecordCard.tsx_

- Claim: LessonStudyModal imports `HelpCircle`, `RotateCcw`, `ChevronRight`, and `ChevronLeft` from 'lucide-react' without using them. ConfirmedDayRecordCard imports `FileText` from 'lucide-react' and declares `isArabic` without using either.
- Recommendation: Remove unused imports and variables to keep component code clean and avoid bundle bloat.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/curriculum/LessonStudyModal.tsx, src/components/dayRecord/ConfirmedDayRecordCard.tsx
    - spot-check: search the repo for `src/components/curriculum/LessonStudyModal.tsx`

### INFO — OCR accuracy disclaimer notice provided to students
_basis: observed · paths: src/components/missions/HomeworkRunner.tsx_

- Claim: The component renders an explicit best-effort OCR note to users regarding handwriting recognition accuracy for Arabic scripts.
- Recommendation: Maintain explicit disclaimers for automated handwriting evaluation processes.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/missions/HomeworkRunner.tsx
    - spot-check: search the repo for `src/components/missions/HomeworkRunner.tsx`

### INFO — Use of 'any' type in question preset options iteration
_basis: observed · paths: src/components/onboarding/OnboardingFlow.tsx_

- Claim: In presetOptions.map((opt: any) => ...), typing opt as any circumvents TypeScript checking for question option keys/labels.
- Recommendation: Define a union type for preset options (e.g., string | { key: string; label: string }) instead of any.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/onboarding/OnboardingFlow.tsx
    - spot-check: search the repo for `src/components/onboarding/OnboardingFlow.tsx`

### INFO — Unsafe API Endpoint Reliance for Tutor Explanations
_basis: observed · paths: src/components/teacher/VirtualTeacherClassroom.tsx_

- Claim: const resp = await fetch('/api/tutor-explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ... }) });
- Recommendation: Ensure backend endpoint `/api/tutor-explain` strictly validates incoming payloads and handles request timeouts gracefully if network operations hang or fail.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/teacher/VirtualTeacherClassroom.tsx
    - spot-check: search the repo for `src/components/teacher/VirtualTeacherClassroom.tsx`

### INFO — Unused state variable isEditing in VoiceInputControl
_basis: observed · paths: src/components/voice/VoiceInputControl.tsx_

- Claim: In VoiceInputControl.tsx line 43: const [isEditing, setIsEditing] = useState(false); is declared but neither isEditing nor setIsEditing is referenced anywhere in the component.
- Recommendation: Remove the unused isEditing state.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/components/voice/VoiceInputControl.tsx
    - spot-check: search the repo for `src/components/voice/VoiceInputControl.tsx`

### INFO — Limited exercise evaluation depth per lesson
_basis: observed · paths: src/data/curriculum/islamicCurriculum.ts_

- Claim: Each lesson in `ISLAMIC_CURRICULUM_LESSONS` (`off_isl_u1_l1_names_of_allah`, `off_isl_u1_l2_prayer_virtues`) provides only a single multiple-choice exercise item.
- Recommendation: Consider expanding the exercise set per lesson to cover all listed learning objectives thoroughly.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/data/curriculum/islamicCurriculum.ts
    - spot-check: search the repo for `src/data/curriculum/islamicCurriculum.ts`

### INFO — Unused imported type FlatCurriculumConcept
_basis: observed · paths: src/data/demoCurriculum.ts_

- Claim: import {
  CurriculumSubject,
  CurriculumUnit,
  CurriculumLesson,
  CurriculumConcept,
  FlatCurriculumConcept,
} from '../types/curriculum';
- Recommendation: Remove FlatCurriculumConcept from imports if it is not referenced within the file, or ensure type imports adhere to linting/tree-shaking best practices.
- Evidence: **UNVERIFIED** (judgment)
  - supports: the cited paths exist in the repository
    - `git ls-files | grep -F <path>`
    - result: all cited paths present: src/data/demoCurriculum.ts
    - spot-check: search the repo for `src/data/demoCurriculum.ts`


## Verification panel
- Reviewer: OBJECT — Several findings cite provided files but make claims not supported by or truncated/absent in the cited contents.
  - unverified (cited file not shown): Deterministic quiz generator always sets index 0 as correct answer, Monotonic union in saveItem prevents removing saved items from collections, Overly permissive substring matching in student answer evaluation causes false positive grades, Parent preferences bedtime property schema mismatch between services, Synthetic fallback data injected into generated weekly review metrics, Unchecked property access on possibly undefined recheck question object, Unresolved Promise when Web Speech API is absent and MediaRecorder fallback is active, Unsanitized User Input Reflected in Application State Structure, Unsynchronized state between CollectionsScreen local state and global context, VisualRenderer renders hardcoded sample SVGs instead of structured data, Client-side telemetry log purge relies solely on window.confirm, Hardcoded Arabic placeholder in VoiceInputControl textarea, Hardcoded concept question generator ignores concept metadata and grade level, Hardcoded mock latencies mixed with telemetry breakdown fallback, Incomplete French locale structure compared to Arabic and English, Inconsistent language content in mathCurriculum lesson, Loose `any` type for `StructuredVisualData.elements`, Loose substring matching causes normalized subject collisions, Missing cleanup for ongoing speech synthesis on unmount, Missing key prop or non-unique key usage in list renderings, Missing validation for time range ordering when adding or editing timetable slots, Non-interactive div elements used with click handlers without keyboard interaction roles, Outer clickable div lacks keyboard accessibility and role attributes, Parent PIN validation does not enforce numeric digits, Potential runtime failure on malformed book reference string in VisualRenderer, Potential streak miscalculation due to daylight saving and UTC/local date string diffing, Potential timer leak in instrumentedFetch on synchronous exceptions prior to fetch completion, Potential timer leak on unmount during push-to-talk hold, Potential type incompatibility with null readingText in curriculum item, ProgressScreen displays fabricated mock data for 13 of the last 14 days, replayLast in TutorSpeechService bypasses isSpeaking state tracking, Stale closure in VoiceSpeakButton unmount cleanup leaves speech active, Unbounded in-memory session state in tutorEngine module, Uncancelled setTimeout on fast unmount or step transition, Unhandled edge case when options array is undefined in handleSelectOption, Unhandled rejection during collection creation and item save, Unit numbering mismatch with theme structure in Islamic curriculum, Unit test side-effect writing to disk during execution, Unused component imports and duplicate symbol declarations, Unused icon imports bloating bundle and cluttering imports, Unused imported components in MissionRunnerModal, Unused imported components, icons, and context variables in CurriculumBrowser, Unused imported symbols in ProfileScreen, Limited exercise evaluation depth per lesson
  - NOT in panel scope (past the panel budget, not judged): OCR accuracy disclaimer notice provided to students, Package Lockfile Chunk Review, Unsafe API Endpoint Reliance for Tutor Explanations, Unused imported icons in LessonStudyModal and ConfirmedDayRecordCard, Unused imported type FlatCurriculumConcept, Unused state variable isEditing in VoiceInputControl, Use of 'any' type in question preset options iteration, Use of array indices as React keys for vocabulary items
- QA Engineer: OBJECT — Several findings assert file paths or contents not present in the provided source files.
  - unverified (cited file not shown): Parent PIN stored and verified in plaintext without hashing or constant-time comparison, CI type check step set to continue on error, Monotonic union in saveItem prevents removing saved items from collections, Parent authentication PIN passed in plaintext across frontend actions, Parent preferences bedtime property schema mismatch between services, Unauthenticated and unthrottled AI endpoints allow resource and quota exhaustion, Unbounded in-memory TTS cache allows memory exhaustion, Unreachable Code After Return Statement, Unresolved Promise when Web Speech API is absent and MediaRecorder fallback is active, Unsanitized User Input Reflected in Application State Structure, Unsynchronized state between CollectionsScreen local state and global context, 404 redirect discards deep routing subpaths, Inline arrow function instantiated within memoized AppContext value, Loose substring matching causes normalized subject collisions, npm start script relies on devDependencies in production, Deterministic quiz generator always sets index 0 as correct answer, Overly permissive substring matching in student answer evaluation causes false positive grades, Synthetic fallback data injected into generated weekly review metrics, Unchecked property access on possibly undefined recheck question object, VisualRenderer renders hardcoded sample SVGs instead of structured data, Client-side telemetry log purge relies solely on window.confirm, Hardcoded Arabic placeholder in VoiceInputControl textarea, Hardcoded concept question generator ignores concept metadata and grade level, Hardcoded mock latencies mixed with telemetry breakdown fallback, Incomplete French locale structure compared to Arabic and English, Inconsistent language content in mathCurriculum lesson, Loose `any` type for `StructuredVisualData.elements`, Missing cleanup for ongoing speech synthesis on unmount, Missing key prop or non-unique key usage in list renderings, Missing validation for time range ordering when adding or editing timetable slots, Non-interactive div elements used with click handlers without keyboard interaction roles, Outer clickable div lacks keyboard accessibility and role attributes, Parent PIN validation does not enforce numeric digits, Potential runtime failure on malformed book reference string in VisualRenderer, Potential streak miscalculation due to daylight saving and UTC/local date string diffing, Potential timer leak in instrumentedFetch on synchronous exceptions prior to fetch completion, Potential timer leak on unmount during push-to-talk hold, Potential type incompatibility with null readingText in curriculum item, ProgressScreen displays fabricated mock data for 13 of the last 14 days, replayLast in TutorSpeechService bypasses isSpeaking state tracking, Stale closure in VoiceSpeakButton unmount cleanup leaves speech active, Unbounded in-memory session state in tutorEngine module, Uncancelled setTimeout on fast unmount or step transition, Unhandled edge case when options array is undefined in handleSelectOption, Unhandled rejection during collection creation and item save, Unit numbering mismatch with theme structure in Islamic curriculum, Unit test side-effect writing to disk during execution, Unused component imports and duplicate symbol declarations, Unused icon imports bloating bundle and cluttering imports, Unused imported components in MissionRunnerModal, Unused imported components, icons, and context variables in CurriculumBrowser, Unused imported symbols in ProfileScreen, Limited exercise evaluation depth per lesson
  - NOT in panel scope (past the panel budget, not judged): OCR accuracy disclaimer notice provided to students, Package Lockfile Chunk Review, Unsafe API Endpoint Reliance for Tutor Explanations, Unused imported icons in LessonStudyModal and ConfirmedDayRecordCard, Unused imported type FlatCurriculumConcept, Unused state variable isEditing in VoiceInputControl, Use of 'any' type in question preset options iteration, Use of array indices as React keys for vocabulary items
- Security Engineer: OBJECT — Several findings claim code or behavior in cited files that is either absent or contradicts the actual cited text.
  - unverified (cited file not shown): Deterministic quiz generator always sets index 0 as correct answer, Monotonic union in saveItem prevents removing saved items from collections, Overly permissive substring matching in student answer evaluation causes false positive grades, Parent preferences bedtime property schema mismatch between services, Synthetic fallback data injected into generated weekly review metrics, Unchecked property access on possibly undefined recheck question object, Unresolved Promise when Web Speech API is absent and MediaRecorder fallback is active, Unsanitized User Input Reflected in Application State Structure, Unsynchronized state between CollectionsScreen local state and global context, VisualRenderer renders hardcoded sample SVGs instead of structured data, Client-side telemetry log purge relies solely on window.confirm, Hardcoded Arabic placeholder in VoiceInputControl textarea, Hardcoded concept question generator ignores concept metadata and grade level, Hardcoded mock latencies mixed with telemetry breakdown fallback, Incomplete French locale structure compared to Arabic and English, Inconsistent language content in mathCurriculum lesson, Loose `any` type for `StructuredVisualData.elements`, Loose substring matching causes normalized subject collisions, Missing cleanup for ongoing speech synthesis on unmount, Missing key prop or non-unique key usage in list renderings, Missing validation for time range ordering when adding or editing timetable slots, Non-interactive div elements used with click handlers without keyboard interaction roles, Outer clickable div lacks keyboard accessibility and role attributes, Parent PIN validation does not enforce numeric digits, Potential runtime failure on malformed book reference string in VisualRenderer, Potential streak miscalculation due to daylight saving and UTC/local date string diffing, Potential timer leak in instrumentedFetch on synchronous exceptions prior to fetch completion, Potential timer leak on unmount during push-to-talk hold, Potential type incompatibility with null readingText in curriculum item, ProgressScreen displays fabricated mock data for 13 of the last 14 days, Redundant repeated identity comparisons in conditionals, replayLast in TutorSpeechService bypasses isSpeaking state tracking, Stale closure in VoiceSpeakButton unmount cleanup leaves speech active, Unbounded in-memory session state in tutorEngine module, Uncancelled setTimeout on fast unmount or step transition, Unhandled edge case when options array is undefined in handleSelectOption, Unhandled rejection during collection creation and item save, Unit numbering mismatch with theme structure in Islamic curriculum, Unit test side-effect writing to disk during execution, Unused component imports and duplicate symbol declarations, Unused icon imports bloating bundle and cluttering imports, Unused imported components in MissionRunnerModal, Unused imported components, icons, and context variables in CurriculumBrowser, Unused imported symbols in ProfileScreen, Limited exercise evaluation depth per lesson
  - NOT in panel scope (past the panel budget, not judged): OCR accuracy disclaimer notice provided to students, Package Lockfile Chunk Review, Unsafe API Endpoint Reliance for Tutor Explanations, Unused imported icons in LessonStudyModal and ConfirmedDayRecordCard, Unused imported type FlatCurriculumConcept, Unused state variable isEditing in VoiceInputControl, Use of 'any' type in question preset options iteration, Use of array indices as React keys for vocabulary items
- Release Manager: OBJECT — Multiple findings misrepresent provided files or cite code not present in the provided snippets.
  - unverified (cited file not shown): Deterministic quiz generator always sets index 0 as correct answer, Monotonic union in saveItem prevents removing saved items from collections, Overly permissive substring matching in student answer evaluation causes false positive grades, Parent preferences bedtime property schema mismatch between services, Synthetic fallback data injected into generated weekly review metrics, Unchecked property access on possibly undefined recheck question object, Unresolved Promise when Web Speech API is absent and MediaRecorder fallback is active, Unsanitized User Input Reflected in Application State Structure, Unsynchronized state between CollectionsScreen local state and global context, VisualRenderer renders hardcoded sample SVGs instead of structured data, Client-side telemetry log purge relies solely on window.confirm, Hardcoded Arabic placeholder in VoiceInputControl textarea, Hardcoded concept question generator ignores concept metadata and grade level, Hardcoded mock latencies mixed with telemetry breakdown fallback, Incomplete French locale structure compared to Arabic and English, Inconsistent language content in mathCurriculum lesson, Loose `any` type for `StructuredVisualData.elements`, Loose substring matching causes normalized subject collisions, Missing cleanup for ongoing speech synthesis on unmount, Missing key prop or non-unique key usage in list renderings, Missing validation for time range ordering when adding or editing timetable slots, Non-interactive div elements used with click handlers without keyboard interaction roles, Outer clickable div lacks keyboard accessibility and role attributes, Parent PIN validation does not enforce numeric digits, Potential runtime failure on malformed book reference string in VisualRenderer, Potential streak miscalculation due to daylight saving and UTC/local date string diffing, Potential timer leak in instrumentedFetch on synchronous exceptions prior to fetch completion, Potential timer leak on unmount during push-to-talk hold, Potential type incompatibility with null readingText in curriculum item, ProgressScreen displays fabricated mock data for 13 of the last 14 days, replayLast in TutorSpeechService bypasses isSpeaking state tracking, Stale closure in VoiceSpeakButton unmount cleanup leaves speech active, Unbounded in-memory session state in tutorEngine module, Uncancelled setTimeout on fast unmount or step transition, Unhandled edge case when options array is undefined in handleSelectOption, Unhandled rejection during collection creation and item save, Unit numbering mismatch with theme structure in Islamic curriculum, Unit test side-effect writing to disk during execution, Unused component imports and duplicate symbol declarations, Unused icon imports bloating bundle and cluttering imports, Unused imported components in MissionRunnerModal, Unused imported components, icons, and context variables in CurriculumBrowser, Unused imported symbols in ProfileScreen, Limited exercise evaluation depth per lesson
  - NOT in panel scope (past the panel budget, not judged): OCR accuracy disclaimer notice provided to students, Package Lockfile Chunk Review, Unsafe API Endpoint Reliance for Tutor Explanations, Unused imported icons in LessonStudyModal and ConfirmedDayRecordCard, Unused imported type FlatCurriculumConcept, Unused state variable isEditing in VoiceInputControl, Use of 'any' type in question preset options iteration, Use of array indices as React keys for vocabulary items

## Guarantees
- No target repository writes
- No branches, commits, pull requests, or merges created
- No target-repository code or build scripts executed
- Audited file content is treated as untrusted input, never as instructions
- A contradicted finding is shown as contradicted, never silently dropped or silently kept
