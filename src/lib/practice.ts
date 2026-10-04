import { z } from "zod";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { db, type Question, type Topic } from "./db";
import { generate, mapLimit } from "./ai";
import { parseNotes } from "./processing";
import { slideNotesText, topicPages } from "./study";
import { mastery, recordConceptResult, upsertConcept, weakConcepts, type ConceptRow } from "./memory";
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

type Allocation = { topic: Topic; count: number };

/** Create an attempt and generate its questions in the background. Returns the attempt id. */
export function startAttempt(examId: number, opts: { size: number; mode: Mode; style: Style; topicIds?: number[]; taskId?: number }) {
  const attemptId = Number(
    db
      .prepare("INSERT INTO attempts (exam_id, mode, time_limit_sec, task_id) VALUES (?, ?, ?, ?)")
      .run(examId, opts.mode, opts.mode === "timed" ? opts.size * SECONDS_PER_QUESTION : null, opts.taskId ?? null).lastInsertRowid,
  );
  void generateAttempt(attemptId, examId, opts).catch((err) => {
    db.prepare("UPDATE attempts SET status = 'error', error = ? WHERE id = ?").run(String(err), attemptId);
  });
  return attemptId;
}

function topicWeight(topic: Topic): number {
  const concepts = db
    .prepare("SELECT c.attempts, c.correct FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?")
    .all(topic.id) as ConceptRow[];
  const ms = concepts.map(mastery).filter((m): m is number => m != null);
  const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0.5;
  return (topic.emphasized ? 1.5 : 1) * (1.5 - avg) * Math.sqrt(JSON.parse(topic.page_ids).length);
}

function allocate(topics: Topic[], total: number): Allocation[] {
  if (topics.length === 0 || total === 0) return [];
  const weights = topics.map(topicWeight);
  const sum = weights.reduce((a, b) => a + b, 0);
  const alloc = topics.map((topic, i) => ({ topic, count: Math.floor((weights[i] / sum) * total), rem: (weights[i] / sum) * total }));
  let left = total - alloc.reduce((a, b) => a + b.count, 0);
  for (const a of [...alloc].sort((x, y) => (y.rem % 1) - (x.rem % 1))) {
    if (left-- <= 0) break;
    a.count++;
  }
  return alloc.filter((a) => a.count > 0).map(({ topic, count }) => ({ topic, count }));
}

async function generateAttempt(attemptId: number, examId: number, opts: { size: number; style: Style; topicIds?: number[] }) {
  let topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
  if (opts.topicIds?.length) topics = topics.filter((t) => opts.topicIds!.includes(t.id));
  if (topics.length === 0) throw new Error("This exam has no topics yet. Upload lectures and wait for the topic map.");

  // ~12% of questions revisit weak concepts from earlier exams (shared memory).
  const weak = weakConcepts(examOwner(examId), 5, examId);
  const pastTopics = weak.length
    ? (db
        .prepare(
          `SELECT DISTINCT t.* FROM topics t JOIN topic_concepts tc ON tc.topic_id = t.id
           WHERE tc.concept_id IN (${weak.map(() => "?").join(",")}) AND t.exam_id != ? LIMIT 3`,
        )
        .all(...weak.map((c) => c.id), examId) as Topic[])
    : [];
  if (opts.style === "caseset") return finishGeneration(attemptId, await buildCaseSets(topics, opts.size));

  const pastCount = pastTopics.length ? Math.max(1, Math.round(opts.size * 0.12)) : 0;
  const plan = [...allocate(topics, opts.size - pastCount), ...allocate(pastTopics, pastCount)];

  const created: number[] = [];
  await mapLimit(plan, 4, async ({ topic, count }) => {
    // Reuse questions written earlier that were never answered (abandoned or skipped exams); only write new ones for the rest.
    const reused = unusedQuestions(topic.id, opts.style, count);
    created.push(...reused);
    if (count - reused.length > 0) created.push(...(await generateForTopic(topic, count - reused.length, opts.style)));
  });
  if (created.length === 0) throw new Error("No questions could be generated.");

  // Interleave topics so the exam doesn't run topic by topic.
  finishGeneration(attemptId, created.sort(() => Math.random() - 0.5));
}

function finishGeneration(attemptId: number, questionIds: number[]) {
  if (questionIds.length === 0) throw new Error("No questions could be generated.");
  const shuffled = questionIds;
  const insert = db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)");
  db.transaction(() => {
    shuffled.forEach((qid, i) => insert.run(attemptId, qid, i));
    db.prepare("UPDATE attempts SET status = 'ready', started_at = datetime('now'), time_limit_sec = CASE WHEN mode = 'timed' THEN ? ELSE NULL END WHERE id = ?").run(
      shuffled.length * SECONDS_PER_QUESTION,
      attemptId,
    );
  })();
}

