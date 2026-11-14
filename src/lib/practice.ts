import crypto from "node:crypto";
import { z } from "zod";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { db, type Question, type Topic } from "./db";
import { generate, mapLimit } from "./ai";
import { parseNotes } from "./processing";
import { slideNotesText, topicPages } from "./study";
import { recordConceptResult, upsertConcept } from "./memory";
import { lecturePageIds, shuffledOrder, type Confidence, type Scope } from "./practicePlan";
import { buildExamPlan, type CaseGroup, type ExamPlan, type Slot } from "./examPlan";
import { credentials } from "./credentials";
import { examOwner } from "./db";
import { EXAM_STYLE, NO_COVER_RULE } from "./examStyle";
import { flagQuestionEverywhere } from "./classes";
import { saveReportedQuestion, slideOrigin } from "./reportedQuestions";
import { markPictures, mentionsPicture, pictureFor, PICTURE_RULES } from "./questionImage";
import { validateMcq } from "./mcq";
import { normStem } from "./quizPlan";
import { track } from "./inflight";
import { isKeyProblem } from "./http";

export type Style = "mixed" | "recall" | "case" | "caseset";
export type Mode = "tutor" | "timed";
export const SECONDS_PER_QUESTION = 72;

const GeneratedQuestions = z.object({
  questions: z.array(
    z.object({
      slot: z.number().describe("The Q number of the planned question this answers"),
      type: z.enum(["recall", "case", "image"]),
      image_page_id: z
        .number()
        .nullable()
        .describe("For a question about a picture: the ID of a slide marked [IMAGE] or [IMAGE-CASE] whose picture the student will see. Otherwise null"),
      patient_box: z
        .object({
          patient: z.string().describe("Age, sex"),
          chief_complaint: z.string(),
          medical_history: z.string(),
          medications: z.string(),
          allergies: z.string(),
          dental_history: z.string(),
          findings: z.string().describe("Clinical and radiographic findings / test results"),
        })
        .nullable()
        .describe("Required for type=case, null otherwise"),
      stem: z.string(),
      options: z.array(z.string()).describe("Exactly 5 answer choices, no letter prefixes"),
      correct_index: z.number().describe("0-based index of the correct option"),
      correct_answer: z.string().describe("The correct option, copied exactly as written in options"),
      explanation: z.string().describe("Why the answer is correct and briefly why the main distractors are wrong. Cite the slide"),
      option_notes: z
        .array(z.string())
        .describe("One short sentence per option, in the same order as options: for the correct one why it is right, for each wrong one why it is wrong (what it confuses)"),
      source_page_id: z.number().describe("ID of the slide this question is based on"),
      concept: z.string().describe("The concept tested; use one of the listed concept names"),
    }),
  ),
});

const SYSTEM = `You write board-quality practice questions for a dental student, based strictly on their lecture slides.
You are given a numbered list of planned questions: each names the slide it must test, usually the exact fact it must test, and the type to write. Write exactly one question for each, and set slot to its Q number and source_page_id to that slide.
- A question with a listed fact tests exactly that fact. One without tests its slide. Never test another planned question's fact.
- A planned question marked "missed last time" or "unsure last time" tests a fact the student got wrong or wasn't sure about: ask it from a different angle (new stem, scenario or options), not as a reworded copy.
- Single best answer, 5 options.
- option_notes: one short sentence per option, in the same order as options — for the right one why it is right, for each wrong one exactly why it is wrong (which fact or condition it mixes up).
- type=recall: a direct question testing one fact or relationship.
- type=case: INBDE style. Fill patient_box with a realistic patient (chief complaint, medical history, medications, allergies, dental history, findings), then ask about diagnosis, next step, or treatment.
- type=image: a question about a picture (radiograph, clinical photo, diagram). Set image_page_id to the slide whose picture the student sees, and write the stem to describe the scenario without giving away the answer.
- ${PICTURE_RULES}
- Slides marked ★IMPORTANT were emphasized by the professor. Do not test trivia like citations or years.
- Every fact in the question and explanation must be supported by the slides.

${NO_COVER_RULE}

${EXAM_STYLE}`;

/**
 * Per-option notes as stored: in the shuffled display order, and only when there is exactly one non-empty note per
 * option (a good question is never dropped over its notes; it just shows the paragraph explanation).
 */
export function optionNotesJson(options: string[], notes: unknown, order: number[]): string | null {
  if (!Array.isArray(notes) || notes.length !== options.length || !notes.every((n) => typeof n === "string" && n.trim())) return null;
  return JSON.stringify(order.map((i) => (notes[i] as string).trim()));
}

type AttemptOptions = {
  size: number;
  mode: Mode;
  style: Style;
  topicIds?: number[];
  /** Chosen lectures: only their slides are used, even in topics that also hold slides from other lectures. */
  documentIds?: number[];
  taskId?: number;
  adaptive?: boolean;
};

/**
 * What an exam was started with, kept in attempts.options_json so it can finish itself later. `keyMark` is a hash of
 * her stored (encrypted) key and provider when her key last stopped the writing: writing is tried again once it
 * changes. Never the key itself, and never sent to the browser.
 */
type StoredOptions = {
  style: Style;
  size: number;
  topicIds: number[];
  documentIds: number[];
  adaptive: boolean;
  scope: Scope;
  keyMark?: string;
  /** Seconds to wait before the next resume of a short exam (see RESUME_SPACING_SEC); absent: two minutes. */
  busyWait?: number;
};

/** Slides a practice exam may draw from: null means every slide of each chosen topic. */
type PageFilter = Set<number> | null;

/** Why writing stopped before every planned question had one (attempts.short_reason). */
export type ShortReason = "key" | "busy" | "interrupted";

/** Create an attempt, plan it and write its questions in the background. Returns the attempt id. */
export function startAttempt(examId: number, opts: AttemptOptions) {
  // "Focus on my weak spots" defaults to the student's saved preference.
  const adaptive =
    opts.adaptive ??
    !!(db.prepare("SELECT u.focus_weak FROM users u JOIN exams e ON e.user_id = u.id WHERE e.id = ?").get(examId) as { focus_weak: number } | undefined)?.focus_weak;
  const topicIds = opts.topicIds ?? [];
  const documentIds = opts.documentIds ?? [];
  const stored: StoredOptions = {
    style: opts.style,
    size: opts.size,
    topicIds,
    documentIds,
    adaptive,
    scope: documentIds.length ? { kind: "lectures", documentIds } : topicIds.length ? { kind: "topics", topicIds } : { kind: "all" },
  };
  const attemptId = Number(
    db
      .prepare("INSERT INTO attempts (exam_id, mode, time_limit_sec, task_id, adaptive, requested, options_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(examId, opts.mode, opts.mode === "timed" ? opts.size * SECONDS_PER_QUESTION : null, opts.taskId ?? null, adaptive ? 1 : 0, opts.size, JSON.stringify(stored))
      .lastInsertRowid,
  );
  queued(examId, () =>
    generateAttempt(attemptId, examId, stored).catch((err) => {
      console.error(`Practice exam ${attemptId} could not be written`, err);
      db.prepare("UPDATE attempts SET status = 'error', error = ? WHERE id = ?").run(storedError(err), attemptId);
    }),
  );
  return attemptId;
}

/** The error she is shown for an exam that could not be written: the AI's own words, never database text. */
function storedError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const text = String(err);
  if ((typeof code === "string" && code.startsWith("SQLITE")) || /SQLITE|constraint failed/i.test(text)) {
    console.error("Practice exam: writing stopped on a database error", err);
    return NO_QUESTIONS;
  }
  return text;
}
const NO_QUESTIONS = "No questions could be generated.";

const buildQueue = new Map<number, Promise<void>>();

/**
 * Writing for one course runs one piece at a time (a new exam, or the rest of a short one), so two never pick the
 * same unused questions: questions a resume has written sit in no exam until it appends them. Tracked, so a deploy
 * waits a little for an exam being written instead of throwing away what was paid for. `work` never rejects.
 */
function queued(examId: number, work: () => Promise<void>): Promise<void> {
  const previous = buildQueue.get(examId) ?? Promise.resolve();
  const run = track(previous.then(work));
  buildQueue.set(examId, run);
  void run.finally(() => {
    if (buildQueue.get(examId) === run) buildQueue.delete(examId);
  });
  return run;
}

