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

type StoredQuiz = { id?: string; hidden?: boolean; report_note?: string | null }[];

/**
 * Hides a section-quiz question (by its stable id) in this topic and in the same section of every copy of the exam:
 * the exam it was shared from and every exam added from it (copies keep question ids). The question stays in place so
 * positions, and the answers that refer to them, never shift. Returns how many quizzes changed.
 */
export function hideQuizQuestionEverywhere(topicId: number, questionId: string, note: string | null): number {
  const topic = db.prepare("SELECT exam_id FROM topics WHERE id = ?").get(topicId) as { exam_id: number } | undefined;
  if (!topic) return 0;
  const exam = db.prepare("SELECT id, source_exam_id FROM exams WHERE id = ?").get(topic.exam_id) as { id: number; source_exam_id: number | null };
  const root = exam.source_exam_id ?? exam.id;
  const topics = db
    .prepare("SELECT t.id, t.checks_json FROM topics t JOIN exams e ON e.id = t.exam_id WHERE (e.id = ? OR e.source_exam_id = ?) AND t.checks_json IS NOT NULL")
    .all(root, root) as { id: number; checks_json: string }[];
  const update = db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?");
  let n = 0;
  for (const t of topics) {
    const qs = JSON.parse(t.checks_json) as StoredQuiz;
    const i = qs.findIndex((q) => q.id === questionId);
    if (i === -1 || qs[i].hidden) continue;
    qs[i] = { ...qs[i], hidden: true, report_note: qs[i].report_note ?? note };
    update.run(JSON.stringify(qs), t.id);
    n++;
  }
  return n;
}
