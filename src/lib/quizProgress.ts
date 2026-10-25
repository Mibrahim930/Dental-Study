// A student's answers to a section quiz, kept per student and section (not per study session), so stepping away,
// ending a session or coming back next week shows the quiz exactly where she left it.
// `session_checks` still records every answer per session for summaries and history. Table: quiz_answers (db.ts SCHEMA).
import { db, getMeta, setMeta } from "./db";

/** Records an answer once; a second answer to the same question is ignored. Returns true when it was new. */
export function recordQuizAnswer(userId: number, topicId: number, index: number, chosen: number, correct: boolean): boolean {
  return (
    db
      .prepare("INSERT OR IGNORE INTO quiz_answers (user_id, topic_id, check_index, chosen, correct) VALUES (?, ?, ?, ?, ?)")
      .run(userId, topicId, index, chosen, correct ? 1 : 0).changes > 0
  );
}

/** The student's answers for a section: question position → chosen option. */
export function quizAnswers(userId: number, topicId: number): Record<number, number> {
  return Object.fromEntries(
    (db.prepare("SELECT check_index, chosen FROM quiz_answers WHERE user_id = ? AND topic_id = ?").all(userId, topicId) as { check_index: number; chosen: number }[]).map((r) => [
      r.check_index,
      r.chosen,
    ]),
  );
}

/** "Retake this quiz": the student's own answers for the section go away (history in session_checks stays). */
export function clearQuizAnswers(userId: number, topicId: number): number {
  return db.prepare("DELETE FROM quiz_answers WHERE user_id = ? AND topic_id = ?").run(userId, topicId).changes;
}

/** The section's questions were replaced (Write new questions, lecture removed, rebuild): everyone's progress on them goes. */
export function clearTopicQuizAnswers(topicId: number): number {
  return db.prepare("DELETE FROM quiz_answers WHERE topic_id = ?").run(topicId).changes;
}

/**
 * One-time upgrade: answers given before this table existed live in session_checks (per session). Copy each student's
 * latest answer per question into quiz_answers so nobody's progress looks lost after the deploy. Safe to call repeatedly.
 */
export function migrateSessionChecks(): number {
  if (getMeta("quiz_answers_migrated") === "1") return 0;
  return db.transaction(() => {
    const n = db
      .prepare(
        `INSERT OR REPLACE INTO quiz_answers (user_id, topic_id, check_index, chosen, correct, created_at)
         SELECT e.user_id, c.topic_id, c.check_index, c.chosen, c.correct, c.created_at
         FROM session_checks c
         JOIN study_sessions s ON s.id = c.session_id
         JOIN exams e ON e.id = s.exam_id
         WHERE c.check_index IS NOT NULL AND c.chosen IS NOT NULL AND e.user_id IS NOT NULL
         ORDER BY c.created_at, c.id`,
      )
      .run().changes;
    setMeta("quiz_answers_migrated", "1");
    return n;
  })();
}
