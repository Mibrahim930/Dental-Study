// "Quiz me on this": the student highlights a passage while studying (lesson, key points, explanations, tutor replies)
// and gets 3, 5 or 10 questions about exactly that, written from the slides that match it. Stored, so an unfinished
// quiz can be resumed; answers count toward concept mastery like the section quiz. Self-contained: creates its own
// table on first use.
import { z } from "zod";
import { db, type PageRow, type Topic } from "./db";
import { generate } from "./ai";
import { credentials } from "./credentials";
import { recordConceptResult, upsertConcept } from "./memory";
import { checkedAnswer, isValidChoice, shuffle } from "./practicePlan";
import { normStem } from "./quizPlan";
import { EXAM_STYLE } from "./examStyle";
import { markPictures, mentionsPicture, pictureFor, pictureForIds, PICTURE_RULES, type Picture } from "./questionImage";
import { slideNotesText, topicPages } from "./study";

export const QUIZME_SIZES = [3, 5, 10] as const;
export const QUIZME_MIN_CHARS = 20;
export const QUIZME_MAX_CHARS = 2000;
/** Slides found by searching the exam for the highlighted words (on top of the current section's slides). */
export const QUIZME_SEARCH_HITS = 6;

db.exec(`
CREATE TABLE IF NOT EXISTS quizme (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  topic_id INTEGER,                                -- the section she was studying, when known (not a foreign key: maps get rebuilt)
  text TEXT NOT NULL,                              -- what she highlighted
  size INTEGER NOT NULL,                           -- 3, 5 or 10 asked for (questions_json may hold fewer)
  questions_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,                      -- chosen option index per question, null until answered
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS quizme_open ON quizme(user_id, exam_id, finished_at);`);

/** A bad request: the message is plain and safe to show the student (the routes answer 400 with it). */
export class QuizMeError extends Error {}

/** One stored question. Options are already shuffled; option_notes (when present) follow the same order. */
export type QuizMeQuestion = {
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  /** One sentence per option: why it's right / why it's wrong. Null when the writer's list didn't match the options. */
  option_notes: string[] | null;
  concept: string;
  source_page_id: number | null;
  image_page_id: number | null;
};

/** What the browser gets for a question. The key, explanation and notes only once it's answered. */
export type QuizMeQuestionView = {
  question: string;
  options: string[];
  image: Picture | null;
  /** Its picture's slide is gone (lecture removed): skipped, like a reported section-quiz question. */
  hidden?: boolean;
  chosen: number | null;
  correct_index?: number;
  explanation?: string;
  option_notes?: string[] | null;
};

export type QuizMeView = {
  id: number;
  examId: number;
  topicId: number | null;
  text: string;
  size: number;
  questions: QuizMeQuestionView[];
  answers: (number | null)[];
  /** Questions still to answer (hidden ones don't count). */
  left: number;
  finished: boolean;
};

type Row = {
  id: number;
  user_id: number;
  exam_id: number;
  topic_id: number | null;
  text: string;
  size: number;
  questions_json: string;
  answers_json: string;
  created_at: string;
  finished_at: string | null;
};

const QuizMeOut = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()).describe("4 answer choices, no letter prefixes"),
      correct_index: z.number().describe("0-based index of the correct option"),
      correct_answer: z.string().describe("The correct option, copied exactly as written in options"),
      explanation: z.string().describe("Why it's right and why the most tempting wrong answer is wrong. Cite the slide as (Lecture, slide N) when one is given"),
      option_notes: z
        .array(z.string())
        .describe("One short sentence per option, in the same order as options: for the correct one why it is right, for each wrong one why it is wrong"),
      concept: z.string().describe("The concept tested; use one of the listed concept names when one fits"),
      source_page_id: z.number().nullable().describe("The [P…] id of the slide this question tests, or null if no slide covers it"),
      image_page_id: z
        .number()
        .nullable()
        .describe("Only when the question refers to a picture: the [P…] id of a slide marked [IMAGE] or [IMAGE-CASE] whose picture the student will see. Otherwise null"),
    }),
  ),
});

