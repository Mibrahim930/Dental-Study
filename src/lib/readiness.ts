// Numbers behind the progress rings: how ready a student is for an exam, and how a practice score compares.
import { db, type Topic } from "./db";
import { mastery, type ConceptRow } from "./memory";

export type ExamProgress = {
  /** Average mastery of the exam's concepts that have been tested (null if none tested yet). */
  mastery: number | null;
  /** Share of the exam's topics opened in a study session. */
  studied: number;
  /** Overall readiness: each topic counts its concept mastery (0.5 if studied but untested), 0 if not studied yet. */
  readiness: number;
  topics: number;
};

export function examProgress(userId: number, examId: number): ExamProgress {
  const topics = db.prepare("SELECT id FROM topics WHERE exam_id = ?").all(examId) as Pick<Topic, "id">[];
  if (topics.length === 0) return { mastery: null, studied: 0, readiness: 0, topics: 0 };
  const studied = new Set(
    (db.prepare("SELECT topic_id FROM topic_study WHERE user_id = ? AND topic_id IN (SELECT id FROM topics WHERE exam_id = ?)").all(userId, examId) as {
      topic_id: number;
    }[]).map((r) => r.topic_id),
  );
  const conceptsOf = db.prepare("SELECT c.attempts, c.correct FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?");
  const all: number[] = [];
  let readiness = 0;
  for (const t of topics) {
    const ms = (conceptsOf.all(t.id) as ConceptRow[]).map(mastery).filter((m): m is number => m != null);
    all.push(...ms);
    const topicMastery = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
    if (studied.has(t.id) || topicMastery != null) readiness += topicMastery ?? 0.5;
  }
  return {
    mastery: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null,
    studied: studied.size / topics.length,
    readiness: readiness / topics.length,
    topics: topics.length,
  };
}

/** How this finished practice exam compares with the previous one and the best one for the same exam. */
export function scoreContext(attemptId: number): { previous: number | null; best: boolean } {
  const a = db.prepare("SELECT exam_id, score FROM attempts WHERE id = ?").get(attemptId) as { exam_id: number; score: number | null } | undefined;
  if (!a || a.score == null) return { previous: null, best: false };
  const earlier = db
    .prepare("SELECT score FROM attempts WHERE exam_id = ? AND status = 'finished' AND score IS NOT NULL AND id < ? ORDER BY id DESC")
    .all(a.exam_id, attemptId) as { score: number }[];
  return {
    previous: earlier[0]?.score ?? null,
    best: earlier.length > 0 && earlier.every((e) => a.score! > e.score),
  };
}

/** A friendly first name from the account email ("lolo.smith@…" → "Lolo"), or null if it doesn't look like a name. */
export function firstName(email: string): string | null {
  const part = email.split("@")[0].split(/[._\-+]/)[0].replace(/\d+$/, "");
  return /^[a-z]{2,12}$/i.test(part) ? part[0].toUpperCase() + part.slice(1).toLowerCase() : null;
}
