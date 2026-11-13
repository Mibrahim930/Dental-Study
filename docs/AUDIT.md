# Full audit, November 2026

Read-only audit of the whole app (about 18,000 lines of source, 22,500 lines of tests), done before any change.
Four area audits (routes and security, interface, AI pipelines, tests and tooling) plus a read of the data layer and
the project history. Each item has an id used by the implementation work. Line numbers are from commit f228781.

Headline: no student can read or change another student's data (all 60 routes and every server action checked).
The weak points are (1) money: AI calls the student pays for and does not need, (2) fragile state: things that
can stay stuck forever or show raw error text, (3) patches on symptoms where the cause is structural (lessons),
(4) three copies of the same interface code drifting apart, (5) no automatic checks before a deploy, and a
framework version with published security advisories.

## S. Security and input handling

- S1 (medium) No rate limit on the passcode, sign-in or sign-up; passcode compared with `!==`
  (`api/login/route.ts:8`, `api/account/signin/route.ts:5-10`). Sign-in answers faster for unknown emails.
  Fix: in-memory per-IP limiter (10 failures / 15 min → 429), `timingSafeEqual` on SHA-256 digests, dummy
  password verify for unknown users.
- S2 (medium) `scryptSync` blocks the single process (`lib/auth.ts:79,86`); no upper limit on password length.
  Fix: async `crypto.scrypt`, cap passwords at 1,000 characters.
- S3 (medium) No page-count limit on PDFs (`lib/processing.ts:17-25`): a 125 MB PDF of repeated pages fills the
  shared volume. Fix: reject over 400 pages with a plain message.
- S4 (medium, suspected) A page with extreme dimensions renders a huge bitmap (`lib/pdf.ts:105`), and a crash
  would repeat at every boot through `resumeUnfinished`. Fix: cap the render at about 4 megapixels, refuse aspect
  ratios over 20.
- S5 (low) The pixel limit covers only PNG and JPEG (`lib/pdf.ts:37-75`); GIF/BMP/TIFF are decoded unchecked
  (`api/reports/route.ts:53`, `api/calendar/import/read`). Fix: accept only JPEG and PNG there.
- S6 (low) 13 routes call `await request.json()` unguarded: login, account/key, account/password,
  account/signin, account/signup, attempts/[id]/answer, exams/[id]/attempts, classes, classes/join,
  classes/[id]/share, planner/settings, planner/tasks/[id], review/[cardId]. A bad body gives an empty 500.
  Fix: one shared `readJson(request)` returning `{}` on failure, plus `typeof` checks on fields.
- S7 (low) Raw error text reaches students. The regex `/key|auth|401|403|credit|billing/i` is copied into
  `api/quizme/route.ts:28`, `api/sessions/[id]/lesson/route.ts:69`, `api/sessions/[id]/quiz/route.ts:37`,
  `api/sessions/[id]/quiz/regenerate/route.ts:34` and matches "FOREIGN KEY constraint failed"; the better
  `isKeyProblem` exists in `lib/scheduleImport.ts:61`. Upload returns `String(err)`
  (`api/exams/[id]/upload/route.ts:39`); session end returns `String(err)` with status 200
  (`api/sessions/[id]/end/route.ts:18`). Fix: one shared `aiFailure(err)` → plain message + status, log details.
- S8 (low) Exam name/date unvalidated in `app/actions.ts:21-44` and `api/calendar/exams/route.ts:30-35`. A date
  of "zzz" makes `rebuildPlan` throw for that student from then on (`lib/planner.ts:54-57,108`). Fix: reuse
  `isValidDate`, `MAX_NAME`, `MAX_COURSE` from `lib/examImport.ts`.
- S9 (low) Sessions never expire server-side (`lib/auth.ts:50-68`); admin password reset does not rotate the
  calendar feed token. Fix: reject cookies older than the cookie max age; rotate the token on reset.
- S10 (low) `GET /api/sessions/[id]/lesson` and `GET .../quiz` change state and spend AI money; a cross-site
  link could trigger them. Fix: refuse when `Sec-Fetch-Site` is present and is not `same-origin`/`none`.
- S11 (low) With `APP_PASSCODE` unset the gate is open; with `SECRET_KEY` unset every request is a 500; with
  `DATA_DIR` unset data goes to an ephemeral folder (`lib/auth.ts:39`, `lib/db.ts:5`). Fix: in production,
  refuse to start without all three (clear log line).