const SYSTEM = `You write a short quiz for a dental student on a passage she highlighted while studying ("quiz me on this").
- Every question tests something the highlighted passage says or directly implies. Use the slides to get the facts, the wording and the distractors right, and set source_page_id to the slide that covers it.
- Single best answer, 4 options. Exactly one option is defensibly correct from the slides (or, if no slide covers it, from standard dental teaching).
- Each question tests a different fact or takes a clearly different angle (recall, application, a short clinical vignette, "which is NOT"). Never write the same question twice. If the passage holds fewer facts than questions asked for, take different angles on the same facts rather than repeating one.
- Don't test citations, authors, years or slide numbers.
- The explanation says why the answer is right and why the most tempting wrong answer is wrong, and cites the slide as (Lecture, slide N).
- option_notes: one short sentence for every option, in the same order as options.
- ${PICTURE_RULES}

${EXAM_STYLE}`;

const STOPWORDS = new Set(
  "the and for with that this what why how are was were from have has had not but can you your which when who will would should could does did into about there their them then than also its it's".split(
    " ",
  ),
);

/** Slides of one exam that match the words, best first (full-text search, like the tutor's library search). */
export function searchExamPages(userId: number, examId: number, text: string, limit = QUIZME_SEARCH_HITS): number[] {
  const terms = text
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((t) => !STOPWORDS.has(t));
  if (!terms?.length) return [];
  const match = [...new Set(terms)]
    .slice(0, 60)
    .map((t) => `"${t}"`)
    .join(" OR ");
  return (
    db
      .prepare(
        `SELECT f.page_id FROM pages_fts f JOIN pages p ON p.id = f.page_id JOIN documents d ON d.id = p.document_id JOIN exams e ON e.id = d.exam_id
         WHERE pages_fts MATCH ? AND e.id = ? AND e.user_id = ? ORDER BY rank LIMIT ?`,
      )
      .all(match, examId, userId, limit) as { page_id: number }[]
  ).map((r) => Number(r.page_id));
}

type SlidePage = PageRow & { filename: string };

function pagesById(ids: number[]): SlidePage[] {
  if (ids.length === 0) return [];
  return db
    .prepare(`SELECT p.*, d.filename FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id IN (${ids.map(() => "?").join(",")}) ORDER BY d.id, p.page_number`)
    .all(...ids) as SlidePage[];
}

/** The slides a quiz is written from: the current section's, then the exam's best search hits (no repeats). */
export function quizMeSlides(userId: number, examId: number, topic: Topic | null, text: string): SlidePage[] {
  const own = topic ? topicPages(topic) : [];
  const have = new Set(own.map((p) => p.id));
  const hits = searchExamPages(userId, examId, text).filter((id) => !have.has(id));
  return [...own, ...pagesById(hits)];
}

