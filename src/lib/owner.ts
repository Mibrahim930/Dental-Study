// Ownership checks: every id that comes from a URL is checked against the signed-in user.
import { db } from "./db";

const one = (sql: string, ...args: unknown[]) => !!db.prepare(sql).get(...args);

export const ownsExam = (userId: number, examId: number) => one("SELECT 1 FROM exams WHERE id = ? AND user_id = ?", examId, userId);

export const ownsDocument = (userId: number, docId: number) =>
  one("SELECT 1 FROM documents d JOIN exams e ON e.id = d.exam_id WHERE d.id = ? AND e.user_id = ?", docId, userId);

export const ownsPage = (userId: number, pageId: number) =>
  one(
    "SELECT 1 FROM pages p JOIN documents d ON d.id = p.document_id JOIN exams e ON e.id = d.exam_id WHERE p.id = ? AND e.user_id = ?",
    pageId,
    userId,
  );

export const ownsSession = (userId: number, sessionId: number) =>
  one("SELECT 1 FROM study_sessions s JOIN exams e ON e.id = s.exam_id WHERE s.id = ? AND e.user_id = ?", sessionId, userId);

export const ownsAttempt = (userId: number, attemptId: number) =>
  one("SELECT 1 FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.id = ? AND e.user_id = ?", attemptId, userId);

export const ownsQuestion = (userId: number, questionId: number) =>
  one("SELECT 1 FROM questions q JOIN exams e ON e.id = q.exam_id WHERE q.id = ? AND e.user_id = ?", questionId, userId);

export const ownsCard = (userId: number, cardId: number) =>
  one(
    "SELECT 1 FROM review_cards r JOIN questions q ON q.id = r.question_id JOIN exams e ON e.id = q.exam_id WHERE r.id = ? AND e.user_id = ?",
    cardId,
    userId,
  );