/**
 * A practice exam this student started on this exam (from this plan task, or from no task) that is still being
 * written and is under ten minutes old (a long exam takes several minutes): another tap on Start gets that one back
 * instead of paying for a second.
 */
export function writingAttempt(userId: number, examId: number, taskId: number | null = null): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM attempts a JOIN exams e ON e.id = a.exam_id
       WHERE e.user_id = ? AND a.exam_id = ? AND a.task_id IS ? AND a.status = 'generating' AND a.started_at > datetime('now', '-10 minutes')
       ORDER BY a.id DESC LIMIT 1`,
    )
    .get(userId, examId, taskId) as { id: number } | undefined;
  return row?.id ?? null;
}

export const INTERRUPTED_ATTEMPT = "This practice exam was interrupted while it was being written. Start it again; questions already written are reused.";

/**
 * At boot: practice exams still "generating" after five minutes were cut off by a restart (nothing is writing them
 * any more). One that already has written questions becomes a short exam with those ("interrupted"), and the rest is
 * written when she opens it (resumeAttempt). One with none, or one from before exams were planned, becomes an error
 * she can start again instead of a page that waits forever.
 */
export function recoverStaleAttempts(): { recovered: number; failed: number } {
  const stale = db.prepare("SELECT id, slots_json FROM attempts WHERE status = 'generating' AND started_at < datetime('now', '-5 minutes')").all() as {
    id: number;
    slots_json: string | null;
  }[];
  let recovered = 0;
  let failed = 0;
  for (const a of stale) {
    // Planned questions of a removed lecture (or whose question is gone) are dropped first.
    const plan = parsePlan(a.slots_json) ? dropGone(a.id) : null;
    if (plan && plan.slots.some((s) => s.state === "done") && finishGeneration(a.id, openSlots(plan).length ? "interrupted" : null, false)) recovered++;
    else {
      db.prepare("UPDATE attempts SET status = 'error', error = ? WHERE id = ? AND status = 'generating'").run(INTERRUPTED_ATTEMPT, a.id);
      failed++;
    }
  }
  return { recovered, failed };
}

/**
 * How many AI calls write an exam's sections (and case sets) at the same time. More at once is faster but hits rate
 * limits (429) on low-tier API keys, since every call is on the expensive model. Case sets are longer calls, so they
 * run fewer at once.
 */
export const SECTION_CONCURRENCY = 4;
export const CASESET_CONCURRENCY = 3;

/**
 * The most planned questions (or case sets) asked of one AI call: a long answer can be cut off at the output limit,
 * and a cut-off answer is billed and lost whole, so this bounds what one failure costs.
 */
export const QUESTIONS_PER_CALL = 12;
export const CASES_PER_CALL = 3;

/** `total` split into near-equal turns of at most `max` (30 by 12 → 10, 10, 10). */
export function chunkSizes(total: number, max: number): number[] {
  if (total <= 0) return [];
  const n = Math.ceil(total / max);
  return Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
}

/** `xs` cut into near-equal runs of at most `max`, in order. */
function chunks<T>(xs: T[], max: number): T[][] {
  let at = 0;
  return chunkSizes(xs.length, max).map((n) => xs.slice(at, (at += n)));
}

/**
 * What goes into a practice exam is decided by the plan (lib/examPlan.ts, docs/EXAM-PLAN.md) before anything is
 * written: missed questions coming back, questions written earlier and never answered, and one new question per
 * planned fact. Then the planned questions are written, and the exam is ready.
 */
async function generateAttempt(attemptId: number, examId: number, opts: StoredOptions) {
  let topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
  if (opts.topicIds.length) topics = topics.filter((t) => opts.topicIds.includes(t.id));
  if (topics.length === 0) throw new Error("This exam has no topics yet. Upload lectures and wait for the topic map.");
  // Chosen lectures: a topic may also hold slides from other lectures; only the chosen lectures' slides are used.
  const pages: PageFilter = opts.topicIds.length && opts.documentIds.length ? lecturePageIds(examId, opts.documentIds) : null;
  const caseset = opts.style === "caseset";
  const plan = buildExamPlan(examId, {
    size: opts.size,
    style: opts.style,
    adaptive: opts.adaptive,
    topicIds: opts.topicIds,
    documentIds: pages ? opts.documentIds : [],
    unused: caseset ? [] : topics.flatMap((t) => unusedQuestions(t.id, opts.style, 1000, pages)),
    unusedCases: caseset ? topics.flatMap((t) => unusedCases(t.id, 1000, pages)) : [],
  });
  if (plan.slots.length === 0) throw new Error(NO_QUESTIONS);
  db.prepare("UPDATE attempts SET slots_json = ? WHERE id = ?").run(JSON.stringify(plan), attemptId);
  // A lecture removed while the plan was made: its planned questions are dropped before anything is paid for.
  const ready = dropGone(attemptId) ?? plan;
  savePlan(attemptId, {
    style: opts.style,
    ...(caseset ? { cases: plan.cases.length } : { size: plan.slots.length }),
    retried: plan.slots.filter((s) => s.why === "retry").length,
    fresh: plan.slots.filter((s) => s.state === "todo").length,
    topics: new Set(plan.slots.map((s) => s.topic_id).filter((t) => t != null)).size,
  });

  const run = newRun(attemptId, examId);
  await writeSlots(run, ready, opts, new Set(ready.slots.filter((s) => s.state === "todo").map((s) => s.n)));
  // A lecture removed while it was being written: its planned questions are dropped, and the exam is the rest.
  const after = dropGone(attemptId);
  const left = after ? openSlots(after).length : 0;
  if (!finishGeneration(attemptId, left ? shortOf(run) : null, true)) {
    throw run.firstError instanceof Error ? run.firstError : new Error(NO_QUESTIONS);
  }
  if (run.stopped) rememberKey(attemptId, examId);
}

/** What the exam is being built from, so the loading screen can show real steps while the AI writes. */
export type AttemptPlan = { style: Style; size?: number; cases?: number; retried: number; fresh: number; topics: number };
function savePlan(attemptId: number, plan: AttemptPlan) {
  db.prepare("UPDATE attempts SET plan_json = ? WHERE id = ?").run(JSON.stringify(plan), attemptId);
}

// ---- The stored plan (attempts.slots_json) ----

const STATES = new Set(["todo", "done", "failed", "dropped"]);
const KINDS = new Set(["recall", "case", "image"]);
const idOrNull = (x: unknown) => x == null || Number.isInteger(x);

/** A stored slot as the writer and the screens need it; anything else means the plan was damaged by hand. */
function isSlot(x: unknown): x is Slot {
  const s = x as Partial<Slot> | null;
  return (
    !!s &&
    typeof s === "object" &&
    Number.isInteger(s.n) &&
    typeof s.key === "string" &&
    STATES.has(s.state as string) &&
    KINDS.has(s.kind as string) &&
    idOrNull(s.topic_id) &&
    idOrNull(s.page_id) &&
    idOrNull(s.question_id) &&
    (s.fact == null || typeof s.fact === "string") &&
    (s.tries == null || Number.isInteger(s.tries)) &&
    (s.case_n == null || Number.isInteger(s.case_n))
  );
}
const isCase = (x: unknown): x is CaseGroup => {
  const c = x as Partial<CaseGroup> | null;
  return !!c && typeof c === "object" && Number.isInteger(c.case_n) && Array.isArray(c.slots) && c.slots.every((n) => Number.isInteger(n));
};

/**
 * The stored plan, or null when there is none or it is damaged (unparsable, or an entry of the wrong shape): such an
 * attempt reads as one from before plans and is never resumed.
 */
export function parsePlan(json: string | null | undefined): ExamPlan | null {
  if (!json) return null;
  try {
    const plan = JSON.parse(json) as ExamPlan;
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.slots) || !plan.slots.every(isSlot)) return null;
    const cases = Array.isArray(plan.cases) ? plan.cases : [];
    return cases.every(isCase) ? { ...plan, cases } : null;
  } catch {
    return null;
  }
}

/** The stored start options, or null when missing or damaged (then the exam is never resumed). */
function parseOptions(json: string | null | undefined): StoredOptions | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as StoredOptions;
    return o && typeof o === "object" && typeof o.style === "string" && Array.isArray(o.topicIds) && Array.isArray(o.documentIds) ? o : null;
  } catch {
    return null;
  }
}

/** Change the stored start options (her key mark, the busy wait); nothing when they are missing or damaged. */
function updateOptions(attemptId: number, change: (o: StoredOptions) => StoredOptions) {
  const opts = parseOptions((db.prepare("SELECT options_json FROM attempts WHERE id = ?").get(attemptId) as { options_json: string | null } | undefined)?.options_json);
  if (opts) db.prepare("UPDATE attempts SET options_json = ? WHERE id = ?").run(JSON.stringify(change(opts)), attemptId);
}

/** The plan as stored now. Always read again: calls running side by side save their slots into the same row. */
function readPlan(attemptId: number): ExamPlan | null {
  return parsePlan((db.prepare("SELECT slots_json FROM attempts WHERE id = ?").get(attemptId) as { slots_json: string | null } | undefined)?.slots_json);
}

/** Planned questions that still need writing. */
export const openSlots = (plan: ExamPlan) => plan.slots.filter((s) => s.state === "todo" || s.state === "failed");
const isOpen = (s: Slot) => s.state === "todo" || s.state === "failed";

/**
 * How many writing calls may ask for one planned question (the first call, its follow-up, then one each resume): a
 * fact the writer keeps refusing costs a bounded number of calls, and the exam completes without it ("dropped").
 */
export const MAX_TRIES = 3;

type SlotUpdate = { n: number; state: Slot["state"]; question_id?: number | null };

/**
 * Save what one call did to its slots, by slot number, re-reading the row first (one small transaction per call, run
 * inside the caller's transaction when it has one). `drop`: slots taken out of the plan (the planned questions a
 * written case set left out: the case is complete with the questions it has). `tried`: slots this call asked for,
 * each counted as one try; one still open after MAX_TRIES is dropped.
 */
function saveSlots(attemptId: number, updates: SlotUpdate[], drop: number[] = [], tried: number[] = []) {
  db.transaction(() => {
    const plan = readPlan(attemptId);
    if (!plan) return;
    const byN = new Map(updates.map((u) => [u.n, u]));
    const gone = new Set(drop);
    const asked = new Set(tried);
    const slots = plan.slots
      .filter((s) => !gone.has(s.n))
      .map((s) => {
        const u = byN.get(s.n);
        // A dropped slot stays dropped: a call ending later never reopens it.
        let out: Slot = u && s.state !== "dropped" ? { ...s, state: u.state, question_id: u.question_id !== undefined ? u.question_id : s.question_id } : s;
        if (asked.has(s.n)) out = { ...out, tries: (out.tries ?? 0) + 1 };
        if (isOpen(out) && (out.tries ?? 0) >= MAX_TRIES) out = { ...out, state: "dropped" };
        return out;
      });
    const cases = plan.cases.map((c) => ({ ...c, slots: c.slots.filter((n) => !gone.has(n)) })).filter((c) => c.slots.length > 0);
    db.prepare("UPDATE attempts SET slots_json = ? WHERE id = ?").run(JSON.stringify({ ...plan, slots, cases }), attemptId);
  })();
}

/**
 * Planned questions that can no longer be in this exam: an unwritten one whose section or slide is gone (a lecture
 * was removed), and a written one whose question is gone (removed with its lecture). Reads only.
 */
export function goneSlots(plan: ExamPlan): Set<number> {
  const out = new Set<number>();
  const sectionPages = new Map<number, Set<number> | null>();
  const topicRow = db.prepare("SELECT page_ids FROM topics WHERE id = ?");
  const pageRow = db.prepare("SELECT 1 FROM pages WHERE id = ?");
  const questionRow = db.prepare("SELECT 1 FROM questions WHERE id = ?");
  const pagesOf = (topicId: number) => {
    if (!sectionPages.has(topicId)) {
      const t = topicRow.get(topicId) as { page_ids: string } | undefined;
      let ids: Set<number> | null = null;
      try {
        ids = t ? new Set(JSON.parse(t.page_ids) as number[]) : null;
      } catch {
        ids = new Set();
      }
      sectionPages.set(topicId, ids);
    }
    return sectionPages.get(topicId)!;
  };
  for (const s of plan.slots) {
    if (s.state === "done") {
      if (s.question_id != null && !questionRow.get(s.question_id)) out.add(s.n);
    } else if (isOpen(s)) {
      const pages = s.topic_id == null ? null : pagesOf(s.topic_id);
      if (!pages || (s.page_id != null && (!pages.has(s.page_id) || !pageRow.get(s.page_id)))) out.add(s.n);
    }
  }
  return out;
}

/**
 * Drop the planned questions that can no longer be in the exam (goneSlots) and save the plan; with nothing left to
 * write, the exam is no longer short. Returns the plan as saved (null when there is none, or it is damaged).
 */
function dropGone(attemptId: number): ExamPlan | null {
  return db.transaction(() => {
    const plan = readPlan(attemptId);
    if (!plan) return null;
    const gone = goneSlots(plan);
    if (gone.size === 0) return plan;
    const next = { ...plan, slots: plan.slots.map((s) => (gone.has(s.n) ? { ...s, state: "dropped" as const } : s)) };
    db.prepare("UPDATE attempts SET slots_json = ? WHERE id = ?").run(JSON.stringify(next), attemptId);
    if (openSlots(next).length === 0) db.prepare("UPDATE attempts SET short_reason = NULL WHERE id = ? AND short_reason IS NOT NULL").run(attemptId);
    return next;
  })();
}

// ---- Writing to the plan ----

/** One writing run (the first one, or a resume): stops every further call once her key is the problem. */
type Run = { attemptId: number; examId: number; userId: number; stopped: boolean; busy: boolean; firstError: unknown };
const newRun = (attemptId: number, examId: number): Run => ({ attemptId, examId, userId: examOwner(examId), stopped: false, busy: false, firstError: null });
const shortOf = (run: Run): ShortReason => (run.stopped ? "key" : "busy");

/**
 * A failed call: her key or billing stops this run's further calls; anything else is a busy service. Returns whether
 * it was her key (that call is not counted against its planned questions: they are not the problem).
 */
function failed(run: Run, err: unknown): boolean {
  run.firstError ??= err;
  console.error(`Practice exam ${run.attemptId}: a writing call failed`, err);
  if (isKeyProblem(err instanceof Error ? err.message : String(err))) return (run.stopped = true);
  run.busy = true;
  return false;
}

const sectionExists = (topicId: number) => !!db.prepare("SELECT 1 FROM topics WHERE id = ?").get(topicId);
const pageExists = (pageId: number) => !!db.prepare("SELECT 1 FROM pages WHERE id = ?").get(pageId);

/**
 * Of these planned questions, the ones still open in the stored plan: not written, not dropped meanwhile (tried too
 * often, or their slide removed while the call ran: dropped here, so no follow-up is paid for them).
 */
function stillOpen<T>(attemptId: number, items: T[], slotsOf: (x: T) => Slot[]): T[] {
  const plan = dropGone(attemptId);
  if (!plan) return [];
  const open = new Set(openSlots(plan).map((s) => s.n));
  return items.filter((x) => slotsOf(x).every((s) => open.has(s.n)));
}

/** A section as the writer needs it: its slides (only the chosen lectures'), their notes, its concept names. */
type SectionWriter = { topic: Topic; pages: ReturnType<typeof topicPages>; valid: Set<number>; concepts: string[] };
function sectionWriter(topicId: number, pageFilter: PageFilter): SectionWriter | null {
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic | undefined;
  if (!topic) return null;
  const pages = pagesFor(topic, pageFilter);
  const concepts = (db.prepare("SELECT c.name FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?").all(topic.id) as { name: string }[]).map(
    (c) => c.name,
  );
  return { topic, pages, valid: new Set(pages.map((p) => p.id)), concepts };
}

/** One planned question as the writer reads it: `Q4: slide P12 — fact: "…" — recall`. */
function slotLine(s: Slot): string {
  const where = s.page_id != null ? `slide P${s.page_id}` : "the section";
  const fact = s.fact ? `fact: "${s.fact.replace(/\s+/g, " ").replace(/"/g, "'")}"` : "any fact from this slide";
  const why = s.why === "missed" ? " — missed last time" : s.why === "unsure" ? " — unsure last time" : "";
  const kase = s.case_n != null ? ` — case ${s.case_n}` : "";
  return `Q${s.n}: ${where}${kase} — ${fact}${why} — ${s.kind}`;
}

