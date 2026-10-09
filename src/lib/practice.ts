import { z } from "zod";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { db, type Question, type Topic } from "./db";
import { generate, mapLimit } from "./ai";
import { parseNotes } from "./processing";
import { slideNotesText, topicPages } from "./study";
import { recordConceptResult, upsertConcept, weakConcepts } from "./memory";
import {
  allocate,
  askedStems,
  focusPoints,
  retryCases,
  retryQuestions,
  RETRY_SHARE,
  isValidChoice,
  lastPracticed,
  shuffledOrder,
  slideCoverage,
  type Confidence,
  type FocusPoint,
} from "./practicePlan";
import { credentials } from "./credentials";
import { examOwner } from "./db";

export type Style = "mixed" | "recall" | "case" | "caseset";
export type Mode = "tutor" | "timed";
export const SECONDS_PER_QUESTION = 72;

const GeneratedQuestions = z.object({
  questions: z.array(
    z.object({
      type: z.enum(["recall", "case", "image"]),
      image_page_id: z
        .number()
        .nullable()
        .describe("For type=image: the ID of the [IMAGE-CASE] slide whose clinical image the question shows. Otherwise null"),
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
      explanation: z.string().describe("Why the answer is correct and briefly why the main distractors are wrong. Cite the slide"),
      source_page_id: z.number().describe("ID of the slide this question is based on"),
      concept: z.string().describe("The concept tested; use one of the listed concept names"),
    }),
  ),
});

const SYSTEM = `You write board-quality practice questions for a dental student, based strictly on their lecture slides.
- Single best answer, 5 options, plausible distractors of similar length. No "all/none of the above".
- type=recall: a direct question testing one fact or relationship.
- type=case: INBDE style. Fill patient_box with a realistic patient (chief complaint, medical history, medications, allergies, dental history, findings), then ask about diagnosis, next step, or treatment.
- type=image: only for slides marked [IMAGE-CASE]. The student will see only the clinical image from that slide (radiograph/photo), not its text. Write the stem to describe the scenario without giving away the answer.
- Prioritize slides marked ★IMPORTANT or with annotations. Do not test trivia like citations or years.
- Every fact in the question and explanation must be supported by the slides.`;

type AttemptOptions = { size: number; mode: Mode; style: Style; topicIds?: number[]; taskId?: number; adaptive?: boolean };

/** Create an attempt and generate its questions in the background. Returns the attempt id. */
export function startAttempt(examId: number, opts: AttemptOptions) {
  // "Focus on my weak spots" defaults to the student's saved preference.
  const adaptive =
    opts.adaptive ??
    !!(db.prepare("SELECT u.focus_weak FROM users u JOIN exams e ON e.user_id = u.id WHERE e.id = ?").get(examId) as { focus_weak: number } | undefined)?.focus_weak;
  const attemptId = Number(
    db
      .prepare("INSERT INTO attempts (exam_id, mode, time_limit_sec, task_id, adaptive) VALUES (?, ?, ?, ?, ?)")
      .run(examId, opts.mode, opts.mode === "timed" ? opts.size * SECONDS_PER_QUESTION : null, opts.taskId ?? null, adaptive ? 1 : 0).lastInsertRowid,
  );
  // Exams for the same course are built one after another, so two started together never pick the same questions.
  const previous = buildQueue.get(examId) ?? Promise.resolve();
  const build = previous
    .then(() => generateAttempt(attemptId, examId, { ...opts, adaptive }))
    .catch((err) => {
      db.prepare("UPDATE attempts SET status = 'error', error = ? WHERE id = ?").run(String(err), attemptId);
    });
  buildQueue.set(examId, build);
  void build.finally(() => {
    if (buildQueue.get(examId) === build) buildQueue.delete(examId);
  });
  return attemptId;
}

const buildQueue = new Map<number, Promise<void>>();

/**
 * What goes into a practice exam:
 * - Questions missed last time come back (never within the same exam), up to RETRY_SHARE of it, with shuffled options.
 * - Everything else is new: questions answered before never repeat, and the AI is shown what was already asked.
 * - Focus on: weak topics get more of the new questions, aimed at what was missed or answered unsure.
 *   Focus off: new questions are spread evenly over the chosen material.
 */