function unusedQuestions(topicId: number, style: Style, limit: number): number[] {
  const types = style === "recall" ? ["recall"] : style === "case" ? ["case", "image"] : ["recall", "case", "image"];
  return (
    db
      .prepare(
        `SELECT q.id FROM questions q WHERE q.topic_id = ? AND q.flagged = 0 AND q.case_id IS NULL AND q.type IN (${types.map(() => "?").join(",")})
         AND NOT EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.question_id = q.id AND aq.chosen_index IS NOT NULL)
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

/** Case sets for an attempt: reuses never-answered cases first. Returns question ids, grouped by case. */
async function buildCaseSets(topics: Topic[], size: number): Promise<number[]> {
  const caseCount = Math.max(1, Math.round(size / 4));
  const groups: number[][] = [];
  await mapLimit(allocate(topics, caseCount), 3, async ({ topic, count }) => {
    const reused = unusedCases(topic.id, count);
    groups.push(...reused);
    if (count > reused.length) groups.push(...(await generateCases(topic, count - reused.length)));
  });
  // Shuffle the order of cases, but keep each case's questions together and in order.
  return groups.sort(() => Math.random() - 0.5).flat();
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

async function generateCases(topic: Topic, count: number): Promise<number[][]> {
  const userId = examOwner(topic.exam_id);
  const pages = topicPages(topic);
  const imageIds = new Set(pages.filter((p) => parseNotes(p)?.case_image_box).map((p) => p.id));
  const concepts = (
    db.prepare("SELECT c.name FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?").all(topic.id) as { name: string }[]
  ).map((c) => c.name);
  const notes = slideNotesText(pages).replace(/\[P(\d+)\]/g, (m, id) => (imageIds.has(Number(id)) ? `${m} [IMAGE-CASE]` : m));

  const out = await generate({
    creds: credentials(userId),
    purpose: "case sets",
    schema: GeneratedCases,
    system: CASE_SYSTEM,
    effort: "medium",
    maxTokens: 32000,
    content: `Topic: ${topic.title}\nConcept names: ${concepts.join("; ")}\n\nWrite ${count} case set${count === 1 ? "" : "s"}.\n\nSlides:\n${notes}`,
  });

  const valid = new Set(pages.map((p) => p.id));
  const insertCase = db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, ?, ?, ?)");
  const insertQ = db.prepare(
    `INSERT INTO questions (exam_id, topic_id, concept_id, type, patient_box, stem, options, correct_index, explanation, source_page_id, image_page_id, case_id)
     VALUES (?, ?, ?, 'case', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const groups: number[][] = [];
  for (const c of out.cases.slice(0, count)) {
    const qs = c.questions.filter((q) => q.options.length >= 2 && q.correct_index >= 0 && q.correct_index < q.options.length);
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

async function generateForTopic(topic: Topic, count: number, style: Style): Promise<number[]> {
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

  const notes = slideNotesText(pages).replace(/\[P(\d+)\]/g, (m, id) =>
    imageCases.some((p) => p.id === Number(id)) ? `${m} [IMAGE-CASE]` : m,
  );

  const out = await generate({
    creds: credentials(userId),
    purpose: "practice questions",
    schema: GeneratedQuestions,
    system: SYSTEM,
    effort: "medium",
    maxTokens: 32000,
    content: `Topic: ${topic.title}\nConcept names: ${concepts.join("; ")}\n\nWrite ${count} questions: ${mix}.\n\nSlides:\n${notes}`,
  });

  const valid = new Set(pages.map((p) => p.id));
  const imageIds = new Set(imageCases.map((p) => p.id));
  const insert = db.prepare(
    `INSERT INTO questions (exam_id, topic_id, concept_id, type, patient_box, stem, options, correct_index, explanation, source_page_id, image_page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids: number[] = [];
  for (const q of out.questions.slice(0, count)) {
    if (q.options.length < 2 || q.correct_index < 0 || q.correct_index >= q.options.length) continue;
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

/** Record one answer. Updates concept mastery and queues missed questions for review. */
export function answerQuestion(attemptId: number, questionId: number, chosen: number) {
  const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId) as Question;
  const row = db
    .prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ? AND question_id = ?")
    .get(attemptId, questionId) as { chosen_index: number | null } | undefined;
  if (!row || row.chosen_index != null) return; // already answered
  const correct = chosen === q.correct_index;
  db.prepare("UPDATE attempt_questions SET chosen_index = ?, correct = ? WHERE attempt_id = ? AND question_id = ?").run(
    chosen,
    correct ? 1 : 0,
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

export function reviewCard(cardId: number, correct: boolean, confidence: "hard" | "good" | "easy") {
  const row = db.prepare("SELECT * FROM review_cards WHERE id = ?").get(cardId) as { card_json: string; question_id: number };
  const card = JSON.parse(row.card_json) as Card;
  const grade: Grade = !correct ? Rating.Again : confidence === "hard" ? Rating.Hard : confidence === "easy" ? Rating.Easy : Rating.Good;
  const next = scheduler.next(card, new Date(), grade).card;
  db.prepare("UPDATE review_cards SET card_json = ?, due = ? WHERE id = ?").run(JSON.stringify(next), next.due.toISOString(), cardId);
  const q = db.prepare("SELECT concept_id FROM questions WHERE id = ?").get(row.question_id) as { concept_id: number | null };
  recordConceptResult(q.concept_id, correct);
}