/** Output room for one AI call: enough for `n` questions (or case sets) with their explanations and notes, never more. */
const tokensFor = (n: number, each: number) => Math.min(32000, 4000 + n * each);

/**
 * Write the planned questions numbered in `only`, section by section: at most QUESTIONS_PER_CALL (CASES_PER_CALL
 * cases) per call, SECTION_CONCURRENCY (CASESET_CONCURRENCY) calls at a time, each call followed by one more call for
 * the planned questions it left empty; those still empty are "failed". Every call's slots are saved when it returns.
 */
async function writeSlots(run: Run, plan: ExamPlan, opts: StoredOptions, only: Set<number>) {
  const pageFilter: PageFilter = opts.topicIds.length && opts.documentIds.length ? lecturePageIds(run.examId, opts.documentIds) : null;
  const writers = new Map<number, SectionWriter | null>();
  const writerFor = (topicId: number) => (writers.has(topicId) ? writers.get(topicId)! : writers.set(topicId, sectionWriter(topicId, pageFilter)).get(topicId)!);
  const bySection = <T>(items: T[], topicOf: (x: T) => number | null) => {
    const out = new Map<number, T[]>();
    for (const x of items) {
      const t = topicOf(x);
      if (t == null) continue;
      out.set(t, [...(out.get(t) ?? []), x]);
    }
    return out;
  };

  // One call going wrong in an unexpected way (not the AI: that is handled in the call) costs only its own slots.
  const guarded = async (slots: Slot[], work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      failed(run, err);
      saveSlots(run.attemptId, slots.filter((s) => s.state !== "dropped").map((s) => ({ n: s.n, state: "failed" as const })));
    }
  };

  if (opts.style === "caseset") {
    // Dropped slots are no longer part of their case.
    const slotOf = new Map(plan.slots.filter((s) => s.state !== "dropped").map((s) => [s.n, s]));
    const groups = plan.cases
      .map((g) => ({ group: g, slots: g.slots.map((n) => slotOf.get(n)).filter((s): s is Slot => !!s) }))
      .filter((g) => g.slots.length > 0 && g.slots.every((s) => only.has(s.n)));
    const calls = [...bySection(groups, (g) => g.group.topic_id ?? g.slots[0].topic_id).entries()].flatMap(([topicId, gs]) =>
      chunks(gs, CASES_PER_CALL).map((part) => ({ topicId, part })),
    );
    await mapLimit(calls, CASESET_CONCURRENCY, async ({ topicId, part }) => {
      const slots = part.flatMap((g) => g.slots);
      const w = writerFor(topicId);
      if (!w) return saveSlots(run.attemptId, slots.map((s) => ({ n: s.n, state: "failed" as const })));
      await guarded(slots, () => writeCaseCall(run, w, part));
    });
    return;
  }

  const todo = plan.slots.filter((s) => only.has(s.n));
  const calls = [...bySection(todo, (s) => s.topic_id).entries()].flatMap(([topicId, slots]) => chunks(slots, QUESTIONS_PER_CALL).map((part) => ({ topicId, part })));
  await mapLimit(calls, SECTION_CONCURRENCY, async ({ topicId, part }) => {
    const w = writerFor(topicId);
    if (!w) return saveSlots(run.attemptId, part.map((s) => ({ n: s.n, state: "failed" as const })));
    await guarded(part, () => writeQuestionCall(run, w, part));
  });
}