async function generateAttempt(attemptId: number, examId: number, opts: AttemptOptions & { adaptive: boolean }) {
  let topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
  const scoped = !!opts.topicIds?.length;
  if (scoped) topics = topics.filter((t) => opts.topicIds!.includes(t.id));
  if (topics.length === 0) throw new Error("This exam has no topics yet. Upload lectures and wait for the topic map.");
  const topicIds = topics.map((t) => t.id);
  const focus = opts.adaptive ? focusPoints(examId, topicIds) : null;

  if (opts.style === "caseset") {
    const caseCount = Math.max(1, Math.round(opts.size / 4));
    const retried = retryCases(examId, topicIds, Math.max(1, Math.floor(caseCount * RETRY_SHARE)), { wholeExam: !scoped });
    const newCases = Math.max(1, caseCount - retried.length);
    savePlan(attemptId, { style: opts.style, cases: newCases + retried.length, retried: retried.flat().length, fresh: newCases, topics: topics.length });
    // Always at least one new case, so even a short exam isn't only retries.
    const fresh = await buildCaseSets(topics, newCases, focus, { last: lastPracticed(examId), covered: topicsOf(retried.flat()) });
    // Shuffle the order of cases, but keep each case's questions together and in order.
    const groups = [...retried, ...fresh].sort(() => Math.random() - 0.5);
    return finishGeneration(attemptId, groups.flat(), new Set(retried.flat()));
  }

  const retried = pickRetries(examId, topics, opts.size, { types: styleTypes(opts.style), wholeExam: !scoped });
  const covered = topicsOf(retried);
  const uncovered = topics.filter((t) => !covered.has(t.id)).length;

  // With focus on and the whole exam chosen, ~12% of new questions revisit weak concepts from earlier exams (shared memory),
  // but only when that still leaves room for one question per section of this exam.
  const weak = opts.adaptive && !scoped ? weakConcepts(examOwner(examId), 5, examId) : [];
  const pastTopics = weak.length
    ? (db
        .prepare(
          `SELECT DISTINCT t.* FROM topics t JOIN topic_concepts tc ON tc.topic_id = t.id
           WHERE tc.concept_id IN (${weak.map(() => "?").join(",")}) AND t.exam_id != ? LIMIT 3`,
        )
        .all(...weak.map((c) => c.id), examId) as Topic[])
    : [];
  const fresh = opts.size - retried.length;
  const wantedPast = pastTopics.length ? Math.max(1, Math.round(fresh * 0.12)) : 0;
  const pastCount = fresh - wantedPast >= uncovered ? wantedPast : 0;
  // Every section of the chosen material gets a question; missed questions coming back already cover theirs.
  const coverage = { last: lastPracticed(examId), covered };
  const plan = [...allocate(topics, fresh - pastCount, focus, coverage), ...allocate(pastTopics, pastCount, null)];
  savePlan(attemptId, { style: opts.style, size: opts.size, retried: retried.length, fresh, topics: topics.length });

  const created = new Set<number>();
  const failed: unknown[] = [];
  const worked = new Set<number>();
  const write = async ({ topic, count }: { topic: Topic; count: number }) => {
    const before = created.size;
    try {
      // Reuse questions written earlier that were never answered (abandoned or skipped exams); only write new ones for the rest.
      const reused = unusedQuestions(topic.id, opts.style, count).filter((id) => !created.has(id));
      reused.forEach((id) => created.add(id));
      if (count - reused.length > 0) {
        for (const id of await generateForTopic(topic, count - reused.length, opts.style, focus?.get(topic.id) ?? [])) created.add(id);
      }
      // Only sections that delivered everything asked of them are used to fill any shortfall.
      if (created.size - before >= count) worked.add(topic.id);
    } catch (err) {
      // One section failing shouldn't sink the exam; it stays unpractised, so it leads the next one.
      failed.push(err);
    }
  };
  await mapLimit(plan, 4, write);

  // Fill any shortfall (a section failed, or the AI wrote fewer than asked) from the sections that worked.
  const shortfall = opts.size - retried.length - created.size;
  const working = plan.filter((p) => worked.has(p.topic.id)).map((p) => p.topic);
  if (shortfall > 0 && working.length) await mapLimit(allocate(working, shortfall, focus), 4, write);

  if (created.size + retried.length === 0) throw failed[0] instanceof Error ? failed[0] : new Error("No questions could be generated.");

  // Interleave topics so the exam doesn't run topic by topic.
  finishGeneration(attemptId, [...retried, ...created].sort(() => Math.random() - 0.5), new Set(retried));
}

