# Practice exams written to a plan

Owner's request (November 2026): before any question of a practice exam is written, a plan exists that lists every
question in it; the questions are then written to that plan. Decisions the owner made:

1. When the exam is smaller than the material, facts are chosen in this order: ones she got wrong, ones she was
   unsure about, ones never tested, ones she emphasized (★), then the rest, least recently tested first.
2. An exam that comes up short (a key problem, a busy AI service, a restart) finishes itself: no button.
3. The exam page and the end of each exam show how much of the material the exam covered.

This document is the contract between the pieces. Section quizzes already work this way (`src/lib/quizPlan.ts`).

## Why

Today a practice exam plans how many questions each section gets (`allocate` in `src/lib/practicePlan.ts`), not what
each question is about. Repeats are discouraged by showing the writer up to 60 old stems; coverage inside a section
is left to the writer; and when one call of a long exam fails, what it would have covered is simply missing and
nobody knows which facts those were.

## Words

- **Fact**: one entry of a slide's `key_facts` (from `notes_json`), identified by `factKey(text)` = `normStem(text)`
  from `src/lib/quizPlan.ts`. The same text on two slides of one section is one fact (first slide wins).
- **Slot**: one planned question. `{ n, topic_id, page_id, fact, key, kind, why, state, question_id }`.
  - `n`: 1-based number in the plan, stable for the life of the attempt.
  - `fact`: the fact text, or null for a slide with nothing listed (a picture or case slide): the slot is then "a
    question from this slide".
  - `key`: `factKey(fact)`, or `slide:<page_id>` when `fact` is null.
  - `kind`: "recall" | "case" | "image" (what the writer is asked for; from the exam's style and what the slide has).
  - `why`: "missed" | "unsure" | "new" | "starred" | "rotation" | "retry" | "unused" (why it is in the plan).
  - `state`: "todo" | "done" | "failed". `question_id` is set when done.
- **Case slot group** (style "caseset" only): slots that share a `case_n` belong to one patient case, 3–5 per case,
  from neighbouring slides of one section.

## Data (all added in `src/lib/db.ts`, columns nullable so old rows are untouched)

- `questions.fact_key TEXT`: the slot key the question was written for (null for questions written before this).
- `attempts.requested INTEGER`: how many questions she asked for.
- `attempts.slots_json TEXT`: the plan (array of slots, plus case groups for case sets).
- `attempts.short_reason TEXT`: null, or why writing stopped before every slot was filled: "key" (her key or
  billing: do not retry until it changes), "busy" (a temporary failure), "interrupted" (a restart).
- `attempts.resumed_at TEXT`: when writing was last resumed (limits how often it is tried).
- `attempts.options_json TEXT`: the options the exam was started with (style, scope, adaptive), so it can resume.
- `ai_usage.ok INTEGER NOT NULL DEFAULT 1`, `ai_usage.error TEXT`, `ai_usage.ref TEXT`: see "AI activity" below.

## The planner (`src/lib/examPlan.ts`, pure functions plus thin database readers; no AI call)

`planExam(input): ExamPlan`

Input: the sections in scope (in order), each with its slides (`FactSlide`-like: page id, facts, starred, has a
case, has a picture she can be shown); the history of each fact key in this exam family (last result: wrong /
unsure / right, and when); the questions that may come back as they are (missed ones, capped at `RETRY_SHARE`, and
written-but-never-answered ones); the size asked for; the style; whether "focus on my weak spots" is on.

Rules, in order:

1. Returning questions take slots first (`why: "retry"` for missed ones she sees again as they were, `why: "unused"`
   for questions written earlier and never answered), `state: "done"` from the start, each covering its own
   `fact_key` (or its slide when it has none). Never more than `RETRY_SHARE` of the exam are retries, and never so
   many that a section in scope would be left without a slot.
2. Every section in scope gets at least one slot when the size allows; when it does not, the sections least
   recently practised come first.
3. Remaining slots go to facts not already covered by rule 1, ranked: wrong last time ("missed"), unsure last time
   ("unsure"), never tested ("new"), starred ("starred"), then the rest by least recently tested ("rotation").
   With "focus on my weak spots" off, missed and unsure rank with "new" instead of ahead of it. Within one rank,
   facts are taken round-robin across sections so one long section cannot take every slot.
4. A fact is in the plan at most once. When the size is larger than the number of facts in scope, the extra slots
   are second questions on the highest-ranked facts with a different `kind` (never the same fact with the same
   kind twice).
5. `kind` follows the style: "recall" → all recall; "case" → case, and image where the slide has a picture she can
   be shown; "mixed" → about 60% recall, 25% case, 15% image, given to the slides that can carry them (a case kind
   prefers a slide with a case; an image kind requires a slide with a picture, else it becomes recall).
6. Questions from old exams without a `fact_key` count against their slide: a slide's facts are "tested" in
   proportion to how many old questions were written from it (so the first plans after this change lean away from
   slides that already have many questions, without pretending to know which fact each tested).
7. Case sets: the plan is a list of cases; each case is 3–5 slots from neighbouring slides of one section, chosen
   by the same ranking applied to the case's best fact; retried cases come back whole.

`coverage(scope): { facts: number; tested: number; right: number; inThisExam?: number }` counts distinct fact keys
in scope, how many she has been asked at least once, and how many she got right last time.

The plan is deterministic for a given input except for the final order of slots, which is shuffled so the exam does
not run section by section (cases stay together).

## Writing to the plan (`src/lib/practice.ts`)

- `startAttempt` builds the plan, stores `requested`, `options_json`, `slots_json`, then writes.
- Slots are written per section, at most `QUESTIONS_PER_CALL` (12) slots per call and `SECTION_CONCURRENCY` (4) calls
  at a time. The writer is given numbered lines, `Q<n>: slide P<id> — fact: "…" — <kind>`, and answers with the slot
  number on each question. A question is accepted only for the slot it names, after `validateMcq` and the picture
  check. Slots left empty by a call get ONE more call for just those slots; a slot still empty is `failed`.
- The writer is no longer sent the list of old stems. It is told which facts NOT to drift into only implicitly: one
  fact per slot.
- Each accepted question stores `fact_key`. Each slot's `state` and `question_id` are saved as soon as its call
  returns, so a restart loses at most the calls in flight.
- A key or billing problem stops all further calls and sets `short_reason = "key"`. Other failures set "busy".
- The attempt becomes "ready" as soon as every call has returned and at least one slot is done; with none done it is
  "error" as today.

## Finishing itself

`resumeAttempt(attemptId)`: for an attempt that is "ready", not finished, and has "todo" or "failed" slots: write
those slots (same writer), append the new questions at the end of the exam, extend a timed exam's limit by
`SECONDS_PER_QUESTION` per appended question, clear `short_reason` when every slot is done.

It is called: when she opens the attempt or the page polls it (at most once every two minutes per attempt, by
`resumed_at`; for "key" not until her key or provider changed since `resumed_at`, or 30 minutes passed); and at
start-up for attempts interrupted by a restart (instead of failing them when at least one slot is done).

It never runs for a finished attempt, never twice at once for one attempt, and never changes a question already in
the exam.

## What she sees (`attemptView` fields; the screens read only these)

- `requested: number | null`, `written: number` (questions in the exam), `pending: number` (slots still to write).
- `short: null | { reason: "key" | "busy" | "interrupted"; writing: boolean }`.
- `coverage: { facts: number; inThisExam: number; tested: number } | null`.

Screens:

- Exam in progress, when `pending > 0`: one line above the questions. Writing now: "23 of 100 questions so far. The
  rest are being written and will appear at the end." Key: "23 of 100 questions so far. Your AI key couldn't write
  the rest (credit or key problem). Fix it in Settings and the rest are written when you come back." Busy: "23 of 100
  questions so far. The rest will be written shortly."
- Exam page (practice card) and results: "This exam covers 40 of the 212 facts in these lectures. You have been
  tested on 96 so far." When everything in scope has been tested: "You have been tested on all 212 facts in these
  lectures."

## AI activity (so problems are seen without a student's screenshot)

Every AI call is logged, including failed ones: `ai_usage.ok` (0 on failure), `ai_usage.error` (one short line, no
key text), `ai_usage.ref` (what it was for: `topic:<id>`, `attempt:<id>`, `doc:<id>`). `generate()` takes an optional
`ref` and logs failures before rethrowing. The Admin page gets an "AI activity (last 7 days)" card: per purpose, the
number of calls, failures with the most common error, average and total cost; and for lessons, how many needed a
repair and how many failed.

## Fake AI for browser tests

`AI_FAKE=1` makes `generate()` answer from built-in deterministic writers (slide notes, section map, lesson parts,
section quiz, judge, practice questions to a plan, case sets, quiz me) without any network call. It is refused when
`NODE_ENV === "production"` (the server will not start with it set). It exists for the browser tests in `e2e/` and
for previews; it is never a fallback.

## Decisions taken while building (these override anything above they conflict with)

- The planner's API is the header comment of `src/lib/examPlan.ts`; coverage is `examCoverage(examId, scope, slots?)`.
- A plan can be smaller than the size asked for: a fact is never asked twice with the same kind, so a recall-only
  exam over lectures with 30 facts has 30 questions. That is a COMPLETE exam, not a short one. `pending` counts only
  slots in state "todo" or "failed"; `requested - plan.slots.length` is shown differently: "These lectures have
  material for 30 questions, so this exam has 30 (you asked for 100)."
- The coverage line counts what the exam PLANS to cover: pass every slot of the plan to `examCoverage`, whatever its
  state, and count its distinct in-scope keys.
- `attemptView` therefore also carries `planned: number` (slots in the plan).
