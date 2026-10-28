# Lolo's Dental Buddy — project handoff

Written 2026-10-27 for whoever takes the project over (a Claude session or a person). It is tracked in the repo on purpose:
the older notes live in a `design/` folder that exists only on the owner's PC and is excluded from git (it holds the
student's real past exam PDFs). Everything a new session needs is here; the PC-only material is listed in §12 so you know
what you are not seeing.

---

## 1. What the project is, and the goal

**Lolo's Dental Buddy** (repo name `Dental-Study`) is a multi-user study website for dental students, built by the owner
(not a programmer) for a dental student, "Lolo", and her classmates, who give feedback. It was called "Lolo's Study Buddy"
until 2026-10-25.

The goal: a student uploads her professor's lecture PDFs and the site turns them into a complete, trustworthy way to learn
and be tested on exactly that material, on her phone, before each exam:

- **Lectures become study sections.** Every slide (including radiographs, diagrams and handwriting) is read by an AI on the
  student's own key; each lecture is split into sections in slide order; every content slide ends up in exactly one section.
- **Guided study.** Each section has a lesson that covers every slide in plain language, the key slides as pictures,
  key points (what the professor stressed first), a tutor chat that only answers from her lectures, and a section quiz.
- **Questions she can trust.** Section quizzes and practice exams are written strictly from the slides, in the style of
  her real past exams, checked by a second AI pass, never repeat a fact, and show why every option is right or wrong.
  Missed questions come back (next exam, daily spaced review); mastery per concept is tracked.
- **Practice exams** in tutor or timed mode: recall, clinical cases, picture questions and board-style case sets; she rates
  her confidence before the answer shows.
- **A calendar and planner** that paces the work day by day across all her exams, with busy days, schedule import, and
  "re-plan from today".
- **Nothing lost, nothing confusing on a phone.** Progress is kept across sessions and devices; every failure shows a plain
  message; everything works at 375 px.
- **Classes**: classmates share an exam (topic map, lessons, quizzes, questions) at no AI cost.