/**
 * Missed questions to bring back: most recent first, spread over as many sections as possible, capped at
 * RETRY_SHARE of the exam and never so many that a section of the chosen material would be left without a question.
 */
function pickRetries(examId: number, topics: Topic[], size: number, opts: { types: string[]; wholeExam: boolean }): number[] {
  const candidates = retryQuestions(examId, topics.map((t) => t.id), 1000, opts);
  if (candidates.length === 0) return [];
  const topicOf = new Map(
    (db.prepare(`SELECT id, topic_id FROM questions WHERE id IN (${candidates.map(() => "?").join(",")})`).all(...candidates) as { id: number; topic_id: number | null }[]).map(
      (r) => [r.id, r.topic_id],
    ),
  );
  const seen = new Set<number | null>();
  const firstPerTopic = candidates.filter((id) => !seen.has(topicOf.get(id) ?? null) && (seen.add(topicOf.get(id) ?? null), true));
  const ordered = [...firstPerTopic, ...candidates.filter((id) => !firstPerTopic.includes(id))];
  const picked = ordered.slice(0, Math.floor(size * RETRY_SHARE));
  const inScope = new Set(topics.map((t) => t.id));
  const uncoveredWith = (ids: number[]) => {
    const cov = new Set(ids.map((id) => topicOf.get(id)).filter((t): t is number => t != null && inScope.has(t)));
    return topics.length - cov.size;
  };
  while (picked.length > 0 && size - picked.length < uncoveredWith(picked)) picked.pop();
  return picked;
}

/** What the exam is being built from, so the loading screen can show real steps while the AI writes. */
export type AttemptPlan = { style: Style; size?: number; cases?: number; retried: number; fresh: number; topics: number };
function savePlan(attemptId: number, plan: AttemptPlan) {
  db.prepare("UPDATE attempts SET plan_json = ? WHERE id = ?").run(JSON.stringify(plan), attemptId);
}

/** The topics a set of questions belongs to. */
function topicsOf(questionIds: number[]): Set<number> {
  if (questionIds.length === 0) return new Set();
  return new Set(
    (db.prepare(`SELECT DISTINCT topic_id FROM questions WHERE topic_id IS NOT NULL AND id IN (${questionIds.map(() => "?").join(",")})`).all(...questionIds) as {
      topic_id: number;
    }[]).map((r) => r.topic_id),
  );
}

function finishGeneration(attemptId: number, questionIds: number[], retried: Set<number>) {
  if (questionIds.length === 0) throw new Error("No questions could be generated.");
  const insert = db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, option_order) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    questionIds.forEach((qid, i) => insert.run(attemptId, qid, i, retried.has(qid) ? JSON.stringify(shuffledOrder(qid)) : null));
    db.prepare("UPDATE attempts SET status = 'ready', started_at = datetime('now'), time_limit_sec = CASE WHEN mode = 'timed' THEN ? ELSE NULL END WHERE id = ?").run(
      questionIds.length * SECONDS_PER_QUESTION,
      attemptId,
    );
  })();
}

const styleTypes = (style: Style) => (style === "recall" ? ["recall"] : style === "case" ? ["case", "image"] : ["recall", "case", "image"]);

/**
 * Questions written earlier but never answered, to use before writing new ones. Questions sitting in an exam that is
 * still open (started in the last day) are left alone, so two exams started together don't share questions.
 */
