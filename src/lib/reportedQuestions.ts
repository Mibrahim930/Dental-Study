// Questions students reported with the Report button (section quizzes, practice exams, daily review, "Quiz me",
// lecture reviews). Each one is stored in its own table and as a JSON file under FILES_DIR/reported-questions/, and
// listed on the owner's Admin page with a "download all" link, so the owner (and whoever maintains the site) can see
// what kind of question keeps going wrong. Removing the question from the quiz it was in, and from its score, is
// each surface's own job (see the report routes); this module only keeps the record.
import fs from "fs";
import path from "path";
import { db, FILES_DIR } from "./db";
import { normStem } from "./quizPlan";
import { examFamily } from "./quizProgress";

export const REPORT_REASON_MAX = 500;
export const REPORT_SOURCES = ["quiz", "practice", "review", "quizme", "lecture_review"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

db.exec(`
CREATE TABLE IF NOT EXISTS reported_questions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
  topic_id INTEGER,                                -- the section the question tests (not a foreign key: maps get rebuilt)
  source TEXT NOT NULL,                            -- quiz | practice | review | quizme | lecture_review
  ref TEXT NOT NULL,                               -- where it came from: "quiz:<topic>:<question id>", "question:<id>", "quizme:<id>:<index>"
  question_json TEXT NOT NULL,                     -- the question as the student saw it (see ReportedQuestion)
  reason TEXT,                                     -- the optional one-liner from the report dialog
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS reported_questions_topic ON reported_questions(topic_id);`);

/** The question as it was shown, plus where it came from, so a report reads on its own. */
export type ReportedQuestion = {
  question: string;
  options: string[];
  correct_index: number | null;
  explanation?: string | null;
  option_notes?: string[] | null;
  concept?: string | null;
  /** The slide it was written from, when known. */
  lecture?: string | null;
  slide?: number | null;
  section?: string | null;
  exam?: string | null;
};

export type ReportedRow = {
  id: number;
  user_id: number;
  email: string;
  exam_id: number | null;
  topic_id: number | null;
  source: ReportSource;
  ref: string;
  question: ReportedQuestion;
  reason: string | null;
  created_at: string;
};

/** A reason as typed in the dialog: trimmed, one line, capped; null when empty. */
export function cleanReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const r = reason.replace(/\s+/g, " ").trim().slice(0, REPORT_REASON_MAX).trim();
  return r || null;
}

/** The lecture name, slide number and section title of a slide, for the record (nulls when the slide is gone). */
export function slideOrigin(pageId: number | null | undefined, topicId?: number | null): { lecture: string | null; slide: number | null; section: string | null } {
  const page = pageId
    ? (db.prepare("SELECT p.page_number, d.filename FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?").get(pageId) as
        | { page_number: number; filename: string }
        | undefined)
    : undefined;
  const topic = topicId ? (db.prepare("SELECT title FROM topics WHERE id = ?").get(topicId) as { title: string } | undefined) : undefined;
  return { lecture: page?.filename.replace(/\.pdf$/i, "") ?? null, slide: page?.page_number ?? null, section: topic?.title ?? null };
}

/** Stores one report (table + JSON file). Returns its id. A failed file write never loses the record. */
export function saveReportedQuestion(input: {
  userId: number;
  examId: number | null;
  topicId: number | null;
  source: ReportSource;
  ref: string;
  question: ReportedQuestion;
  reason: string | null;
}): number {
  const id = Number(
    db
      .prepare("INSERT INTO reported_questions (user_id, exam_id, topic_id, source, ref, question_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.userId, input.examId, input.topicId, input.source, input.ref, JSON.stringify(input.question), input.reason).lastInsertRowid,
  );
  try {
    const dir = path.join(FILES_DIR, "reported-questions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...input, created_at: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error(`Reported question ${id}: couldn't write its file`, err);
  }
  return id;
}

/** Every report, newest first, with who sent it. */
export function listReportedQuestions(limit = 500): ReportedRow[] {
  const rows = db
    .prepare("SELECT r.*, u.email FROM reported_questions r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?")
    .all(limit) as (Omit<ReportedRow, "question"> & { question_json: string })[];
  return rows.map(({ question_json, ...r }) => ({ ...r, question: parseQuestion(question_json) }));
}

function parseQuestion(json: string): ReportedQuestion {
  try {
    const q = JSON.parse(json) as ReportedQuestion;
    return { ...q, options: Array.isArray(q.options) ? q.options : [] };
  } catch {
    return { question: "(unreadable)", options: [], correct_index: null };
  }
}

/**
 * The stems of questions reported on a section (own copy or any class copy of the same exam), for the writers to
 * steer clear of next time that section's questions are written. Capped so the prompt stays short.
 */
export function reportedStems(topicId: number, limit = 12): string[] {
  const topic = db.prepare("SELECT exam_id, title FROM topics WHERE id = ?").get(topicId) as { exam_id: number; title: string } | undefined;
  if (!topic) return [];
  // The same section in every copy of the exam (copies keep section titles).
  const family = examFamily(topic.exam_id);
  const topicIds = (
    db.prepare(`SELECT id FROM topics WHERE exam_id IN (${family.map(() => "?").join(",")}) AND title = ?`).all(...family, topic.title) as { id: number }[]
  ).map((t) => t.id);
  if (!topicIds.includes(topicId)) topicIds.push(topicId);
  const rows = db
    .prepare(`SELECT question_json FROM reported_questions WHERE topic_id IN (${topicIds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`)
    .all(...topicIds, limit * 10) as { question_json: string }[];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const q = parseQuestion(r.question_json).question.replace(/\s+/g, " ").trim();
    const key = normStem(q);
    if (!key || q === "(unreadable)" || seen.has(key)) continue;
    seen.add(key);
    out.push(q.slice(0, 200));
  }
  return out;
}
