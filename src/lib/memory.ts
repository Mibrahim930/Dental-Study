// Student-level memory shared by every exam: concepts + mastery, the slide library, and session summaries.
import { db } from "./db";

export type ConceptRow = { id: number; name: string; attempts: number; correct: number; last_seen: string | null };

/** Smoothed accuracy, or null if the concept was never tested. */
export function mastery(c: Pick<ConceptRow, "attempts" | "correct">): number | null {
  return c.attempts === 0 ? null : (c.correct + 1) / (c.attempts + 2);
}

export function upsertConcept(userId: number, name: string): number {
  const clean = name.trim();
  db.prepare("INSERT OR IGNORE INTO concepts (user_id, name) VALUES (?, ?)").run(userId, clean);
  return (db.prepare("SELECT id FROM concepts WHERE user_id = ? AND name = ?").get(userId, clean) as { id: number }).id;
}

export function recordConceptResult(conceptId: number | null, correct: boolean) {
  if (!conceptId) return;
  db.prepare(
    "UPDATE concepts SET attempts = attempts + 1, correct = correct + ?, last_seen = datetime('now') WHERE id = ?",
  ).run(correct ? 1 : 0, conceptId);
}

export type TopicConcept = ConceptRow & { mastery: number | null; earlier_exams: string[] };

/** Concepts for one topic, with mastery and which earlier exams already covered them. */
export function topicConcepts(topicId: number, examId: number): TopicConcept[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ? ORDER BY c.name`,
    )
    .all(topicId) as ConceptRow[];
  const earlier = db.prepare(
    `SELECT DISTINCT e.name FROM exams e JOIN topics t ON t.exam_id = e.id JOIN topic_concepts tc ON tc.topic_id = t.id
     WHERE tc.concept_id = ? AND e.id != ? AND e.created_at <= (SELECT created_at FROM exams WHERE id = ?)`,
  );
  return rows.map((c) => ({
    ...c,
    mastery: mastery(c),
    earlier_exams: (earlier.all(c.id, examId, examId) as { name: string }[]).map((r) => r.name),
  }));
}

export function weakConcepts(userId: number, limit = 10, excludeExamId?: number): (ConceptRow & { mastery: number })[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM concepts c WHERE c.user_id = ? AND c.attempts > 0 ${
        excludeExamId
          ? "AND c.id NOT IN (SELECT tc.concept_id FROM topic_concepts tc JOIN topics t ON t.id = tc.topic_id WHERE t.exam_id = ?)"
          : ""
      }`,
    )
    .all(userId, ...(excludeExamId ? [excludeExamId] : [])) as ConceptRow[];
  return rows
    .map((c) => ({ ...c, mastery: mastery(c)! }))
    .filter((c) => c.mastery < 0.7)
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, limit);
}

export type LibraryHit = { page_id: number; title: string; filename: string; page_number: number; exam_name: string; snippet: string };

/** Search every slide this user ever uploaded (any exam). */
export function searchLibrary(userId: number, query: string, limit = 6, excludeExamId?: number): LibraryHit[] {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((t) => !STOPWORDS.has(t));
  if (!terms?.length) return [];
  const match = [...new Set(terms)].map((t) => `"${t}"`).join(" OR ");
  return db
    .prepare(
      `SELECT f.page_id, f.title, d.filename, p.page_number, e.name AS exam_name,
              snippet(pages_fts, 2, '', '', '…', 40) AS snippet
       FROM pages_fts f JOIN pages p ON p.id = f.page_id JOIN documents d ON d.id = p.document_id JOIN exams e ON e.id = d.exam_id
       WHERE pages_fts MATCH ? AND e.user_id = ? ${excludeExamId ? "AND e.id != ?" : ""}
       ORDER BY rank LIMIT ?`,
    )
    .all(match, userId, ...(excludeExamId ? [excludeExamId] : []), limit) as LibraryHit[];
}

/** Most recent study-session summaries across all exams (newest first). */
export function recentSummaries(userId: number, limit = 4): { exam_name: string; summary: string; ended_at: string }[] {
  return db
    .prepare(
      `SELECT e.name AS exam_name, s.summary, s.ended_at FROM study_sessions s JOIN exams e ON e.id = s.exam_id
       WHERE s.summary IS NOT NULL AND e.user_id = ? ORDER BY s.ended_at DESC LIMIT ?`,
    )
    .all(userId, limit) as { exam_name: string; summary: string; ended_at: string }[];
}

export function glossaryText(userId: number): string {
  const rows = db.prepare("SELECT abbr, meaning FROM glossary WHERE user_id = ? ORDER BY abbr").all(userId) as { abbr: string; meaning: string }[];
  return rows.map((r) => `${r.abbr} = ${r.meaning}`).join("; ");
}

const STOPWORDS = new Set(
  "the and for with that this what why how are was were from have has had not but can you your which when who will would should could does did into about there their them then than also its it's".split(
    " ",
  ),
);