function unusedQuestions(topicId: number, style: Style, limit: number): number[] {
  const types = styleTypes(style);
  return (
    db
      .prepare(
        `SELECT q.id FROM questions q WHERE q.topic_id = ? AND q.flagged = 0 AND q.case_id IS NULL AND q.type IN (${types.map(() => "?").join(",")})
         AND NOT EXISTS (SELECT 1 FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id WHERE aq.question_id = q.id
           AND (aq.chosen_index IS NOT NULL OR (a.status IN ('generating', 'ready') AND a.started_at > datetime('now', '-1 day'))))
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(topicId, ...types, limit) as { id: number }[]
  ).map((r) => r.id);
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
            stem: z.string(),
            options: z.array(z.string()).describe("Exactly 5 answer choices, no letter prefixes"),
            correct_index: z.number().describe("0-based index of the correct option"),
            explanation: z.string().describe("Why the answer is correct and why the main distractors are wrong. Cite the slide"),
            source_page_id: z.number().describe("ID of the slide this question is based on"),
            concept: z.string().describe("The concept tested; use one of the listed concept names"),
          }),
        )
        .describe("3-5 questions about this same patient"),
    }),
  ),
});

const CASE_SYSTEM = `You write INBDE-style case sets for a dental student, based strictly on their lecture slides.
Each case is one realistic patient (patient box: age/sex, chief complaint, medical history, medications, allergies, dental history, findings)
followed by 3-5 single-best-answer questions about that same patient that build on each other, for example:
diagnosis → what test or finding confirms it → emergency/definitive treatment → prognosis, complication or follow-up.
- 5 options per question, plausible distractors, no "all/none of the above".
- The scenario and patient box must not give away answers. Later questions may reveal what earlier ones asked.
- If an [IMAGE-CASE] slide fits the patient, set image_page_id; the student sees only its clinical image.
- Prioritize slides marked ★IMPORTANT or with annotations. Every fact must be supported by the slides.`;

/** New case sets for an attempt: reuses never-answered cases first. Returns question ids, grouped by case. */
async function buildCaseSets(
  topics: Topic[],
  caseCount: number,
  focus: Map<number, FocusPoint[]> | null,
  coverage: Parameters<typeof allocate>[3],
): Promise<number[][]> {
  const groups: number[][] = [];
  let lastError: unknown = null;
  await mapLimit(allocate(topics, caseCount, focus, coverage), 3, async ({ topic, count }) => {
    const reused = unusedCases(topic.id, count);
    groups.push(...reused);
    try {
      if (count > reused.length) groups.push(...(await generateCases(topic, count - reused.length, focus?.get(topic.id) ?? [])));
    } catch (err) {
      // One section failing shouldn't sink the exam; it stays unpractised, so it leads the next one.
      if (groups.length === 0) lastError = err;
    }
  });
  if (groups.length === 0 && lastError) throw lastError;
  return groups;
}

function unusedCases(topicId: number, limit: number): number[][] {
  const caseIds = (
    db
      .prepare(
        `SELECT c.id FROM cases c WHERE EXISTS (SELECT 1 FROM questions q WHERE q.case_id = c.id AND q.topic_id = ?)
         AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.case_id = c.id AND q.flagged = 1)
         AND NOT EXISTS (SELECT 1 FROM questions q JOIN attempt_questions aq ON aq.question_id = q.id WHERE q.case_id = c.id AND aq.chosen_index IS NOT NULL)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(topicId, limit) as { id: number }[]
  ).map((r) => r.id);
  return caseIds.map((id) => (db.prepare("SELECT id FROM questions WHERE case_id = ? ORDER BY id").all(id) as { id: number }[]).map((r) => r.id));
}