/** Concept names already used for this exam (the writer reuses them so mastery adds up). */
function examConceptNames(examId: number): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT c.name FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id JOIN topics t ON t.id = tc.topic_id WHERE t.exam_id = ? ORDER BY c.name LIMIT 150`,
      )
      .all(examId) as { name: string }[]
  ).map((r) => r.name);
}

const inflight = new Set<number>();

/** One quiz is written at a time per student (a second tap on "Start" while the first is writing is refused). */
export function quizMeBusy(userId: number): boolean {
  return inflight.has(userId);
}

/**
 * Write and store a "quiz me" quiz: `size` questions (3, 5 or 10) about the highlighted text, from the current
 * section's slides plus the exam's slides that match it. One writer call on the quality tier, no checking pass (it's
 * short and on demand); questions whose key doesn't check out, duplicates, and picture questions without a picture
 * are dropped, so a quiz can come out a little shorter than asked.
 */
export async function createQuizMe(input: { userId: number; examId: number; topicId?: number | null; text: string; size: number }): Promise<QuizMeView> {
  const { userId, examId, size } = input;
  if (!(QUIZME_SIZES as readonly number[]).includes(size)) throw new QuizMeError("Pick 3, 5 or 10 questions.");
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (text.length < QUIZME_MIN_CHARS) throw new QuizMeError("Highlight a little more, a sentence or so, to be quizzed on it.");
  if (text.length > QUIZME_MAX_CHARS) throw new QuizMeError(`That's a lot of text. Highlight up to a paragraph or two (${QUIZME_MAX_CHARS} characters).`);
  const exam = db.prepare("SELECT id FROM exams WHERE id = ? AND user_id = ?").get(examId, userId);
  if (!exam) throw new QuizMeError("That exam wasn't found.");
  let topic: Topic | null = null;
  if (input.topicId != null) {
    topic = (db.prepare("SELECT * FROM topics WHERE id = ? AND exam_id = ?").get(input.topicId, examId) as Topic | undefined) ?? null;
    if (!topic) throw new QuizMeError("That section wasn't found. Reload the page and try again.");
  }
  if (inflight.has(userId)) throw new QuizMeError("Already writing a quiz for you. Give it a minute.");
  inflight.add(userId);
  try {
    const pages = quizMeSlides(userId, examId, topic, text);
    const valid = new Set(pages.map((p) => p.id));
    const concepts = examConceptNames(examId);
    const out = await generate({
      creds: credentials(userId),
      purpose: "quiz me",
      tier: "quality",
      schema: QuizMeOut,
      effort: "medium",
      maxTokens: 12000,
      system: SYSTEM,
      content: [
        `The student highlighted this and asked to be quizzed on it:\n"""\n${text}\n"""`,
        topic ? `She was studying the section: ${topic.title}` : "",
        `Concept names: ${concepts.join("; ") || "none"}`,
        pages.length ? `Slides:\n${markPictures(slideNotesText(pages), pages)}` : "No slides match this passage; write from the passage and standard dental teaching, and set source_page_id to null.",
        `Write exactly ${size} questions.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });

    const seen = new Set<string>();
    const questions: QuizMeQuestion[] = [];
    for (const q of out.questions) {
      if (questions.length >= size) break;
      const correct = checkedAnswer(q.options, q.correct_index, q.correct_answer);
      if (!isValidChoice(q.options, correct)) continue;
      const key = normStem(q.question);
      if (!key || seen.has(key)) continue;
      // The slide it tests must be one it was given; otherwise it was written from the passage alone.
      const page = q.source_page_id != null && valid.has(q.source_page_id) ? q.source_page_id : null;
      // A question that talks about a picture must have one to show ("generous": attaching a slide costs little).
      const wantsPicture = q.image_page_id != null || mentionsPicture(q.question, "generous");
      const picture = wantsPicture ? pictureFor(pages, q.image_page_id != null && valid.has(q.image_page_id) ? q.image_page_id : null, page, q.question) : null;
      if (wantsPicture && !picture) continue;
      seen.add(key);
      const notes = Array.isArray(q.option_notes) && q.option_notes.length === q.options.length && q.option_notes.every((n) => typeof n === "string" && n.trim()) ? q.option_notes : null;
      // Shuffle so the answer isn't biased to one position; the notes move with their options.
      const order = shuffle(q.options.map((_, i) => i));
      questions.push({
        question: q.question,
        options: order.map((i) => q.options[i]),
        correct_index: order.indexOf(correct),
        explanation: q.explanation,
        option_notes: notes ? order.map((i) => notes[i]) : null,
        concept: q.concept?.trim() ?? "",
        source_page_id: page,
        image_page_id: picture?.page_id ?? null,
      });
    }
    if (questions.length === 0) throw new Error("The writer returned no usable questions.");

    const id = db.transaction(() => {
      const newId = Number(
        db
          .prepare("INSERT INTO quizme (user_id, exam_id, topic_id, text, size, questions_json, answers_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(userId, examId, topic?.id ?? null, text, size, JSON.stringify(questions), JSON.stringify(questions.map(() => null))).lastInsertRowid,
      );
      // Concepts tested on this section's own slides count toward the section's mastery, like the section quiz.
      if (topic) {
        const own = new Set(JSON.parse(topic.page_ids) as number[]);
        const link = db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");
        for (const q of questions) if (q.concept && q.source_page_id != null && own.has(q.source_page_id)) link.run(topic.id, upsertConcept(userId, q.concept));
      }
      return newId;
    })();
    return getQuizMe(userId, id)!;
  } finally {
    inflight.delete(userId);
  }
}

function rowOf(userId: number, id: number): Row | undefined {
  if (!Number.isInteger(id)) return undefined;
  return db.prepare("SELECT * FROM quizme WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
}

function parse(row: Row): { questions: QuizMeQuestion[]; answers: (number | null)[] } {
  const questions = JSON.parse(row.questions_json) as QuizMeQuestion[];
  const stored = JSON.parse(row.answers_json) as (number | null)[];
  return { questions, answers: questions.map((_, i) => (Number.isInteger(stored[i]) ? stored[i] : null)) };
}

function view(row: Row): QuizMeView {
  const { questions, answers } = parse(row);
  const shown: QuizMeQuestionView[] = questions.map((q, i) => {
    const image = q.image_page_id != null ? pictureForIds(q.image_page_id, null) : null;
    const chosen = answers[i];
    const base: QuizMeQuestionView = { question: q.question, options: q.options, image, chosen };
    if (q.image_page_id != null && !image) base.hidden = true;
    if (chosen != null) Object.assign(base, { correct_index: q.correct_index, explanation: q.explanation, option_notes: q.option_notes });
    return base;
  });
  const left = shown.filter((q) => !q.hidden && q.chosen == null).length;
  return { id: row.id, examId: row.exam_id, topicId: row.topic_id, text: row.text, size: row.size, questions: shown, answers, left, finished: row.finished_at != null || left === 0 };
}

/** A stored quiz, for its owner only (null for anyone else). */
export function getQuizMe(userId: number, id: number): QuizMeView | null {
  const row = rowOf(userId, id);
  return row ? view(row) : null;
}

/** The newest unfinished quiz for this exam, to resume; null if there is none. */
export function openQuizMe(userId: number, examId: number): QuizMeView | null {
  const row = db.prepare("SELECT * FROM quizme WHERE user_id = ? AND exam_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1").get(userId, examId) as Row | undefined;
  if (!row) return null;
  const v = view(row);
  // Every question left was skipped (its picture's slide is gone): nothing to resume.
  if (v.left === 0) {
    db.prepare("UPDATE quizme SET finished_at = datetime('now') WHERE id = ? AND finished_at IS NULL").run(row.id);
    return null;
  }
  return v;
}

export type QuizMeAnswer = {
  /** The answer that stands (the first one given). */
  chosen: number;
  correct: boolean;
  correct_index: number;
  explanation: string;
  option_notes: string[] | null;
  finished: boolean;
  /** True when this question had been answered already (the first answer stands; nothing was recorded again). */
  already?: boolean;
};

/**
 * Record one answer. Correctness is decided here. The first answer to a question stands; a second one (another tab,
 * a double tap) changes nothing and gets the first one's result back. Null when the quiz isn't this student's.
 */
export function answerQuizMe(input: { userId: number; id: number; index: number; chosen: number }): QuizMeAnswer | null {
  const { userId, id, index, chosen } = input;
  return db.transaction((): QuizMeAnswer | null => {
    const row = rowOf(userId, id);
    if (!row) return null;
    const { questions, answers } = parse(row);
    const q = Number.isInteger(index) && index >= 0 ? questions[index] : undefined;
    if (!q) throw new QuizMeError("Unknown question or answer");
    const result = (pick: number, already?: boolean): QuizMeAnswer => ({
      chosen: pick,
      correct: pick === q.correct_index,
      correct_index: q.correct_index,
      explanation: q.explanation,
      option_notes: q.option_notes,
      finished: false,
      ...(already ? { already: true } : {}),
    });
    if (answers[index] != null) return { ...result(answers[index]!, true), finished: row.finished_at != null };
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= q.options.length) throw new QuizMeError("Unknown question or answer");

    answers[index] = chosen;
    const correct = chosen === q.correct_index;
    // Finished once every question that can still be shown is answered.
    const finished = view({ ...row, answers_json: JSON.stringify(answers) }).left === 0;
    db.prepare(`UPDATE quizme SET answers_json = ?${finished ? ", finished_at = datetime('now')" : ""} WHERE id = ?`).run(JSON.stringify(answers), id);
    if (q.concept?.trim()) recordConceptResult(upsertConcept(userId, q.concept), correct);
    return { ...result(chosen), finished };
  })();
}