/** One call for single questions, then one follow-up for the planned questions it left empty. */
async function writeQuestionCall(run: Run, w: SectionWriter, slots: Slot[]) {
  if (run.stopped) return;
  let left = slots;
  // Not when the section was removed meanwhile (its planned questions are dropped), nor for a slot tried too often.
  for (let round = 0; round < 2 && left.length > 0 && !run.stopped && sectionExists(w.topic.id); round++) {
    const filled = await askQuestions(run, w, left);
    left = stillOpen(run.attemptId, left.filter((s) => !filled.has(s.n)), (s) => [s]);
  }
  // Tried twice (or stopped by her key after trying): what is still empty failed this time.
  if (left.length) saveSlots(run.attemptId, left.map((s) => ({ n: s.n, state: "failed" as const })));
}

/** Ask for these planned questions; store the ones that fit their slot. Returns the slot numbers filled. */
async function askQuestions(run: Run, w: SectionWriter, slots: Slot[]): Promise<Set<number>> {
  const filled = new Set<number>();
  const tried = slots.map((s) => s.n);
  let out: z.infer<typeof GeneratedQuestions>;
  let creds: ReturnType<typeof credentials>;
  try {
    creds = credentials(run.userId);
  } catch (err) {
    failed(run, err); // no call was made: nothing counted
    return filled;
  }
  try {
    out = await generate({
      creds,
      purpose: "practice questions",
      ref: `attempt:${run.attemptId}`,
      tier: "quality",
      schema: GeneratedQuestions,
      system: SYSTEM,
      effort: "medium",
      maxTokens: tokensFor(slots.length, 1000),
      content: `Topic: ${w.topic.title}\nConcept names: ${w.concepts.join("; ")}\n\nWrite ${slots.length} questions, one for each of these planned questions:\n${slots.map(slotLine).join("\n")}\n\nSlides:\n${markPictures(slideNotesText(w.pages), w.pages)}`,
    });
  } catch (err) {
    if (!failed(run, err)) saveSlots(run.attemptId, [], [], tried);
    return filled;
  }
  const open = new Map(slots.map((s) => [s.n, s]));
  // The section may have been removed while the call ran: nothing of it is stored (its planned questions are dropped).
  if (!sectionExists(w.topic.id)) {
    saveSlots(run.attemptId, [], [], tried);
    return filled;
  }
  // Drop anything that repeats an existing question on this topic word for word.
  const seen = new Set((db.prepare("SELECT stem FROM questions WHERE topic_id = ? AND case_id IS NULL").all(w.topic.id) as { stem: string }[]).map((r) => normStem(r.stem)));
  const insert = db.prepare(
    `INSERT INTO questions (exam_id, topic_id, concept_id, type, patient_box, stem, options, correct_index, explanation, option_notes, source_page_id, image_page_id, fact_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updates: SlotUpdate[] = [];
  db.transaction(() => {
    for (const raw of Array.isArray(out?.questions) ? out.questions : []) {
      // Only for a planned question of this call that is still open: a wrong, unknown or repeated number is refused.
      const slot = Number.isInteger(raw?.slot) ? open.get(raw.slot) : undefined;
      if (!slot) continue;
      const q = validateMcq(raw, { optionCount: 5, validPageIds: w.valid });
      if (typeof q === "string") continue;
      // (A stem with no letters or digits normalises to nothing: nothing to compare.)
      const key = normStem(q.stem);
      if (key && seen.has(key)) continue;
      const source = q.source_page_id ?? slot.page_id;
      // A question about a picture must have one to show: the slide it names, else the slide it was written from.
      // "generous": there is no checking pass on practice exams, so a missed picture question would be shown without
      // its picture. A planned picture question always needs one.
      const wantsPicture = slot.kind === "image" || raw.type === "image" || raw.image_page_id != null || mentionsPicture(q.stem, "generous");
      // A planned picture question may fall back on its slide's picture; any other only on the slide it cites.
      const picture = wantsPicture ? pictureFor(w.pages, raw.image_page_id, slot.kind === "image" ? source : q.source_page_id, q.stem) : null;
      if (wantsPicture && !picture) continue;
      const imagePage = picture?.page_id ?? null;
      // Never a slide that is gone (a lecture removed while the call ran): the question would cite nothing.
      if ((source != null && !pageExists(source)) || (imagePage != null && !pageExists(imagePage))) continue;
      const type = imagePage != null && (slot.kind === "image" || raw.type === "image") ? "image" : slot.kind === "image" ? "recall" : slot.kind;
      // A case question shows its patient: without a usable patient box it is refused like any other bad question.
      const patient = type === "case" ? patientBox(raw.patient_box) : null;
      if (type === "case" && !patient) continue;
      const box = patient ? JSON.stringify(patient) : null;
      // Each question on its own: one that cannot be stored never costs the others of this call.
      let id: number;
      try {
        id = db.transaction(() =>
          Number(
            insert.run(
              w.topic.exam_id,
              w.topic.id,
              upsertConcept(run.userId, raw.concept),
              type,
              box,
              q.stem,
              JSON.stringify(q.options),
              q.correct_index,
              raw.explanation,
              q.option_notes ? JSON.stringify(q.option_notes) : null,
              source,
              imagePage,
              slot.key,
            ).lastInsertRowid,
          ),
        )();
      } catch (err) {
        console.error(`Practice exam ${run.attemptId}: a written question could not be stored`, err);
        continue;
      }
      if (key) seen.add(key);
      open.delete(slot.n);
      filled.add(slot.n);
      updates.push({ n: slot.n, state: "done", question_id: id });
    }
    saveSlots(run.attemptId, updates, [], tried);
  })();
  return filled;
}

/** The patient box of a case question as the question card shows it (label → text), or null when it is unusable. */
function patientBox(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const box: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) box[k] = v.trim();
  return box.patient && box.chief_complaint ? box : null;
}

// ---- Board-style case sets: one patient, several questions ----

const PatientBox = z.object({
  patient: z.string().describe("Age, sex"),
  chief_complaint: z.string(),
  medical_history: z.string(),
  medications: z.string(),
  allergies: z.string(),
  dental_history: z.string(),
  findings: z.string().describe("Clinical and radiographic findings, test results (cold, EPT, percussion, palpation, probing, mobility)"),
});

const GeneratedCases = z.object({
  cases: z.array(
    z.object({
      scenario: z.string().describe("1-3 sentences introducing the patient's visit, without revealing any answer"),
      patient_box: PatientBox,
      image_page_id: z.number().nullable().describe("ID of an [IMAGE-CASE] slide whose clinical image fits this patient, or null"),
      questions: z
        .array(
          z.object({
            slot: z.number().describe("The Q number of the planned question this answers"),
            stem: z.string(),
            options: z.array(z.string()).describe("Exactly 5 answer choices, no letter prefixes"),
            correct_index: z.number().describe("0-based index of the correct option"),
            correct_answer: z.string().describe("The correct option, copied exactly as written in options"),
            explanation: z.string().describe("Why the answer is correct and why the main distractors are wrong. Cite the slide"),
            option_notes: z
              .array(z.string())
              .describe("One short sentence per option, in the same order as options: for the correct one why it is right, for each wrong one why it is wrong"),
            source_page_id: z.number().describe("ID of the slide this question is based on"),
            concept: z.string().describe("The concept tested; use one of the listed concept names"),
          }),
        )
        .describe("One question for each planned question of this case, in order"),
    }),
  ),
});

const CASE_SYSTEM = `You write INBDE-style case sets for a dental student, based strictly on their lecture slides.
Each case is one realistic patient (patient box: age/sex, chief complaint, medical history, medications, allergies, dental history, findings)
followed by single-best-answer questions about that same patient that build on each other, for example:
diagnosis → what test or finding confirms it → emergency/definitive treatment → prognosis, complication or follow-up.
You are given a numbered list of planned questions, grouped by case ("case 2"): write one case for each case number, with one question for each of its planned questions, in order. Set each question's slot to its Q number and source_page_id to its slide. A question with a listed fact tests exactly that fact.
- 5 options per question.
- The scenario and patient box must not give away answers. Later questions may reveal what earlier ones asked.
- If an [IMAGE-CASE] slide fits the patient, set image_page_id; the student sees only its clinical image, with every question of the case.
- ${PICTURE_RULES} In a case set, image_page_id belongs to the case: only a case with one may ask the student to look at a picture.
- Slides marked ★IMPORTANT were emphasized by the professor. Every fact must be supported by the slides.

${NO_COVER_RULE}

${EXAM_STYLE}`;

type CasePart = { group: CaseGroup; slots: Slot[] };

/** One call for up to CASES_PER_CALL planned cases, then one follow-up for the cases it left unwritten. */
async function writeCaseCall(run: Run, w: SectionWriter, part: CasePart[]) {
  if (run.stopped) return;
  let left = part;
  for (let round = 0; round < 2 && left.length > 0 && !run.stopped && sectionExists(w.topic.id); round++) {
    const written = await askCases(run, w, left);
    left = stillOpen(run.attemptId, left.filter((g) => !written.has(g.group.case_n)), (g) => g.slots);
  }
  if (left.length) saveSlots(run.attemptId, left.flatMap((g) => g.slots.map((s) => ({ n: s.n, state: "failed" as const }))));
}

/**
 * Ask for these planned cases; store each case that answers one of them with enough usable questions (three, or all
 * of a smaller planned case). A case's questions fill its planned questions by slot number; planned questions a kept
 * case left out are taken out of the plan (the case is a set as written). Returns the case numbers written.
 */
async function askCases(run: Run, w: SectionWriter, part: CasePart[]): Promise<Set<number>> {
  const written = new Set<number>();
  const imageIds = new Set(w.pages.filter((p) => parseNotes(p)?.case_image_box).map((p) => p.id));
  const notes = slideNotesText(w.pages).replace(/\[P(\d+)\]/g, (m, id) => (imageIds.has(Number(id)) ? `${m} [IMAGE-CASE]` : m));
  const usedPatients = (
    db.prepare("SELECT scenario FROM cases WHERE id IN (SELECT case_id FROM questions WHERE topic_id = ?) ORDER BY id DESC LIMIT 30").all(w.topic.id) as { scenario: string }[]
  ).map((c) => `- ${c.scenario.slice(0, 200)}`);
  const tried = part.flatMap((g) => g.slots.map((s) => s.n));
  let out: z.infer<typeof GeneratedCases>;
  let creds: ReturnType<typeof credentials>;
  try {
    creds = credentials(run.userId);
  } catch (err) {
    failed(run, err); // no call was made: nothing counted
    return written;
  }
  try {
    out = await generate({
      creds,
      purpose: "case sets",
      ref: `attempt:${run.attemptId}`,
      tier: "quality",
      schema: GeneratedCases,
      system: CASE_SYSTEM,
      effort: "medium",
      maxTokens: tokensFor(part.length, 5000),
      content: `Topic: ${w.topic.title}\nConcept names: ${w.concepts.join("; ")}\n\nWrite ${part.length} case set${part.length === 1 ? "" : "s"}, one for each case below:\n${part
        .flatMap((g) => g.slots.map(slotLine))
        .join("\n")}${
        usedPatients.length ? `\n\nCases already used for this topic. Write different patients:\n${usedPatients.join("\n")}` : ""
      }\n\nSlides:\n${notes}`,
    });
  } catch (err) {
    if (!failed(run, err)) saveSlots(run.attemptId, [], [], tried);
    return written;
  }
  if (!sectionExists(w.topic.id)) {
    saveSlots(run.attemptId, [], [], tried);
    return written;
  }

  const groupOf = new Map<number, CasePart>();
  for (const g of part) for (const s of g.slots) groupOf.set(s.n, g);
  const insertCase = db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, ?, ?, ?)");
  const insertQ = db.prepare(
    `INSERT INTO questions (exam_id, topic_id, concept_id, type, patient_box, stem, options, correct_index, explanation, option_notes, source_page_id, image_page_id, case_id, fact_key)
     VALUES (?, ?, ?, 'case', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const c of Array.isArray(out?.cases) ? out.cases : []) {
      const qsIn = Array.isArray(c?.questions) ? c.questions : [];
      // The planned case this one answers: the case of the first planned question it names that is still unwritten.
      const target = qsIn.map((q) => (Number.isInteger(q?.slot) ? groupOf.get(q.slot) : undefined)).find((g) => g && !written.has(g.group.case_n));
      if (!target) continue;
      const mine = new Map(target.slots.map((s) => [s.n, s]));
      const image = c.image_page_id != null && imageIds.has(c.image_page_id) && pageExists(c.image_page_id) ? c.image_page_id : null;
      const kept = new Map<number, { slot: Slot; q: Exclude<ReturnType<typeof validateMcq>, string>; explanation: string; concept: string; picture: number | null }>();
      for (const raw of qsIn) {
        const slot = Number.isInteger(raw?.slot) ? mine.get(raw.slot) : undefined;
        if (!slot || kept.has(slot.n)) continue;
        const q = validateMcq(raw, { optionCount: 5, validPageIds: w.valid });
        if (typeof q === "string") continue;
        // A question that sends the student to a picture must have one: the case's, else its own slide's (the same
        // check as single questions); otherwise it goes.
        let picture = image;
        if (picture == null && mentionsPicture(q.stem, "generous")) {
          picture = pictureFor(w.pages, null, q.source_page_id, q.stem)?.page_id ?? null;
          if (picture == null) continue;
        }
        // Never a slide that is gone (a lecture removed while the call ran).
        const source = q.source_page_id ?? slot.page_id;
        if ((source != null && !pageExists(source)) || (picture != null && !pageExists(picture))) continue;
        kept.set(slot.n, { slot, q, explanation: raw.explanation, concept: raw.concept, picture });
      }
      // A case is a set: one with fewer than three usable questions (or fewer than a smaller planned case) isn't one.
      if (kept.size < Math.min(3, target.slots.length)) continue;
      const patient = patientBox(c.patient_box);
      if (!patient) continue;
      const box = JSON.stringify(patient);
      const updates: SlotUpdate[] = [];
      // Each case on its own: one that cannot be stored never costs the other cases of this call.
      try {
        db.transaction(() => {
          const caseId = Number(insertCase.run(w.topic.exam_id, c.scenario, box, image).lastInsertRowid);
          for (const s of target.slots) {
            const k = kept.get(s.n);
            if (!k) continue;
            const id = Number(
              insertQ.run(
                w.topic.exam_id,
                w.topic.id,
                upsertConcept(run.userId, k.concept),
                box,
                k.q.stem,
                JSON.stringify(k.q.options),
                k.q.correct_index,
                k.explanation,
                k.q.option_notes ? JSON.stringify(k.q.option_notes) : null,
                k.q.source_page_id ?? s.page_id,
                k.picture,
                caseId,
                s.key,
              ).lastInsertRowid,
            );
            updates.push({ n: s.n, state: "done", question_id: id });
          }
        })();
      } catch (err) {
        console.error(`Practice exam ${run.attemptId}: a written case could not be stored`, err);
        continue;
      }
      written.add(target.group.case_n);
      saveSlots(
        run.attemptId,
        updates,
        target.slots.filter((s) => !kept.has(s.n)).map((s) => s.n),
      );
    }
    saveSlots(run.attemptId, [], [], tried);
  })();
  return written;
}