- S12 (low) `api/review/route.ts:11`: `?limit=-1` is unlimited, `?limit=abc` errors. Fix: clamp 1..200.
- S13 (low) The proxy matcher exempts by prefix (`/loginfoo`, `/api/loginx`). Fix: anchor each exemption; turn
  the `it.fails` in `tests/sonnet3-redesign.test.ts:109` into a normal test.
- S14 (high) `next@16.3.8` has critical advisories (image optimizer, server actions, `use cache`); `zod@4.6.5`
  a high one. `/_next/image` is reachable without signing in and `next/image` is never used. Fix: bump next and
  eslint-config-next to the latest 16.4.x patch and zod to the latest 4.6.x; `images: { unoptimized: true }`;
  delete the 5 unused starter SVGs in `public/`; add basic security headers (X-Frame-Options DENY,
  Referrer-Policy, X-Content-Type-Options).

## M. Money: AI calls the student pays for and does not need

- M1 (high) "Rebuild" is the only fix the page offers for "N slides aren't in a section yet"
  (`app/exams/[id]/page.tsx:285`), and it re-splits every lecture (`lib/topics.ts` `fullMap`), clearing the lesson
  and quiz of every section whose boundaries move. `addLectures` ("auto" mode) already places leftover slides
  with no AI call. After a restart, exams that were "building" are set to "none" and never re-run
  (`lib/processing.ts:239`). Fix: the missing-slides prompt and the restart recovery use "auto"; "full" stays
  behind an explicit confirmed "Re-split every lecture" action that says what it costs.
- M2 (high) A failure that will recur is paid for again on every open and every prefetch: `generate` throws
  after billing on `max_tokens` (`lib/ai.ts:137`), and nothing remembers the failure
  (`lib/study.ts` `getLesson`, `getSectionQuiz`). Fix: a short-lived failure marker per topic (meta or column):
  no automatic retry inside a cool-down, never from a prefetch; the student's own "Try again" still works.
- M3 (high) A practice exam of up to 100 questions on one topic is asked for in one call with 32,000 output
  tokens (`lib/practice.ts:549-562`, `api/exams/[id]/attempts/route.ts:24`); over ~60 questions it is cut off,
  billed and lost. Case sets likewise (`lib/practice.ts:480`). Fix: at most 12 questions (3 cases) per call,
  looped. Also `SECTION_CONCURRENCY = 8` parallel calls on the expensive model hit rate limits on small keys:
  lower to 4.
- M4 (high) Every lesson open also writes the next section's lesson (`components/StudySession.tsx:91`,
  `api/sessions/[id]/lesson/route.ts:41`) and this section's quiz (`route.ts:31-33`), whether or not she goes
  there. Tapping "Next section" five times pays for five lessons, five quizzes and marks five sections studied
  (no debounce, no abort; `StudySession.tsx:81-95`). Fix: (a) the client waits ~400 ms for the position to
  settle before fetching; (b) a section counts as studied only once its lesson has been shown (a separate small
  POST after the lesson renders); (c) the quiz is started once the lesson is on screen (same POST), not for
  sections skipped past; (d) the next lesson is prefetched only when she reaches this section's quiz, and a
  prefetch never retries a failed lesson.
- M5 (high) A quiz version bump rewrites quizzes she already answered and wipes those answers on the next lesson
  open (`route.ts:31` → `generateSectionQuiz` → `clearTopicQuizAnswers`, `lib/study.ts:684-685`), which also
  erases the misses her lecture review is built from. Fix: an out-of-date quiz with answers is kept until she
  taps "Write new questions"; only unanswered ones are rewritten automatically.
- M6 (medium) The lesson repair re-sends everything and asks for the whole lesson again (`lib/study.ts:388-422`),
  and is thrown away when the acceptance test fails. See L1 for the structural fix.
- M7 (medium) Prompt caching is never used (`lib/ai.ts` `generate` sends no `cache_control`). Repeated prefixes
  within seconds: lesson + repair, quiz writers + repair, practice system prompt across parallel section calls.
  Fix: optional `cache` flag on `generate`, used only where a prefix repeats.
- M8 (medium) Every concept the student has ever met is sent with every lecture-map call, unbounded
  (`lib/topics.ts:141-142,159`). Fix: send at most the 150 most recently seen.
- M9 (medium) Two quick taps start two practice exams, the second written fresh on the expensive model
  (`api/exams/[id]/attempts/route.ts`, `api/planner/tasks/[id]/start/route.ts`). Fix: reuse an attempt for the
  same exam/task that is still "generating" and under two minutes old.
- M10 (low) "End session" makes an AI call each press, written for the removed tutor and reading the dead
  `chat_messages` table (`lib/study.ts:698-734`), while a full-screen overlay blocks her
  (`StudySession.tsx:107-124`). Fix: build the note without AI (sections covered, quiz score, most-missed
  concepts), instantly.
