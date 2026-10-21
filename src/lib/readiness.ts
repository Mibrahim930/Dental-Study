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
  return examProgressMany(userId, [examId]).get(examId)!;
}

/** examProgress for several exams in three queries in all (the calendar shows readiness for every upcoming exam). */
export function examProgressMany(userId: number, examIds: number[]): Map<number, ExamProgress> {
  const out = new Map<number, ExamProgress>();
  const ids = [...new Set(examIds)];
  for (const id of ids) out.set(id, { mastery: null, studied: 0, readiness: 0, topics: 0 });
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const topics = db.prepare(`SELECT id, exam_id FROM topics WHERE exam_id IN (${marks}) ORDER BY id`).all(...ids) as Pick<Topic, "id" | "exam_id">[];
  if (topics.length === 0) return out;
  const studied = new Set(
    (db
      .prepare(`SELECT topic_id FROM topic_study WHERE user_id = ? AND topic_id IN (SELECT id FROM topics WHERE exam_id IN (${marks}))`)
      .all(userId, ...ids) as { topic_id: number }[]).map((r) => r.topic_id),
  );
  // Every topic's concepts in one query (not one per topic).
  const conceptsOf = new Map<number, ConceptRow[]>();
  for (const r of db
    .prepare(
      `SELECT tc.topic_id, c.attempts, c.correct FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id JOIN topics t ON t.id = tc.topic_id
       WHERE t.exam_id IN (${marks}) ORDER BY tc.topic_id, tc.concept_id`,
    )
    .all(...ids) as (ConceptRow & { topic_id: number })[]) {
    const list = conceptsOf.get(r.topic_id) ?? [];
    list.push(r);
    conceptsOf.set(r.topic_id, list);
  }
  const byExam = new Map<number, Pick<Topic, "id">[]>();
  for (const t of topics) byExam.set(t.exam_id, [...(byExam.get(t.exam_id) ?? []), t]);
  for (const [examId, list] of byExam) {
    const all: number[] = [];
    let readiness = 0;
    let studiedCount = 0;
    for (const t of list) {
      const ms = (conceptsOf.get(t.id) ?? []).map(mastery).filter((m): m is number => m != null);
      all.push(...ms);
      const topicMastery = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
      if (studied.has(t.id)) studiedCount++;
      if (studied.has(t.id) || topicMastery != null) readiness += topicMastery ?? 0.5;
    }
    out.set(examId, {
      mastery: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null,
      studied: studiedCount / list.length,
      readiness: readiness / list.length,
      topics: list.length,
    });
  }
  return out;
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