// ---- Finishing: the exam in plan order ----

/**
 * The written questions go into the exam in plan order (cases stay together: the plan numbers a case's questions one
 * after another). Missed questions coming back show their options in a new order. Returns false when nothing was
 * written. `short`: why some planned questions are still missing (they are written later, see resumeAttempt).
 */
function finishGeneration(attemptId: number, short: ShortReason | null, wasTried: boolean): boolean {
  const plan = readPlan(attemptId);
  const done = (plan?.slots ?? []).filter((s) => s.state === "done" && s.question_id != null).sort((a, b) => a.n - b.n);
  const ids = ownQuestions(attemptId, done.map((s) => s.question_id!));
  if (ids.length === 0) return false;
  const retried = new Set(done.filter((s) => s.why === "retry").map((s) => s.question_id!));
  const insert = db.prepare("INSERT OR IGNORE INTO attempt_questions (attempt_id, question_id, position, option_order) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    ids.forEach((qid, i) => insert.run(attemptId, qid, i, retried.has(qid) ? JSON.stringify(shuffledOrder(qid)) : null));
    // A short exam waits two minutes before trying the rest again (resumeAttempt); after a restart it can try at once.
    db.prepare(
      `UPDATE attempts SET status = 'ready', started_at = datetime('now'), short_reason = ?, resumed_at = CASE WHEN ? THEN datetime('now') ELSE resumed_at END,
       time_limit_sec = CASE WHEN mode = 'timed' THEN ? ELSE NULL END WHERE id = ?`,
    ).run(short, short != null && wasTried ? 1 : 0, ids.length * SECONDS_PER_QUESTION, attemptId);
  })();
  return true;
}