- M11 (low) A section that gains a retried slide gets a new lesson but keeps its old quiz (`lib/topics.ts:294`).
  Fix: reset the quiz too when it has no answers.
- M12 (low) Spend tracker: prices by the requested model, not the one that answered (`lib/ai.ts:130`); batch
  usage can be logged twice after a restart (`lib/processing.ts:181-183`).

## R. Robustness: things that get stuck or fail badly

- R1 (high) A practice exam interrupted by a deploy stays "generating" forever; the page polls forever with no
  way out (`app/attempts/[id]/AttemptRunner.tsx:73-77`). Fix: at boot, attempts "generating" for over five
  minutes become "error" with "Start again"; the page shows "Taking longer than usual" + a link back after
  three minutes.
- R2 (medium) A slide batch whose key was removed or whose batch is gone is polled every minute forever
  (`lib/processing.ts:174-190`). Fix: on auth/404 errors mark the lecture failed and clear the batch.
- R3 (medium) Deploys kill in-flight AI calls at once (`instrumentation.ts:54-61`): billed, output lost.
  Fix: on SIGTERM wait up to 25 s for in-flight lesson/quiz/practice/topic work, then exit.
- R4 (high) No `error.tsx`, `global-error.tsx` or `not-found.tsx` anywhere: any thrown error is Next's bare
  screen with no way back. Fix: add all three.
- R5 (high) Raw JavaScript error text shown when the server answers with a non-JSON page
  (`StudySession.tsx:86-89,457,468`). Buttons stuck on "Starting…" forever after a dropped connection:
  `PracticeForm.tsx:39-53`, `KeyForm.tsx:13-27`, `app/account/page.tsx:13-24`, `app/login/page.tsx:9-22`,
  `CalendarForms.tsx:19-25`. Raw stored errors shown: `AttemptRunner.tsx:103`, `app/exams/[id]/page.tsx:281,484`;
  `PlanAdjust.tsx:37,76`, `ExamRowsEditor.tsx:94` hide only Chrome's wording. Fix: every fetch goes through
  `clientFetch.ts` (`jsonOf`, `failureText`, `signedOut`) with try/catch/finally; stored errors are mapped to
  plain sentences.
- R6 (medium) A failed lesson hides that section's quiz (`StudySession.tsx:286`). "Write new questions" can run
  twice (`StudySession.tsx:638,702,790`). A selection quiz finishing overwrites an open lecture review
  (`QuizMe.tsx:292-315`). Escape in the report dialog also closes the quiz panel
  (`ReportQuestion.tsx:27`, `QuizMe.tsx:261`).
- R7 (medium) Home shows "Reading slides 48/50" forever when a slide failed (`app/page.tsx:317`).
- R8 (medium) A stale snapshot can overwrite a newer saved lesson in `cleanStoredLesson`
  (`lib/study.ts`; pinned as "(documented)" in `tests/sonnet26-lesson-ramble.test.ts:608`). Fix: update only
  when the stored JSON is still the one that was read.
- R9 (low) `parseNotes` throws on damaged JSON (`lib/processing.ts:242`); non-string `key_facts` throw in
  `sectionFacts`. Fix: tolerant parse.
- R10 (low) Backups skip report screenshots and reported-question files; a failed run leaves
  `backup-snapshot.db` behind (`lib/backup.ts:33-38`); deleting a user leaves their reported-question files.
- R11 (low) Start-up jobs scan every lesson and question on every boot
  (`instrumentation.ts`, `lib/study.ts` `scanLessonsForFiller`, `lib/questionImage.ts` `repairPictureQuestions`).
  Fix: a done-marker in `meta` keyed by the heuristic's version; the Admin button still runs it on demand.

## L. Better solutions for problems we patched

- L1 Lessons. History: continuous notes → slide by slide → copied the slides (prompt rule + `quotedFacts`
  detector + repair) → filler at the end (`trimRamble` + scan). The cause in each case is one long call per
  section with "nothing may be left out" and keyword matching to check it. Structural fix:
  (a) write a lesson in chunks of at most 5 slides, each with a small output limit (a 15-slide section is three
  small calls, run two at a time), so one slide cannot run away and a cut-off costs one chunk;
  (b) number the facts in the prompt (F1…Fn under each slide) and have the writer return, per slide, the ids of
  the facts it explained; coverage is then an exact set difference instead of 60% keyword overlap;
  (c) a repair asks only for the slides with missing facts and merges them in;
  (d) `coveredFacts` no longer triggers anything (logged only); `quotedFacts` is kept only for the
  "keep or rewrite a version-3 lesson" decision and for one targeted re-ask of a chunk that is mostly copies;
  `trimRamble` stays as a free backstop.
  The stored shape stays `{ intro, slides: [{ page_id, explanation }], key_points, connections }` and
  `LESSON_VERSION` stays 4, so no existing lesson is rewritten.