The owner's standing priorities, in their words over time: question quality is "the most important part of this website";
be cost-conscious with AI calls (every call is billed to the student's own API key); plain language for the owner, with
click-by-click steps for anything they must do; a plan before big work; every change QA-tested before it goes live; ask
before publishing.

---

## 2. Where it runs

| Thing | Value |
|---|---|
| Live site | https://dental-study-production.up.railway.app |
| Hosting | Railway, project "truthful-education", service "Dental-Study"; a persistent volume mounted at `/data` |
| GitHub | `Mibrahim930/Dental-Study`, branch `main`. **Every push to `main` auto-deploys (~3–4 min).** |
| Real data | **Only** on the Railway volume: `/data/study.db` (SQLite) and `/data/files/` (slide images, PDFs, report screenshots). Nothing on any PC, nothing in git. The owner wants it that way. |
| Owner's PC | `C:\Users\ibrah\Dental-Study` (Windows 11, Git Bash + PowerShell). Also worked on from a Mac before 2026-10-04. |
| Admin account | The first account created on the site is the admin (the owner). |

**Deploy verification.** An HTTP 200 from the site only proves the *old* build is still up. Railway posts each commit's
deploy result to GitHub; check it after every push:

```bash
gh api repos/Mibrahim930/Dental-Study/deployments?per_page=3 --jq '.[] | "\(.id) \(.sha[0:7]) \(.created_at)"'
gh api repos/Mibrahim930/Dental-Study/deployments/<id>/statuses --jq '.[0].state'   # success | failure | in_progress
```

On 2026-10-25 a Railway build failed on its side (the code built fine locally); an empty commit re-triggered it. The Railway
CLI is not installed on the owner's PC; the dashboard link is in the deployment status's `log_url`.

**Environment variables (names only; values live in Railway):**

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Signs cookies and encrypts every student's API key. **Must never change** or every stored key becomes unreadable. |
| `APP_PASSCODE` | Site passcode (the "gate" before accounts). The owner was advised to change it (an old one was once posted in chat). |
| `DATA_DIR` | Data folder (`/data` on Railway; defaults to `./data`, an empty local DB). |
| `CLAUDE_MODEL`, `OPENAI_MODEL` | Standard-tier models (defaults `claude-sonnet-5-5`, `gpt-6.1-sol`). |
| `CLAUDE_QUALITY_MODEL`, `OPENAI_QUALITY_MODEL` | Question-writer models (defaults `claude-opus-5-5`; OpenAI falls back to the standard model). |
| `QUIZ_JUDGE` | `0` turns off the second-pass question checker (tests only). |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | Nightly backup of the DB + PDFs to a Railway bucket (restore script in `scripts/`). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Used only by local scripts; the site itself uses each student's own key. |

Railway limits that bit us: requests must answer within ~15 min, upload bodies within 5 min, 32 KB headers; the edge drops
requests that stay silent. Hence background slide rendering and the 125 MB upload cap.

---

## 3. How the owner works — the standing rules

1. **Never push without the owner saying "publish".** Commit locally, run the checks, then ask. The owner publishes in
   batches and sometimes holds a batch for a day.
2. **Every change gets a QA pass by a Sonnet subagent before publishing**: attack tests in `tests/sonnet*-*.test.ts`
   (failing tests named `BUG: …` for real bugs), a browser click-through at 375 px and desktop with a throwaway database.
   Then the lead reads every diff, fixes what's needed, and asks to publish. The owner asked for this on 2026-10-08 and it
   has caught real bugs every single time (see §7).
3. **Working pattern the owner asked for (2026-10-25):** the lead (you) does the main work; Opus support agents build
   pieces on *disjoint files*; nobody edits a file someone else is in; verify agents' work in an isolated git worktree
   (`git worktree add <scratch> <commit>` + a junction to `node_modules`) so in-flight edits don't mix.
4. **Plain language** for the owner, click-by-click for anything they must do in Railway, GitHub or the site; present a
   plan before large work and ask the questions you have ("Don't assume anything that you don't fully understand").
5. **Cost-conscious.** Every AI call costs the student. Prefer one call to two; never add calls that run on prefetch or on
   topics she may never open without the owner's OK.
6. **Local testing only with a throwaway `DATA_DIR`** (never `./data`, never port 3000, which is the owner's own dev
   server). Build with a temp `DATA_DIR` too, since `next build` opens the database.
7. **Next.js 16 differs from training data.** `AGENTS.md`/`CLAUDE.md` say: read `node_modules/next/dist/docs/` before
   touching routes or pages. New route files need `npx next typegen` before `tsc` knows their `RouteContext` type.
8. **The owner works in other Claude sessions too**, which sometimes push to side branches (`claude/…`). Start every
   session with `git fetch` and check for branches ahead of `origin/main`; review before merging; ask before deleting.
9. The owner's PC has an ECC "GateGuard" hook that blocks the first shell command and the first edit of each file until
   facts are stated (callers, affected functions, data shapes, the user's instruction). State them and retry. Long Bash
   heredocs and backticks inside double quotes have bitten us on Windows; prefer the Read/Edit/Write tools, PowerShell for
   `robocopy`.

---

## 4. Stack and conventions

- Next.js 16 (App Router, Turbopack, `proxy.ts` instead of middleware), React 19, TypeScript, Tailwind v4 with CSS tokens
  in `src/app/globals.css` (four colour themes incl. dark mode, chosen per user), `better-sqlite3`, MuPDF (`mupdf` npm)
  for PDF rendering and image re-encoding, Zod schemas for every AI output, Vitest.
- Database: `src/lib/db.ts` holds `SCHEMA` (CREATE TABLE IF NOT EXISTS …) and `migrate()` (ALTER TABLE … for columns
  added later). New columns go in both. Two feature modules create their own tables at import time instead
  (`lib/reports.ts`, `lib/quizMe.ts`); `quiz_answers` is in SCHEMA. Foreign keys are on; deletes cascade.
- AI: `src/lib/ai.ts` — `generate()` (structured output, Zod), `chatStream()`, batch reading of slides, `mapLimit`.
  `generate({ tier: "quality" })` picks the Opus model for question writers; everything else is "standard". Every call
  is logged to `ai_usage` with the real model and an estimated cost (Settings → Spending; Admin shows per user).
- Tests: `npx vitest run` — 59 files, **1061 passed + 1 expected fail** at d5eb67e (`tests/sonnet5-coverage` has one
  deliberate `it.fails`). Each test file gets its own throwaway DB (vitest.config.ts). AI is always mocked. Patterns:
  `tests/helpers.ts` (`makeUser`, `makeExam`), `vi.hoisted` cookie jar for routes (`tests/perf2-sessions.test.ts`),
  mocked `generate` answering the `Q<n>:` slots it is asked for (`tests/jobB-quiz.test.ts`).
- Checks before any commit: `npx tsc --noEmit -p .`, `npx eslint src tests` (enforces `react-hooks/set-state-in-effect`
  and `react-hooks/purity`: no setState directly in an effect body, no `Date.now()` in render), `npx vitest run`, and
  `DATA_DIR=<temp> npx next build` before publishing.
- Conventions you'll see everywhere: plain-language messages to students (never raw errors; key/billing problems are
  named), `components/clientFetch.ts` for every client fetch (only server-written text is shown; any 401 sends the
  student to sign in), `toast()` from `components/Toaster.tsx`, 44 px touch targets, no sideways scroll at 375 px,
  `aria-*` on custom controls.

---

## 5. Code map

**Data and AI**
- `src/lib/db.ts` — schema, migrations, `resetSectionQuiz`, types. `src/lib/auth.ts` — passcode gate, signed session
  cookies (`id.issuedAt.epoch.sig`; a password change bumps `users.session_epoch` and signs other devices out), scrypt
  passwords, AES-GCM key encryption. `src/lib/user.ts` — `currentUser`/`requireUser`/`apiUser`/`apiAdmin`,
  `revokeSessions`. `src/proxy.ts` — edge gate (signature only; the DB epoch check happens in `currentUser`).
- `src/lib/processing.ts`, `pdf.ts`, `notes.ts` — upload, background page rendering (resumable), batch slide reading
  (`notes_json` per page: title, summary, key_facts, emphasis, case prompt, image description/crop box), lecture removal.
  `pdf.ts` also sniffs file types, re-encodes photos to JPEG and refuses pictures over 40 megapixels before decoding.
- `src/lib/topics.ts` + `topicMerge.ts` + `lectures.ts` — the topic map **by lecture** (one AI call per lecture, sections in
  slide order, `topics.document_id`, at most `MAX_SECTIONS` = 10 per lecture: the prompt says so and `capSections`
  joins the smallest neighbouring pairs if the AI over-splits anyway), "auto" after an upload maps only new lectures,
  "full" (Rebuild) keeps matching topic ids, `rebuildLectureMaps` one-time start-up upgrade (retried up to 3 starts),
  `refileQuestions`. Lectures mapped before the cap keep their sections until Rebuild is pressed on that exam.
- `src/lib/study.ts` — lessons (`LESSON_VERSION` 3 stored inside `lesson_json`: `{ intro, slides: [{ page_id,
  explanation }], key_points, connections }`, written and shown slide by slide in plain words; a slide with facts that
  gets no entry triggers one repair call; coverage helpers in `lessonCoverage.ts`), section quizzes (`QUIZ_VERSION` 3: one question per distinct fact,
  5–25, planned by `quizPlan.ts`'s `planQuizByFacts`; two writer calls, checker pass, one repair; `option_notes`), tutor
  prompt, session summary. `examStyle.ts` — how her real exams are written (distilled from 10 past papers) + the checker
  rules. `questionImage.ts` — which questions need a picture (`mentionsPicture` strict/generous), which slide to show,
  start-up repair of stored questions.
- `src/lib/practice.ts` + `practicePlan.ts` + `attemptView.ts` — practice exams: coverage across sections, no repeats
  (`unusedQuestions`/`inOpenExams`), retries of missed questions with shuffled options, case sets, confidence, scoring,
  the view the runner renders (hides answers in timed mode until finished; carries `option_notes` and the source slide).
- `src/lib/memory.ts` + `readiness.ts` — concepts and mastery, spaced review cards, FTS search over slides, batched
  readiness per exam and per lecture. `src/lib/quizProgress.ts` — per-student section-quiz answers (`quiz_answers`),
  retake, one-time migration from `session_checks`. `src/lib/quizMe.ts` — "Quiz me on this". `src/lib/reports.ts` —
  bug reports + screenshots. `src/lib/marks.ts` + `components/useMarks.ts` — highlights and cross-outs synced to the
  account (`question_marks`).
- `src/lib/planner.ts`, `busy.ts`, `calendar.ts`, `ics.ts`, `icsImport.ts`, `scheduleImport.ts`, `examImport.ts` — the
  day-by-day plan (learn tasks per section, practice after every few, weak-topic review, timed exam the day before),
  busy days (weekly repeats, skips), per-day hours, re-plan, the ICS feed, `.ics` import, AI schedule import.
- `src/lib/classes.ts` — invite codes, `copyExam` (documents, pages, topics with `document_id`, lessons, quizzes, question
  bank incl. `option_notes`; shared image folders), class-wide question reports. `src/lib/backup.ts` — nightly backups.
- `src/instrumentation.ts` — start-up jobs: resume unfinished renders, drop foreign questions from open exams, picture
  repair, `migrateSessionChecks`, `rebuildLectureMaps`, batch polling, backups.

**Pages and components**
- Home `src/app/page.tsx` (plan for today, missed-task note, exam cards with "x of y lectures done" and in-progress
  practice exams, weakest concepts, new exam). Exam page `src/app/exams/[id]/page.tsx` (hero with readiness ring,
  study card "Lecture 2 · Section 3 of 6", one **Lectures** card with upload/Rebuild/status and `<details>` per lecture,
  Practice card with the Continue-your-exam card, past attempts "63% · 5/8"). Study `src/app/exams/[id]/study/page.tsx`
  → `components/StudySession.tsx` (lecture-grouped section list, lesson, pictures, "Your professor stressed this", key
  points, `SectionQuiz` with Retake/Write new questions/report, `TutorChat`, `QuizMe`). Practice
  `src/app/attempts/[id]/AttemptRunner.tsx` (questions, confidence, results with `DoubleRing`, by-topic, every question,
  "Study my misses", `QuizMe` on results). Daily review `src/app/review/page.tsx`. Calendar `src/app/calendar/*`
  (`CalendarForms`, `ExamRowsEditor`, `ImportSchedule`, `UndatedExams`, `PlanAdjust`). Classes, Progress, Settings
  (spend, provider/key, themes, password), Admin (`src/app/admin/page.tsx`: users, spend, reset/remove, **Reports**,
  backups), Help (`/help/api-keys`), Setup (`/setup`), sign-in flow (`/login` passcode, `/account`).
- Shared: `components/ui.tsx` (Icon/ICONS, MasteryChip, Strip, DoubleRing, option states), `OptionRow.tsx` (select,
  cross out, highlight, per-option `note`), `QuestionCard.tsx`, `Highlightable.tsx`, `SlideImage.tsx` (crop + reserved
  aspect ratio), `ReportButton.tsx` (bottom-left on every page), `QuizMe.tsx`, `NavBar.tsx` (phone tab bar),
  `Toaster.tsx`, `clientFetch.ts`, `PageSkeleton.tsx` + `loading.tsx` files, `AutoRefresh.tsx`.
- API routes under `src/app/api/`: account (signin/signup/signout/password/key), admin (users, reports, backup),
  attempts (view/answer/finish), exams (create, attempts, upload, topics), sessions (lesson, quiz, check, quiz/retake,
  quiz/regenerate, quiz/report, chat, end), review, marks, planner, calendar (exams, import read/ics), classes, pages
  (slide image), questions (flag), reports, quizme, ics/[token] (calendar feed, token-based), login.

---

## 6. What is live, in order (all on `main`; latest d5eb67e, deployed 2026-10-27)

1. **2026-10-04, first week (4abfc8a…c95d633).** Exam workspaces; PDF upload and slide reading (batch API, prompt caching);
   topic map; study sessions with lessons and tutor chat; practice exams; spaced daily review; user accounts with their own
   Claude/ChatGPT key and a spending tracker; admin page with password reset, account removal and nightly backups + restore
   script; yearly calendar + planner; board-style case sets; classes with invite codes; first tests; themed design with
   dark mode, phone tab bar, dashboard home.
2. **2026-10-08 (1e84534…eae07e2).** Practice exams: no repeats, missed questions return next exam with shuffled options,
   confidence rating before the answer, "Focus on my weak spots", choose lectures or topics, coverage of every section;
   10-question section quizzes after each topic; site renamed to Lolo's Study Buddy; four colour themes and the "Color
   blocks" redesign (owner's choice from a design canvas); QA fixes.
3. **2026-10-12 (478840b…0b3cfc5).** Remove/cancel a lecture (and cancel mid-upload); AI answer keys cross-checked against
   the option text; smaller slide images; calmer "not enough time" planning (starred topics first); **professor emphasis**
   (starred/highlighted slides detected with what was stressed; "Your professor stressed this" block; double weight in
   practice).
4. **2026-10-15 (ef4ff75…b5e41db).** Practice exams never mix in other exams' questions; topic map keeps progress when
   lectures are added (Rebuild keeps matching topics); 20-question section quizzes planned per slide and checked by a judge
   pass; highlight words and cross out options, synced to the account; confirm before finishing an exam with unanswered
   questions.
5. **2026-10-19/20 (489ae5d…0069afc).** Lesson block "Also in your other lectures"; long-lecture upload fix (background
   rendering, MuPDF memory freed per page, 125 MB cap, plain messages for proxy errors); "Write new questions" is the only
   way a quiz changes; writers and checker follow the style of her real exams; pictures on questions (any pictured slide
   can be attached; picture talk without a picture is dropped; start-up repair).
6. **2026-10-20 evening (164e7b6…840b758).** Perf top five: loading skeletons on every page, quiz written alongside the
   lesson, practice concurrency 8/6, memoized tutor chat streaming per frame, batched exam-page queries (196 → 20),
   AutoRefresh pauses in background tabs.
7. **2026-10-21 (dc8ae49…79fc9d5), calendar first release.** Manual tick marks a topic studied; archived exams leave the
   calendar and feed; countdowns in her time zone; RFC-5545 feed escaping; "Exams without a date"; "+ Add exams" table;
   "Paste or snap your exam schedule" (AI read of text/photo/PDF, ~1–2 cents, confirm screen); `.ics` school-calendar
   import (own parser); weekly busy days with "skip this week"; Upcoming strip with readiness, readiness dots, heads-up for
   exams days apart; "Re-plan from today"; per-day study hours and days off. 78 QA tests.
8. **2026-10-22/24 (7a1eca3…742cc18).** Picture detector second pass (another session's branch, merged): diagrams, labels,
   arrows, "slide N"; whole-slide fallback; judge backstop; strict mode for the start-up repair vs generous for writers.
9. **2026-10-24/25, perf batch 2 (d031be5, 8939987).** A password change signs out every other device
   (`users.session_epoch` in the cookie; old cookies count as epoch 0, nobody signed out by the deploy); every client fetch
   that could hang shows a plain message and recovers (`clientFetch.ts`; 401 → sign-in page); scroll to top + focus on
   question change; slide images reserve their aspect ratio.
10. **2026-10-25, Release 3 (363f248…dc3f87b)** — from the owner relaying Lolo's complaints; owner decisions recorded in §8:
    - **A. Topic maps by lecture** with a one-time background re-map of every exam at the first start after deploy
      (per-exam meta key `lecture_maps_v1:<exam>`; failures retried on up to 3 starts), lecture rows with "x of y
      sections done", lecture-grouped study navigation, "Next lecture →".
    - **B. Section quizzes follow the facts** (one question per distinct fact, 5–25, no fact twice; believable near-miss
      options; the question writers on **Opus 5.5** for Anthropic keys; `QUIZ_VERSION` 3 rewrote every quiz once).
    - **C. Progress kept**: per-student quiz answers across sessions/devices, "Retake this quiz", "Continue your practice
      exam · 12 of 25 answered" on the exam page and Home ("time is up" for an expired timed exam).
    - **D. Per-option explanations** (`option_notes`) under every option after answering, in quizzes, practice, results,
      review, class copies.
    - **E. Lessons cover every slide in plain words**, no word cap, terms defined, coverage check + repair,
      `LESSON_VERSION` 2.
    - **F. "Tell the site owner" report button** (flag, bottom-left, text + up to 5 screenshots → Admin → Reports) and
      **"Quiz me on this"** (highlight 3+ words while studying → 3/5/10 questions on that passage; counts toward mastery;
      resumes).
    - Three Sonnet QA passes (≈200 attack tests) found 14 real defects, all fixed before publish; the live-site `N` dev
      badge turned off (`devIndicators: false`); lesson route plain error message.
11. **2026-10-25 (9d7e19c).** Every result shows percent and fraction: "63% · 5/8" (practice results ring/legend/by-topic,
    section quiz, Quiz me, daily review, past attempts, Progress).
12. **2026-10-25 (ddd21ff, deployed via 892a16a).** Renamed to **Lolo's Dental Buddy** (title, home-screen name "Dental
    Buddy", nav, brand, help text, calendar feed name, README).
13. **2026-10-27 (91b95ac, a72ec31, d5eb67e — by the cloud session "Lolo's dental buddy", on the owner's "publish").**
    `docs/TODO.md` parks the calendar second release with what exists, the five items, their order and the questions to
    settle first. **Lessons are written and shown slide by slide**, at Lolo's request: each slide's picture with
    "Slide N" and the lecture name above it (a "★ Professor stressed this" chip where marked), tap to zoom, and the
    plain-words explanation under it, instead of one continuous text plus a picture gallery. `LESSON_VERSION` 3 rewrites
    every stored lesson once on next open; the lesson route sends every slide's number, lecture and aspect (`slideInfo`)
    and serves only slides still in the section. Its Sonnet QA (`tests/sonnet18-slide-lessons`, 54 tests) fixed class
    copies carrying a lesson slide whose page wasn't copied, and a punctuation-only fact forcing a repair call.

---

## 7. The QA record (why rule 2 exists)

Each release's Sonnet QA found real bugs the build had missed; the test files are the regression suite:
`sonnet2`/`sonnet5` (practice coverage), `sonnet6` (lecture removal, emphasis), `sonnet7` (jobs A–C), `sonnet8` (upload),
`sonnet9` (regenerate), `sonnet10`/`sonnet13` (pictures: 16 false positives + 21 misses in the detector),
`sonnet11` (perf), `sonnet12` (calendar: 8 bugs incl. a quadratic .ics parser), `sonnet14` (perf batch 2: raw "Failed to
fetch" text), `sonnet15` (lecture maps: half-read lecture mapped early, swallowed auto request, re-map of a rebuilt exam,
wasted AI calls, empty copied sections), `sonnet16` (quizzes/progress/lessons: class copies lost option notes, planner
duplicates, stemming, Continue card limit), `sonnet17` (reports/Quiz me: off-site link on the Admin page, screenshots
surviving account deletion, 400 KB image decoding to 900 MB). Run them all; keep writing new ones per change.

---

## 8. Owner decisions already taken (don't re-ask)

- Rebuild **all** existing exams into lecture-based maps (lessons/quizzes rewritten; section-quiz progress of old
  sections lost; practice history and mastery kept). Done at the first start after Release 3.
- Opus 5.5 for the **question writers only** (section quiz, practice, case sets, Quiz me); checker, lessons, tutor,
  slide reading stay on Sonnet; ChatGPT users unchanged.
- Rewrite all stored quizzes once (done, `QUIZ_VERSION` 3) and lessons once (`LESSON_VERSION` 2, on first open).
- Bug reports go to the **Admin page only** (no email).
- Quiz size follows the facts, floor 5, ceiling 25. "Quiz me" works anywhere studying with a 3/5/10 choice.
  Lessons: every slide, plain language. An open practice exam shows "Continue" but new ones are still allowed.
- Extra study hours on a day do **not** pull work forward (a "Get ahead" button only if Lolo asks).
- `QUIZ_VERSION` was deliberately *not* bumped for the exam-style change on 2026-10-20 (existing quizzes stayed).
- Pre-warming the next topic's quiz on prefetch was **not** done (costs credit; needs the owner's OK).

---

## 9. Open items

**Owner to-dos (remind gently):** change `APP_PASSCODE` in Railway; make the GitHub repo private (it was public as of
2026-10-08); check Railway "App Sleeping" is off for the service; the merged side branch `claude/happy-albattani-wciqoh`
can be deleted; Lolo was going to remove a broken "Lect 5" and re-upload Lect 5/6 (may be done).

**Waiting on Lolo's feedback:** the lecture-based layout, the fact-sized Opus quizzes and per-option notes, the fuller
lessons, Quiz me, the report button, the calendar. Real-AI quality of the exam-style prompts, the schedule-photo import and
the lesson coverage check has not been checked with a real key by us.

**Known gaps, by size:**
- Not built from Release 3's plan: "Ask the tutor about this" on the Quiz-me score screen (TutorChat lives inside
  StudySession; a window event would do it); Quiz me on the daily-review page (review is cross-exam; cards carry no exam id).
- Expired timed exams are only finished when opened (the client Timer does it); abandoned attempts stay "ready" until
  opened; no per-user rate limit on reports or sign-in; the Admin Reports list caps at 100 with no paging.
- Case-set practice exams aren't backfilled when a set fails (exam is ready but short). A judge-flagged picture question
  gets its whole slide without a second answer-leak check. iPhone HEIC photos can't be decoded (students are told to
  screenshot). The per-option note is squeezed next to the "Your answer"/"Correct" chips at 375 px (cosmetic). Home's
  "x of y lectures" counts only lectures with sections. A kept topic whose slides changed in a Rebuild loses its lesson
  and quiz (pre-existing rule). Settings bills a custom `CLAUDE_QUALITY_MODEL` at Sonnet prices if it isn't in `PRICES`.
- Older plan items: `friendlyAiError` on the chat/end/practice error paths; inline report form for practice questions
  (still `window.prompt`); admin un-flag; Geist Mono `preload: false`.

**Next candidates (owner's call):** the calendar second release (parked with details in `docs/TODO.md`: move/skip a
single task; better phone feed with alerts 3 days and 1 day before; class-shared exam dates; weekly summary; email
reminders only if the owner says yes); perf batch 3
(slides rendered in a worker thread; 640 px slide images with srcset; streamed uploads); the Quiz-me leftovers above.

---

## 10. Safe local testing recipe (what we actually do)

1. Copy the code to `.preview-app/` (git-excluded on the PC; create it anywhere on a fresh machine): `robocopy src
   .preview-app\src /MIR` (PowerShell; Git Bash mangles the paths), plus `public`, `package.json`, `next.config.ts`,
   `tsconfig.json`, `postcss.config.mjs`, `next-env.d.ts`. Never copy `.env.local`.
2. Seed a throwaway database into a temp `DATA_DIR` (the seed scripts we used live in session scratch folders on the PC,
   not in the repo; writing a new one is ~60 lines: a user with `api_key_enc='enc'`, an exam, two documents, pages with
   `notes_json`, topics with `document_id`, optionally a stored `lesson_json` with `version: 2` and `checks_json` with
   `option_notes`, an attempt). The seed must print a `study_gate` cookie (`gateToken()`) and a `study_session` cookie
   (`sessionToken(userId, 0)`) to set in the browser.
3. Start through a `.cmd` that sets `DATA_DIR`, `SECRET_KEY`, `APP_PASSCODE` itself and refuses to start if the temp
   `study.db` is missing, then `npx next dev .preview-app -p 3100`. Putting `set X=…&&` inline into launch.json silently
   falls back to `./data` (happened twice). Check the first log line shows the temp `DATA_DIR`.
4. In an isolated worktree, Turbopack rejects a `node_modules` junction unless `turbopack.root` points above it (set it
   in the worktree's `next.config.ts` only).
5. Stop the server and restore `.claude/launch.json` before committing.

---

## 11. First-session checklist

1. `git fetch`; compare `main` with `origin/main` and list unmerged `claude/*` branches.
2. `npx vitest run` (expect 1061 passed + 1 expected fail), `npx tsc --noEmit -p .`, `npx eslint src tests`.
3. Check the last Railway deploy status with the `gh api … deployments` commands in §2.
4. Read this file's §3 rules, then the code map (§5) for the area you'll touch, then the Next 16 docs for anything in
   routes/pages.
5. Before building anything sizeable: write the plan, ask the owner your questions, get a go-ahead. Build → Sonnet QA →
   fix → local commit → ask "publish".

---

## 12. What lives only on the owner's PC (git-excluded, in `C:\Users\ibrah\Dental-Study\design\`)

- `START-HERE.md` (the previous handoff), `HANDOFF.md` (dated running log since 2026-10-12 with every QA round),
  `RELEASE-3-PLAN.md`, `CALENDAR-RESEARCH.md`, `PERF-REVIEW.md`, `OPUS-PLAN.md`, `redesign-spec.md`, `exam-style-notes.md`
  (summary of the past-exam style; the usable rules are in `src/lib/examStyle.ts`), `artboards/` (design canvas HTML).
- `past-exams/` — ten of Lolo's real past exam PDFs (Endo 2020–2024, Fixed Prosthodontics 2020–2023). **Private student
  material; never commit them.**
- `UI screenshots/`, `.preview-app/`, session scratch folders with seed scripts and throwaway databases.
- The Claude memory folder for this project on the PC records the same rules in short form.

A cloud session cannot see any of that; everything needed to work is in this file plus the repo.