/** Each question once (first place wins), and only the attempt's own exam's: anything else is a bug, logged and dropped. */
function ownQuestions(attemptId: number, allIds: number[]): number[] {
  if (allIds.length === 0) return [];
  const examId = (db.prepare("SELECT exam_id FROM attempts WHERE id = ?").get(attemptId) as { exam_id: number }).exam_id;
  const own = new Set(
    (db.prepare(`SELECT id FROM questions WHERE exam_id = ? AND id IN (${allIds.map(() => "?").join(",")})`).all(examId, ...allIds) as { id: number }[]).map((r) => r.id),
  );
  const out = [...new Set(allIds)].filter((id) => own.has(id));
  if (out.length < new Set(allIds).size) console.warn(`Practice exam ${attemptId}: dropped question(s) from another exam`, allIds.filter((id) => !own.has(id)));
  return out;
}

// ---- Finishing itself (docs/EXAM-PLAN.md "Finishing itself") ----

/** Her stored key and provider as a short hash: what "her key changed" is measured against. Never the key. */
function keyMark(examId: number): string {
  const u = db.prepare("SELECT u.provider, u.api_key_enc FROM users u JOIN exams e ON e.user_id = u.id WHERE e.id = ?").get(examId) as
    | { provider: string | null; api_key_enc: string | null }
    | undefined;
  return crypto
    .createHash("sha256")
    .update(`${u?.provider ?? ""}\n${u?.api_key_enc ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function rememberKey(attemptId: number, examId: number) {
  updateOptions(attemptId, (o) => ({ ...o, keyMark: keyMark(examId) }));
}

/** Resumes running now, one per attempt. */
const resuming = new Map<number, Promise<void>>();

/** Whether the missing questions of this attempt are being written right now. */
export const isResuming = (attemptId: number) => resuming.has(attemptId);

/**
 * How long a short exam waits between tries, and how long one stopped by her key waits when the key is unchanged. A
 * resume that writes nothing doubles the wait (2, 4, 8 … minutes, at most an hour: options_json `busyWait`), so a
 * service that stays down, or a key error worded in a way isKeyProblem does not know, is not tried every two minutes.
 */
export const RESUME_SPACING_SEC = 120;
export const MAX_RESUME_SPACING_SEC = 60 * 60;
export const KEY_RETRY_SEC = 30 * 60;

/**
 * Write the planned questions an exam is still missing, and add them at its end. Only for an exam that is ready,
 * not finished, planned (exams from before plans are never resumed) and missing some; at most once every two minutes
 * (by resumed_at); after a key problem, once her key or provider has changed (at once), or 30 minutes have passed. Never
 * twice at once for one exam, and never changes a question already in it. A timed exam gets SECONDS_PER_QUESTION
 * more per question added. Returns whether writing started (it runs in the background).
 */
export function resumeAttempt(attemptId: number): boolean {
  if (resuming.has(attemptId)) return false;
  try {
    return startResume(attemptId);
  } catch (err) {
    // Opening the exam never fails over this.
    console.error(`Practice exam ${attemptId}: could not check for missing questions`, err);
    return false;
  }
}

function startResume(attemptId: number): boolean {
  const a = db
    .prepare(
      `SELECT exam_id, status, slots_json, options_json, short_reason,
              CASE WHEN resumed_at IS NULL THEN NULL ELSE strftime('%s','now') - strftime('%s', resumed_at) END AS since
       FROM attempts WHERE id = ?`,
    )
    .get(attemptId) as { exam_id: number; status: string; slots_json: string | null; options_json: string | null; short_reason: string | null; since: number | null } | undefined;
  if (!a || a.status !== "ready") return false;
  const opts = parseOptions(a.options_json);
  if (!opts || !parsePlan(a.slots_json)) return false;
  // Planned questions of a removed lecture are dropped before anything else (no AI call: done on every open).
  const plan = dropGone(attemptId);
  if (!plan) return false;
  const open = openSlots(plan);
  if (open.length === 0) {
    if (a.short_reason) db.prepare("UPDATE attempts SET short_reason = NULL WHERE id = ?").run(attemptId);
    return false;
  }
  // Her key: not before she changed it (then at once), or half an hour passed. Anything else: two minutes apart, more
  // after resumes that wrote nothing.
  const waited = (sec: number) => a.since == null || a.since >= sec;
  if (a.short_reason === "key" ? opts.keyMark === keyMark(a.exam_id) && !waited(KEY_RETRY_SEC) : !waited(busyWait(opts))) return false;

  db.prepare("UPDATE attempts SET resumed_at = datetime('now') WHERE id = ?").run(attemptId);
  const run = newRun(attemptId, a.exam_id);
  const work = queued(a.exam_id, async () => {
    try {
      // Read again: it may have waited behind another exam of this course, and she may have finished it meanwhile.
      const now = readPlan(attemptId);
      const status = (db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId) as { status: string } | undefined)?.status;
      if (!now || status !== "ready") return;
      const ns = new Set(openSlots(now).map((s) => s.n));
      await writeSlots(run, now, opts, ns);
      appendWritten(attemptId, ns, run);
    } catch (err) {
      console.error(`Practice exam ${attemptId}: writing the missing questions failed`, err);
    }
    // The wait before the next try counts from the end of this one, so a slow resume is not followed at once by another.
    db.prepare("UPDATE attempts SET resumed_at = datetime('now') WHERE id = ?").run(attemptId);
  }).finally(() => resuming.delete(attemptId));
  resuming.set(attemptId, work);
  return true;
}

/** The wait before the next resume of a short exam (not one stopped by her key). */
const busyWait = (opts: StoredOptions) =>
  Number.isFinite(opts.busyWait) ? Math.min(MAX_RESUME_SPACING_SEC, Math.max(RESUME_SPACING_SEC, opts.busyWait!)) : RESUME_SPACING_SEC;

/**
 * After a resume: the newly written questions go at the end of the exam, in plan order. Planned questions of a lecture
 * removed meanwhile are dropped. A resume that wrote nothing doubles the wait before the next; one that wrote
 * something resets it.
 */
function appendWritten(attemptId: number, ns: Set<number>, run: Run) {
  const plan = dropGone(attemptId);
  if (!plan) return;
  const fresh = plan.slots.filter((s) => ns.has(s.n) && s.state === "done" && s.question_id != null).sort((a, b) => a.n - b.n);
  const left = openSlots(plan).length;
  db.transaction(() => {
    const a = db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId) as { status: string } | undefined;
    // Finished (or gone) while writing: what was written stays in the bank for a later exam.
    if (a?.status !== "ready") return;
    const have = new Set((db.prepare("SELECT question_id FROM attempt_questions WHERE attempt_id = ?").all(attemptId) as { question_id: number }[]).map((r) => r.question_id));
    const ids = ownQuestions(attemptId, fresh.map((s) => s.question_id!)).filter((id) => !have.has(id));
    let position = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM attempt_questions WHERE attempt_id = ?").get(attemptId) as { p: number }).p;
    const insert = db.prepare("INSERT OR IGNORE INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)");
    for (const id of ids) insert.run(attemptId, id, ++position);
    db.prepare(
      "UPDATE attempts SET short_reason = ?, time_limit_sec = CASE WHEN mode = 'timed' THEN COALESCE(time_limit_sec, 0) + ? ELSE time_limit_sec END WHERE id = ?",
    ).run(left ? shortOf(run) : null, ids.length * SECONDS_PER_QUESTION, attemptId);
  })();
  if (run.stopped) rememberKey(attemptId, run.examId);
  else if (fresh.length > 0) updateOptions(attemptId, (o) => ({ ...o, busyWait: undefined }));
  else if (left > 0) updateOptions(attemptId, (o) => ({ ...o, busyWait: Math.min(MAX_RESUME_SPACING_SEC, busyWait(o) * 2) }));
}

const styleTypes = (style: Style) => (style === "recall" ? ["recall"] : style === "case" ? ["case", "image"] : ["recall", "case", "image"]);

/**
 * Questions written earlier but never answered, to use before writing new ones. Questions sitting in an exam that is
 * still open (started in the last day) are left alone, so two exams started together don't share questions.
 */
function unusedQuestions(topicId: number, style: Style, limit: number, pages: PageFilter = null): number[] {
  const types = styleTypes(style);
  const onPages = pages ? `AND q.source_page_id IN (${[...pages].map(() => "?").join(",") || "NULL"})` : "";
  return (
    db
      .prepare(
        `SELECT q.id FROM questions q WHERE q.topic_id = ? AND q.flagged = 0 AND q.case_id IS NULL AND q.type IN (${types.map(() => "?").join(",")}) ${onPages}
         AND NOT EXISTS (SELECT 1 FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id WHERE aq.question_id = q.id
           AND (aq.chosen_index IS NOT NULL OR (a.status IN ('generating', 'ready') AND a.started_at > datetime('now', '-1 day'))))
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(topicId, ...types, ...(pages ?? []), limit) as { id: number }[]
  ).map((r) => r.id);
}

