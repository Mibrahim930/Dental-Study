import { z } from "zod";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { db, type Question, type Topic } from "./db";
import { generate, mapLimit } from "./ai";
import { parseNotes } from "./processing";
import { slideNotesText, topicPages } from "./study";
import { mastery, recordConceptResult, upsertConcept, weakConcepts, type ConceptRow } from "./memory";

export type Style = "mixed" | "recall" | "case";
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
export function startAttempt(examId: number, opts: { size: number; mode: Mode; style: Style; topicIds?: number[] }) {
  const attemptId = Number(
    db
      .prepare("INSERT INTO attempts (exam_id, mode, time_limit_sec) VALUES (?, ?, ?)")
      .run(examId, opts.mode, opts.mode === "timed" ? opts.size * SECONDS_PER_QUESTION : null).lastInsertRowid,
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
  const weak = weakConcepts(5, examId);
  const pastTopics = weak.length
    ? (db
        .prepare(
          `SELECT DISTINCT t.* FROM topics t JOIN topic_concepts tc ON tc.topic_id = t.id
           WHERE tc.concept_id IN (${weak.map(() => "?").join(",")}) AND t.exam_id != ? LIMIT 3`,
        )
        .all(...weak.map((c) => c.id), examId) as Topic[])
    : [];
  const pastCount = pastTopics.length ? Math.max(1, Math.round(opts.size * 0.12)) : 0;
  const plan = [...allocate(topics, opts.size - pastCount), ...allocate(pastTopics, pastCount)];

  const created: number[] = [];
  await mapLimit(plan, 4, async ({ topic, count }) => {
    created.push(...(await generateForTopic(topic, count, opts.style)));
  });
  if (created.length === 0) throw new Error("No questions could be generated.");

  // Interleave topics so the exam doesn't run topic by topic.
  const shuffled = created.sort(() => Math.random() - 0.5);
  const insert = db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)");
  db.transaction(() => {
    shuffled.forEach((qid, i) => insert.run(attemptId, qid, i));
    db.prepare("UPDATE attempts SET status = 'ready', started_at = datetime('now'), time_limit_sec = CASE WHEN mode = 'timed' THEN ? ELSE NULL END WHERE id = ?").run(
      shuffled.length * SECONDS_PER_QUESTION,
      attemptId,
    );
  })();
}

async function generateForTopic(topic: Topic, count: number, style: Style): Promise<number[]> {
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
          upsertConcept(q.concept),
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
    .prepare("SELECT COUNT(*) total, SUM(correct) right FROM attempt_questions WHERE attempt_id = ?")
    .get(attemptId) as { total: number; right: number | null };
  db.prepare("UPDATE attempts SET status = 'finished', finished_at = datetime('now'), score = ? WHERE id = ?").run(
    stats.total ? (stats.right ?? 0) / stats.total : 0,
    attemptId,
  );
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

export function dueCards(limit: number) {
  return db
    .prepare(
      `SELECT r.id AS card_id, q.* FROM review_cards r JOIN questions q ON q.id = r.question_id
       WHERE r.due <= ? AND q.flagged = 0 ORDER BY r.due LIMIT ?`,
    )
    .all(new Date().toISOString(), limit) as (Question & { card_id: number })[];
}

export function countDue(): number {
  return (db.prepare("SELECT COUNT(*) n FROM review_cards r JOIN questions q ON q.id = r.question_id WHERE r.due <= ? AND q.flagged = 0").get(
    new Date().toISOString(),
  ) as { n: number }).n;
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