async function generateCases(topic: Topic, count: number, focus: FocusPoint[]): Promise<number[][]> {
  const userId = examOwner(topic.exam_id);
  const pages = topicPages(topic);
  const imageIds = new Set(pages.filter((p) => parseNotes(p)?.case_image_box).map((p) => p.id));
  const concepts = (
    db.prepare("SELECT c.name FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?").all(topic.id) as { name: string }[]
  ).map((c) => c.name);
  const notes = markCoverage(slideNotesText(pages), topic.id).replace(/\[P(\d+)\]/g, (m, id) => (imageIds.has(Number(id)) ? `${m} [IMAGE-CASE]` : m));
  const usedPatients = (
    db.prepare("SELECT scenario FROM cases WHERE id IN (SELECT case_id FROM questions WHERE topic_id = ?) ORDER BY id DESC LIMIT 30").all(topic.id) as {
      scenario: string;
    }[]
  ).map((c) => `- ${c.scenario.slice(0, 200)}`);

  const out = await generate({
    creds: credentials(userId),
    purpose: "case sets",
    schema: GeneratedCases,
    system: CASE_SYSTEM,
    effort: "medium",
    maxTokens: 32000,
    content: `Topic: ${topic.title}\nConcept names: ${concepts.join("; ")}\n\nWrite ${count} case set${count === 1 ? "" : "s"}.${
      usedPatients.length
        ? `\n\nCases already used for this topic. Write different patients and, where the slides allow, a different diagnosis or problem:\n${usedPatients.join("\n")}`
        : ""
    }${focusText(focus)}\n\nSlides:\n${notes}`,
  });

  const valid = new Set(pages.map((p) => p.id));
  const insertCase = db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, ?, ?, ?)");
  const insertQ = db.prepare(
    `INSERT INTO questions (exam_id, topic_id, concept_id, type, patient_box, stem, options, correct_index, explanation, source_page_id, image_page_id, case_id)
     VALUES (?, ?, ?, 'case', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const groups: number[][] = [];
  for (const c of out.cases.slice(0, count)) {
    const qs = c.questions.filter((q) => isValidChoice(q.options, q.correct_index));
    if (qs.length === 0) continue;
    const image = c.image_page_id != null && imageIds.has(c.image_page_id) ? c.image_page_id : null;
    const box = JSON.stringify(c.patient_box);
    const caseId = Number(insertCase.run(topic.exam_id, c.scenario, box, image).lastInsertRowid);
    groups.push(
      qs.map((q) => {
        const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
        return Number(
          insertQ.run(
            topic.exam_id,
            topic.id,
            upsertConcept(userId, q.concept),
            box,
            q.stem,
            JSON.stringify(order.map((i) => q.options[i])),
            order.indexOf(q.correct_index),
            q.explanation,
            valid.has(q.source_page_id) ? q.source_page_id : null,
            image,
            caseId,
          ).lastInsertRowid,
        );
      }),
    );
  }
  return groups;
}

async function generateForTopic(topic: Topic, count: number, style: Style, focus: FocusPoint[]): Promise<number[]> {
  const userId = examOwner(topic.exam_id);
  const pages = topicPages(topic);
  const imageCases = pages.filter((p) => parseNotes(p)?.case_image_box);
  const concepts = (
    db.prepare("SELECT c.name FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?").all(topic.id) as {
      name: string;
    }[]
  ).map((c) => c.name);

  const mix =
    style === "recall"
      ? `all ${count} type=recall`
      : style === "case"
        ? `mostly type=case${imageCases.length ? ", plus type=image where an [IMAGE-CASE] slide fits" : ""}, at most 1 recall`
        : `a mix: about 60% recall, 25% case${imageCases.length ? ", 15% image" : ""}`;

  const notes = markCoverage(slideNotesText(pages), topic.id).replace(/\[P(\d+)\]/g, (m, id) =>
    imageCases.some((p) => p.id === Number(id)) ? `${m} [IMAGE-CASE]` : m,
  );
  const asked = askedStems(topic.id);

  const out = await generate({
    creds: credentials(userId),
    purpose: "practice questions",
    schema: GeneratedQuestions,
    system: SYSTEM,
    effort: "medium",
    maxTokens: 32000,
    content: `Topic: ${topic.title}\nConcept names: ${concepts.join("; ")}\n\nWrite ${count} questions: ${mix}.${
      asked.length
        ? `\n\nQuestions the student has already had on this topic. Do not repeat them or write close variants; test other facts and slides:\n${asked.map((a) => `- ${a}`).join("\n")}`
        : ""
    }${focusText(focus)}\n\nSlides:\n${notes}`,
  });

  const valid = new Set(pages.map((p) => p.id));
  const imageIds = new Set(imageCases.map((p) => p.id));
  const insert = db.prepare(
    `INSERT INTO questions (exam_id, topic_id, concept_id, type, patient_box, stem, options, correct_index, explanation, source_page_id, image_page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Drop anything the AI wrote that repeats an existing question on this topic word for word.
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const seen = new Set(
    (db.prepare("SELECT stem FROM questions WHERE topic_id = ? AND case_id IS NULL").all(topic.id) as { stem: string }[]).map((r) => norm(r.stem)),
  );
  const ids: number[] = [];
  for (const q of out.questions.slice(0, count)) {
    if (!isValidChoice(q.options, q.correct_index)) continue;
    if (seen.has(norm(q.stem))) continue;
    seen.add(norm(q.stem));
    const imagePage = q.type === "image" && q.image_page_id != null && imageIds.has(q.image_page_id) ? q.image_page_id : null;
    const type = q.type === "image" && !imagePage ? (q.patient_box ? "case" : "recall") : q.type;
    // Shuffle options so the correct answer isn't biased to one position.
    const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
    const options = order.map((i) => q.options[i]);
    const correct = order.indexOf(q.correct_index);
    ids.push(
      Number(
        insert.run(
          topic.exam_id,
          topic.id,
          upsertConcept(userId, q.concept),
          type,
          q.patient_box ? JSON.stringify(q.patient_box) : null,
          q.stem,
          JSON.stringify(options),
          correct,
          q.explanation,
          valid.has(q.source_page_id) ? q.source_page_id : null,
          imagePage,
        ).lastInsertRowid,
      ),
    );
  }
  return ids;
}

/** Tag slides that already have questions, e.g. "[P12] (asked 3x)", so the AI favours untested slides. */
function markCoverage(notes: string, topicId: number): string {
  const coverage = slideCoverage(topicId);
  if (coverage.size === 0) return notes;
  const marked = notes.replace(/\[P(\d+)\]/g, (m, id) => (coverage.has(Number(id)) ? `${m} (asked ${coverage.get(Number(id))}x)` : m));
  return `Slides marked (asked Nx) already have questions; favour slides without that mark.\n\n${marked}`;
}

/** Prompt section asking for new questions on what the student missed or wasn't sure about. */
function focusText(focus: FocusPoint[]): string {
  if (focus.length === 0) return "";
  const lines = focus
    .slice(0, 12)
    .map(
      (f) =>
        `- ${f.why === "missed" ? "Missed" : "Unsure"}: ${f.concept ?? "concept"}${f.source_page_id ? ` (slide P${f.source_page_id})` : ""}. Earlier question: "${f.stem.slice(0, 160)}"`,
    );
  return `\n\nThe student missed or wasn't sure about these. Aim about half of the new questions at these same ideas from a different angle (new stem, scenario or options; not a reworded copy), and spread the rest over the topic:\n${lines.join("\n")}`;
}

/**
 * Record one answer. `chosen` is the option as displayed (retried questions show their options shuffled).
 * Updates concept mastery and queues missed questions for review.
 */
export function answerQuestion(attemptId: number, questionId: number, chosen: number, confidence: Confidence | null = null) {
  const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId) as Question;
  const row = db
    .prepare("SELECT chosen_index, option_order FROM attempt_questions WHERE attempt_id = ? AND question_id = ?")
    .get(attemptId, questionId) as { chosen_index: number | null; option_order: string | null } | undefined;
  if (!row || row.chosen_index != null) return; // already answered
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

export function finishAttempt(attemptId: number) {
  const stats = db
    .prepare("SELECT COUNT(*) total, SUM(correct) n_right FROM attempt_questions WHERE attempt_id = ?")
    .get(attemptId) as { total: number; n_right: number | null };
  db.prepare("UPDATE attempts SET status = 'finished', finished_at = datetime('now'), score = ? WHERE id = ?").run(
    stats.total ? (stats.n_right ?? 0) / stats.total : 0,
    attemptId,
  );
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