/** The slides of a topic a practice exam may use (all of them, or only those from the chosen lectures). */
function pagesFor(topic: Topic, pages: PageFilter) {
  const all = topicPages(topic);
  return pages ? all.filter((p) => pages.has(p.id)) : all;
}

function unusedCases(topicId: number, limit: number, pages: PageFilter = null): number[][] {
  // Chosen lectures: every question of the case must come from their slides.
  const onPages = !pages
    ? ""
    : pages.size === 0
      ? "AND 0"
      : `AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.case_id = c.id AND (q.source_page_id IS NULL OR q.source_page_id NOT IN (${[...pages].map(() => "?").join(",")})))`;
  const caseIds = (
    db
      .prepare(
        `SELECT c.id FROM cases c WHERE EXISTS (SELECT 1 FROM questions q WHERE q.case_id = c.id AND q.topic_id = ?)
         AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.case_id = c.id AND q.flagged = 1)
         AND NOT EXISTS (SELECT 1 FROM questions q JOIN attempt_questions aq ON aq.question_id = q.id WHERE q.case_id = c.id AND aq.chosen_index IS NOT NULL)
         ${onPages}
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(topicId, ...(pages ?? []), limit) as { id: number }[]
  ).map((r) => r.id);
  return caseIds.map((id) => (db.prepare("SELECT id FROM questions WHERE case_id = ? ORDER BY id").all(id) as { id: number }[]).map((r) => r.id));
}

/**
 * Repair for exams started before 2026-10-15: whole-exam practice used to mix in questions from the student's other
 * exams. Takes those out of exams still in progress if they haven't been answered (answered ones stay as history),
 * renumbers what's left and shortens a timed exam's clock to match. Safe to run any number of times.
 */
export function dropForeignQuestions(): number {
  const rows = db
    .prepare(
      `SELECT aq.attempt_id, aq.question_id FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id JOIN questions q ON q.id = aq.question_id
       WHERE a.status IN ('generating', 'ready') AND aq.chosen_index IS NULL AND q.exam_id != a.exam_id`,
    )
    .all() as { attempt_id: number; question_id: number }[];
  if (rows.length === 0) return 0;
  db.transaction(() => {
    const del = db.prepare("DELETE FROM attempt_questions WHERE attempt_id = ? AND question_id = ?");
    for (const r of rows) del.run(r.attempt_id, r.question_id);
    for (const attemptId of new Set(rows.map((r) => r.attempt_id))) {
      const left = db.prepare("SELECT question_id FROM attempt_questions WHERE attempt_id = ? ORDER BY position").all(attemptId) as { question_id: number }[];
      const renumber = db.prepare("UPDATE attempt_questions SET position = ? WHERE attempt_id = ? AND question_id = ?");
      left.forEach((r, i) => renumber.run(i, attemptId, r.question_id));
      if (left.length === 0) {
        db.prepare("UPDATE attempts SET status = 'error', error = ? WHERE id = ?").run(
          "This practice exam had no questions left from this exam. Please start a new one.",
          attemptId,
        );
      } else {
        // A timed exam already under way keeps at least its usual time for each question still to answer (never
        // less time left than before per question, never more than it had): the clock never jumps to zero.
        const a = db
          .prepare("SELECT mode, time_limit_sec, MAX(0, strftime('%s','now') - strftime('%s', started_at)) AS used FROM attempts WHERE id = ?")
          .get(attemptId) as { mode: string; time_limit_sec: number | null; used: number };
        const open = (db.prepare("SELECT COUNT(*) n FROM attempt_questions WHERE attempt_id = ? AND chosen_index IS NULL").get(attemptId) as { n: number }).n;
        const fair = Math.max(left.length * SECONDS_PER_QUESTION, a.used + open * SECONDS_PER_QUESTION);
        const limit = a.mode === "timed" ? Math.min(a.time_limit_sec ?? fair, fair) : null;
        db.prepare("UPDATE attempts SET time_limit_sec = ? WHERE id = ?").run(limit, attemptId);
      }
    }
  })();
  return rows.length;
}

/**
 * Record one answer. `chosen` is the option as displayed (retried questions show their options shuffled).
 * Updates concept mastery and queues missed questions for review.
 */
export function answerQuestion(attemptId: number, questionId: number, chosen: number, confidence: Confidence | null = null) {
  const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId) as Question;
  const row = db
    .prepare("SELECT chosen_index, option_order, reported FROM attempt_questions WHERE attempt_id = ? AND question_id = ?")
    .get(attemptId, questionId) as { chosen_index: number | null; option_order: string | null; reported: number } | undefined;
  if (!row || row.chosen_index != null || row.reported) return; // already answered, or reported out of the exam
  const optionCount = (JSON.parse(q.options) as string[]).length;
  if (!Number.isInteger(chosen) || chosen < 0 || chosen >= optionCount) return;
  const order = row.option_order ? (JSON.parse(row.option_order) as number[]) : null;
  const original = order ? order[chosen] : chosen;
  if (original == null) return;
  const correct = original === q.correct_index;
  db.prepare("UPDATE attempt_questions SET chosen_index = ?, correct = ?, confidence = ? WHERE attempt_id = ? AND question_id = ?").run(
    original,
    correct ? 1 : 0,
    confidence,
    attemptId,
    questionId,
  );
  recordConceptResult(q.concept_id, correct);
  if (!correct) addReviewCard(questionId);
}

/**
 * Report a question from inside a practice exam: it leaves this attempt and its score (15 questions, one reported, 8
 * right → 8/14), is flagged everywhere like a report from the review page, and the owner gets the record. A finished
 * exam's stored score is recomputed too, so "8/14" is what the results page and the history show.
 */
export function reportAttemptQuestion(userId: number, attemptId: number, questionId: number, reason: string | null): boolean {
  return db.transaction(() => {
    const row = db.prepare("SELECT reported FROM attempt_questions WHERE attempt_id = ? AND question_id = ?").get(attemptId, questionId) as { reported: number } | undefined;
    if (!row || row.reported) return false;
    db.prepare("UPDATE attempt_questions SET reported = 1 WHERE attempt_id = ? AND question_id = ?").run(attemptId, questionId);
    flagQuestionEverywhere(questionId, reason);
    saveQuestionReport(userId, questionId, "practice", reason);
    const a = db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId) as { status: string };
    if (a.status === "finished") db.prepare("UPDATE attempts SET score = ? WHERE id = ?").run(attemptScore(attemptId), attemptId);
    return true;
  })();
}

/**
 * The owner's record of a reported practice question (its text, key, notes and where it came from), shared by the
 * report from inside an exam and the one from the review page or an old results page.
 */
export function saveQuestionReport(userId: number, questionId: number, source: "practice" | "review", reason: string | null) {
  const q = db
    .prepare(
      `SELECT q.id, q.exam_id, q.topic_id, q.stem, q.options, q.correct_index, q.explanation, q.option_notes, q.source_page_id, c.name AS concept, e.name AS exam
       FROM questions q JOIN exams e ON e.id = q.exam_id LEFT JOIN concepts c ON c.id = q.concept_id WHERE q.id = ?`,
    )
    .get(questionId) as
    | { id: number; exam_id: number; topic_id: number | null; stem: string; options: string; correct_index: number; explanation: string; option_notes: string | null; source_page_id: number | null; concept: string | null; exam: string }
    | undefined;
  if (!q) return;
  saveReportedQuestion({
    userId,
    examId: q.exam_id,
    topicId: q.topic_id,
    source,
    ref: `question:${q.id}`,
    question: {
      question: q.stem,
      options: JSON.parse(q.options) as string[],
      correct_index: q.correct_index,
      explanation: q.explanation,
      option_notes: q.option_notes ? (JSON.parse(q.option_notes) as string[]) : null,
      concept: q.concept,
      ...slideOrigin(q.source_page_id, q.topic_id),
      exam: q.exam,
    },
    reason,
  });
}

/** Right answers over the questions that count (reported ones don't); 0 when none count. */
function attemptScore(attemptId: number): number {
  const stats = db
    .prepare("SELECT COUNT(*) total, SUM(correct) n_right FROM attempt_questions WHERE attempt_id = ? AND reported = 0")
    .get(attemptId) as { total: number; n_right: number | null };
  return stats.total ? (stats.n_right ?? 0) / stats.total : 0;
}

export function finishAttempt(attemptId: number) {
  db.prepare("UPDATE attempts SET status = 'finished', finished_at = datetime('now'), score = ? WHERE id = ?").run(attemptScore(attemptId), attemptId);
  // Started from the study plan: tick that task off.
  db.prepare(
    "UPDATE plan_tasks SET status = 'done', completed_at = datetime('now') WHERE id = (SELECT task_id FROM attempts WHERE id = ?) AND status = 'todo'",
  ).run(attemptId);
}

// ---- Spaced repetition (student-level, survives across exams) ----

const scheduler = fsrs();

export function addReviewCard(questionId: number) {
  const card = createEmptyCard(new Date(Date.now() + 12 * 3600 * 1000));
  db.prepare("INSERT OR IGNORE INTO review_cards (question_id, card_json, due) VALUES (?, ?, ?)").run(
    questionId,
    JSON.stringify(card),
    card.due.toISOString(),
  );
}

const DUE_FROM = `FROM review_cards r JOIN questions q ON q.id = r.question_id JOIN exams e ON e.id = q.exam_id
  WHERE e.user_id = ? AND r.due <= ? AND q.flagged = 0`;

export function dueCards(userId: number, limit: number) {
  return db
    .prepare(`SELECT r.id AS card_id, q.* ${DUE_FROM} ORDER BY r.due LIMIT ?`)
    .all(userId, new Date().toISOString(), limit) as (Question & { card_id: number })[];
}

export function countDue(userId: number): number {
  return (db.prepare(`SELECT COUNT(*) n ${DUE_FROM}`).get(userId, new Date().toISOString()) as { n: number }).n;
}

/** When a review card would come back for each rating, shown under the Hard / Good / Easy buttons. */
export function nextReviewDates(cardId: number): { hard: string; good: string; easy: string } {
  const row = db.prepare("SELECT card_json FROM review_cards WHERE id = ?").get(cardId) as { card_json: string };
  const log = scheduler.repeat(JSON.parse(row.card_json) as Card, new Date());
  return {
    hard: log[Rating.Hard].card.due.toISOString(),
    good: log[Rating.Good].card.due.toISOString(),
    easy: log[Rating.Easy].card.due.toISOString(),
  };
}

export function reviewCard(cardId: number, correct: boolean, confidence: "hard" | "good" | "easy") {
  const row = db.prepare("SELECT * FROM review_cards WHERE id = ?").get(cardId) as { card_json: string; question_id: number };
  const card = JSON.parse(row.card_json) as Card;
  const grade: Grade = !correct ? Rating.Again : confidence === "hard" ? Rating.Hard : confidence === "easy" ? Rating.Easy : Rating.Good;
  const next = scheduler.next(card, new Date(), grade).card;
  db.prepare("UPDATE review_cards SET card_json = ?, due = ? WHERE id = ?").run(JSON.stringify(next), next.due.toISOString(), cardId);
  const q = db.prepare("SELECT concept_id FROM questions WHERE id = ?").get(row.question_id) as { concept_id: number | null };
  recordConceptResult(q.concept_id, correct);
}