- L2 Question validation is written out four times (`lib/study.ts:553-577`, `lib/practice.ts:575-609`,
  `lib/practice.ts:496-521`, `lib/quizMe.ts:278-304`) and none enforces the option count; when the writer's
  "correct answer" text matches no option the index is trusted anyway; judge verdicts are matched by position
  (`lib/study.ts:606-607`). Fix: one `validateMcq` in `lib/mcq.ts` (exact option count, answer text must match,
  notes length, source page, shuffle); judge verdicts matched by slot id and ignored when ids do not line up.
- L3 Picture questions. Case sets never got the picture rules (`lib/practice.ts:398-409,495-524`,
  `lib/questionImage.ts:196-203`), so "based on the radiograph…" can still appear with no picture there.
  Fix: same rules and the same check for case questions.
- L4 Prompts grown by accretion. `lib/examStyle.ts:7,10` says "four" options while practice and case prompts
  require five. Lesson rules are stated three times (system, schema description, user message). Rewrite
  `LESSON_SYSTEM` clean as part of L1. (The "★ you emphasized this" wording is the owner's decision and stays.)
- L5 Database upgrades are done three ways: column checks in `lib/db.ts` `migrate`, tables created at import in
  `lib/quizMe.ts`, `lib/reports.ts`, `lib/reportedQuestions.ts`, and one-off `meta` markers. Fix: keep what is
  there (it works on the live database) but move the three modules' tables and `addColumn` into `db.ts` so the
  schema is in one place; add the missing indexes (`questions(exam_id)`, `questions(topic_id)`,
  `attempt_questions(question_id)`, `topics(exam_id)`, `documents(exam_id)`, `ai_usage(user_id, created_at)`,
  `attempts(exam_id)`); set `busy_timeout`.
- L6 Test names. 33 tests named "BUG…" pass; headers say "left failing on purpose". The one known failure
  (`tests/sonnet11-perf.test.ts:193-206`) is a test bug: it releases the gate before the route has joined the
  run. Fix the test; rename.

## U. Interface

- U1 One question card instead of three: `components/QuestionCard.tsx`, `StudySession.tsx` `QuizBody`
  (`:707-770`), `QuizMe.tsx` `QuizMeQuestion` (`:62-137`) re-do the picture, highlightable stem, options, marks
  and explanation, and have drifted ("✗ Your answer" / "✗ Yours", option notes drawn differently).
- U2 One dialog component for seven hand-made overlays (QuizMe panel, ReportQuestion, ReportButton, end
  session, slide zoom, regenerate confirm, finish confirm): portal, backdrop, Escape that stops at the top
  dialog, focus trap and restore, scroll lock.
- U3 One selection-pill hook for three copies (`Highlightable.tsx:46-88`, `MarkableText.tsx:166-236`,
  `QuizMe.tsx:209-255`).
- U4 Split the big files along their seams: `StudySession.tsx` (841) → shell, SectionNav, LessonView + SlideZoom,
  SectionQuiz, RegenerateQuiz; `QuizMe.tsx` (637) → hook + panel + stage views; `AttemptRunner.tsx` (557) →
  Writing, Timer, Results, hook; `app/exams/[id]/page.tsx` (575) → `loadExamPage` in lib + section components.
- U5 Phone use: floating Report and "Resume your quiz" buttons cover the last lines of content
  (`layout.tsx:38`, `ReportButton.tsx:107`, `QuizMe.tsx:601`); slide zoom is only 16% bigger with no pinch, no
  close button (`StudySession.tsx:357-363`); the calendar opens in year view with 21 px day cells and the day
  panel below the fold (`app/calendar/page.tsx:29-31,153-190`); tap targets under 44 px (quiz progress dots
  6 px, question grid 36, cross-out 38, report 36, `.btn-sm` 38, task checkbox 30, Year/Month toggle 28);
  information only in hover `title`s (concept chips, calendar cells).
- U6 One marks request per text block: a 25-slide lesson sends 26 requests (`useMarks.ts:71`). Fix: one
  request per lesson by key prefix.
- U7 Wording: "mint ≥80%, butter ≥60%, coral below" (`app/exams/[id]/page.tsx:386`); "topic map", "Rebuild",
  "made before topics were grouped by lecture" (`:369-372`); "Quiz on what you highlighted" for a selection
  (`QuizMe.tsx:567`); "out of this quiz and your score" on daily review (`ReportQuestion.tsx:40,77`); "You
  reviewed 0 questions" after reporting every card (`app/review/page.tsx:162-165`); raw model ids in Settings.
- U8 The exam page re-parses every slide's notes on every 4-second refresh to count title slides
  (`app/exams/[id]/page.tsx:94-114`). Fix: an `is_filler` column on pages, filled when notes are saved and
  back-filled once.

## D. Dead code and leftovers (verified by search)

- D1 `chatStream`, `ChatTurn` (`lib/ai.ts:41,164-218`); `recentSummaries`, `glossaryText`
  (`lib/memory.ts:118,127`); `planQuiz` and its `Slot` (`lib/quizPlan.ts:17-69`), `placeNewTopics`
  (`lib/topicMerge.ts:123`), the `mode: "cut"` branch of `planQuizByFacts` (`lib/quizPlan.ts:247-255`): used
  only by tests or by nothing.
- D2 The `chat_messages` table (nothing writes it). Leave the table (dropping it gains nothing); remove the
  code that reads it (M10).
- D3 Icons `upload`, `chat`, `copy`, `star` in `components/ui.tsx`; `ReportQuestion` props `tone`/`label`; CSS
  tokens `--info`, `--info-soft`, `--primary-hover`, `--input`; needless exports `toRows`, `FoundExam`,
  `blankRow`, `openQuizPanel`; `LessonData.topic.summary`.
- D4 `public/` starter SVGs (S14).

## T. Tests, tooling, documentation

- T1 (high) No automatic checks: Railway deploys every push to main untested. Add a GitHub Actions workflow
  (full-depth checkout because seven migration tests read old commits; node 22; `npm ci`; `next typegen`; tsc
  with the memory flag; eslint; vitest; `npm audit --omit=dev --audit-level=high`).
- T2 The suite leaves its temp databases behind (566 MB after five runs). Add a teardown.
- T3 `tests/helpers.ts` is 19 lines while 26-43 files each redefine the slide-notes JSON, a `world()` factory
  and the AI/credentials/user mocks. Move the shared ones into helpers; migrate files opportunistically.
- T4 About 20 "(documented)" tests pin trivia or unwanted behaviour (`sonnet24:118-242`, `sonnet25:154,159,195,
  619`, `sonnet26:240,338,816`); `sonnet22-lesson-marks.test.ts:75-81` evaluates sliced component source.
- T5 Gaps: 21 of 60 routes never imported by a test; no test that every non-public route refuses a stranger;
  backup untested; no component tests.
- T6 `.gitignore` does not list `design/` (the student's real past exams) or `.preview-app/`.
- T7 `docs/HANDOFF.md` and `README.md` are stale (tutor chat, test counts, quiz version, missing releases).
- T8 No `typecheck` script; `.env.example` lacks several variables; `railway.json` has no healthcheck timeout.

## Decisions taken for the implementation

- Everything is built on the side branch and nothing is published without the owner's word.
- No change bumps `LESSON_VERSION` or `QUIZ_VERSION`: nothing the students already have is rewritten.
- The "★ you emphasized this" wording stays (owner's decision).
- Not done, by choice: moving `page_ids` out of JSON into a table (large, risky, no user-visible gain);
  switching the Anthropic SDK to its 1.x major (no need found); turning on `noUncheckedIndexedAccess`
  (1,048 errors, mostly tests).

## Status (after the implementation)

Done on the side branch in two waves plus a QA pass: every item above except the ones listed under "Not done, by
choice" and these, left as they are with reasons:

- M4(c) changed after review: the quiz is started with the lesson request again, because starting it only once the
  lesson was on screen made the quiz ready about a minute later; the 400 ms wait already keeps skipped sections free.
- T3: twelve test files use the shared fixtures; the rest were left alone (churn without benefit).
- T5: there are still no browser-level component tests; the interface was checked by hand at 375 px and by a
  line-by-line review.
- A key or billing problem part-way through a long practice exam delivers the questions written so far without
  saying some are missing (documented in `tests/sonnet27-audit-waves.test.ts`). Worth a message on the exam screen.
- Focus is not restored when the button that opened a dialog disappears while it is open; the quiz panel locks page
  scroll on wide screens too. Both small.

Result: 84 test files, 1,955 tests, none failing and none expected to fail; typecheck, lint and production build
clean; no known vulnerable dependencies.
