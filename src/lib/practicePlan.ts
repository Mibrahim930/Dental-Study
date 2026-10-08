// Deciding what goes into a new practice exam: which earlier questions come back, which topics get more questions,
// and what the AI should avoid repeating. Pure database logic (no AI calls), so it can be tested directly.
import { db, type Topic } from "./db";
import { mastery, type ConceptRow } from "./memory";

export type Confidence = "guess" | "unsure" | "sure";
export const CONFIDENCE: Confidence[] = ["guess", "unsure", "sure"];

/** Missed questions may fill at most this share of a new exam, so the rest of the material is still covered. */
export const RETRY_SHARE = 0.4;

export type Scope = { kind: "all" } | { kind: "lectures"; documentIds: number[] } | { kind: "topics"; topicIds: number[] };

/** The topics a practice exam draws from. An empty list means the whole exam. */
export function scopeTopicIds(examId: number, scope: Scope): number[] {
  if (scope.kind === "topics") {
    const valid = new Set((db.prepare("SELECT id FROM topics WHERE exam_id = ?").all(examId) as { id: number }[]).map((t) => t.id));
    return scope.topicIds.filter((id) => valid.has(id));
  }
  if (scope.kind === "lectures") {
    if (scope.documentIds.length === 0) return [];
    // A topic belongs to a lecture if any of its slides come from that lecture's PDF.
    const pageIds = new Set(
      (
        db
          .prepare(`SELECT p.id FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ? AND d.id IN (${scope.documentIds.map(() => "?").join(",")})`)
          .all(examId, ...scope.documentIds) as { id: number }[]
      ).map((p) => p.id),
    );
    const topics = db.prepare("SELECT id, page_ids FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Pick<Topic, "id" | "page_ids">[];
    return topics.filter((t) => (JSON.parse(t.page_ids) as number[]).some((id) => pageIds.has(id))).map((t) => t.id);
  }
  return [];
}

type Result = {
  question_id: number;
  attempt_id: number;
  correct: number;
  confidence: Confidence | null;
  topic_id: number | null;
  case_id: number | null;
  stem: string;
  source_page_id: number | null;
  concept: string | null;
};

/** The most recent practice answer to each question asked in this exam's practice exams. */
function latestResults(examId: number): Result[] {
  const rows = db
    .prepare(
      `SELECT aq.question_id, aq.attempt_id, aq.correct, aq.confidence, q.topic_id, q.case_id, q.stem, q.source_page_id, c.name AS concept
       FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id JOIN questions q ON q.id = aq.question_id
       LEFT JOIN concepts c ON c.id = q.concept_id
       WHERE a.exam_id = ? AND aq.chosen_index IS NOT NULL AND q.flagged = 0
       ORDER BY aq.attempt_id`,
    )
    .all(examId) as Result[];
  const latest = new Map<number, Result>();
  for (const r of rows) latest.set(r.question_id, r);
  return [...latest.values()];
}

const inScope = (topicIds: number[]) => (r: { topic_id: number | null }) => topicIds.length === 0 || (r.topic_id != null && topicIds.includes(r.topic_id));

/**
 * Questions to ask again: answered wrong last time and not answered right since. Most recent misses first.
 * Board-style case questions only come back in case-set exams, as whole cases (see retryCases).
 */
export function retryQuestions(examId: number, topicIds: number[], limit: number): number[] {
  if (limit <= 0) return [];
  return latestResults(examId)
    .filter((r) => r.correct === 0 && r.case_id == null)
    .filter(inScope(topicIds))
    .sort((a, b) => b.attempt_id - a.attempt_id)
    .slice(0, limit)
    .map((r) => r.question_id);
}

/** Whole cases with a question that was answered wrong last time, as question-id groups in case order. */
export function retryCases(examId: number, topicIds: number[], limit: number): number[][] {
  if (limit <= 0) return [];
  const caseIds = [
    ...new Set(
      latestResults(examId)
        .filter((r) => r.correct === 0 && r.case_id != null)
        .filter(inScope(topicIds))
        .sort((a, b) => b.attempt_id - a.attempt_id)
        .map((r) => r.case_id!),
    ),
  ].slice(0, limit);
  return caseIds.map((id) => (db.prepare("SELECT id FROM questions WHERE case_id = ? AND flagged = 0 ORDER BY id").all(id) as { id: number }[]).map((r) => r.id));
}

export type FocusPoint = { concept: string | null; source_page_id: number | null; stem: string; why: "missed" | "unsure" };

/** Weak spots per topic: questions missed, or answered right but marked guessed/unsure, on the latest try. */
export function focusPoints(examId: number, topicIds: number[]): Map<number, FocusPoint[]> {
  const out = new Map<number, FocusPoint[]>();
  for (const r of latestResults(examId).filter(inScope(topicIds))) {
    if (r.topic_id == null) continue;
    const why = r.correct === 0 ? "missed" : r.confidence === "guess" || r.confidence === "unsure" ? "unsure" : null;
    if (!why) continue;
    const list = out.get(r.topic_id) ?? [];
    list.push({ concept: r.concept, source_page_id: r.source_page_id, stem: r.stem, why });
    out.set(r.topic_id, list);
  }
  return out;
}

/** What the student will see come back in the next exam over this scope (for the start form). */
export function pendingCounts(examId: number, topicIds: number[] = []): { missed: number; unsure: number } {
  const results = latestResults(examId).filter(inScope(topicIds));
  return {
    missed: results.filter((r) => r.correct === 0).length,
    unsure: results.filter((r) => r.correct === 1 && (r.confidence === "guess" || r.confidence === "unsure")).length,
  };
}

/**
 * How many new questions each topic gets.
 * Focus on: weak topics (low mastery, recent misses and unsure answers) get more.
 * Focus off: spread by topic size so the whole lecture gets covered evenly.
 * Lecture-emphasized topics get a little more either way.
 */
export function allocate(topics: Topic[], total: number, focus: Map<number, FocusPoint[]> | null): { topic: Topic; count: number }[] {
  if (topics.length === 0 || total <= 0) return [];
  const weights = topics.map((t) => {
    const slides = Math.max(1, (JSON.parse(t.page_ids) as number[]).length);
    const emphasis = t.emphasized ? 1.5 : 1;
    if (!focus) return emphasis * slides;
    const concepts = db
      .prepare("SELECT c.attempts, c.correct FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?")
      .all(t.id) as ConceptRow[];
    const ms = concepts.map(mastery).filter((m): m is number => m != null);
    const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0.5;
    return emphasis * (1.5 - avg) * Math.sqrt(slides) * (1 + (focus.get(t.id)?.length ?? 0) / 3);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const alloc = topics.map((topic, i) => {
    const exact = (weights[i] / sum) * total;
    return { topic, count: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - alloc.reduce((a, b) => a + b.count, 0);
  for (const a of [...alloc].sort((x, y) => y.rem - x.rem)) {
    if (left-- <= 0) break;
    a.count++;
  }
  return alloc.filter((a) => a.count > 0).map(({ topic, count }) => ({ topic, count }));
}

/** Questions already written for a topic, newest first, so the AI can be told not to repeat them. */
export function askedStems(topicId: number, limit = 60): string[] {
  return (db.prepare("SELECT stem FROM questions WHERE topic_id = ? AND case_id IS NULL ORDER BY id DESC LIMIT ?").all(topicId, limit) as { stem: string }[]).map(
    (r) => (r.stem.length > 160 ? r.stem.slice(0, 157) + "…" : r.stem),
  );
}

/** How many questions have been written from each slide of a topic. */
export function slideCoverage(topicId: number): Map<number, number> {
  const rows = db
    .prepare("SELECT source_page_id AS id, COUNT(*) AS n FROM questions WHERE topic_id = ? AND source_page_id IS NOT NULL GROUP BY source_page_id")
    .all(topicId) as { id: number; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** A random display order for a retried question's options, so the answer's letter can't be remembered. */
export function shuffledOrder(questionId: number): number[] {
  const { options } = db.prepare("SELECT options FROM questions WHERE id = ?").get(questionId) as { options: string };
  const order = (JSON.parse(options) as string[]).map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
