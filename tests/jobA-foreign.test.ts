import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async () => {
    throw new Error("no AI in this test");
  }),
}));

import { db } from "@/lib/db";
import { dropForeignQuestions, SECONDS_PER_QUESTION } from "@/lib/practice";
import { shuffle } from "@/lib/practicePlan";
import { makeExam, makeUser } from "./helpers";

const OPTIONS = JSON.stringify(["A", "B", "C", "D", "E"]);
const q = (examId: number, topicId: number | null, stem: string) =>
  Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', ?, ?, 0, 'e')")
      .run(examId, topicId, stem, OPTIONS).lastInsertRowid,
  );

function attempt(examId: number, questionIds: number[], o: { status?: string; mode?: string; answered?: number[] } = {}) {
  const mode = o.mode ?? "timed";
  const id = Number(
    db
      .prepare("INSERT INTO attempts (exam_id, mode, status, time_limit_sec) VALUES (?, ?, ?, ?)")
      .run(examId, mode, o.status ?? "ready", mode === "timed" ? questionIds.length * SECONDS_PER_QUESTION : null).lastInsertRowid,
  );
  questionIds.forEach((qid, i) =>
    db
      .prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, ?, ?, ?)")
      .run(id, qid, i, o.answered?.includes(qid) ? 0 : null, o.answered?.includes(qid) ? 1 : null),
  );
  return id;
}
const rows = (attemptId: number) =>
  db.prepare("SELECT question_id, position FROM attempt_questions WHERE attempt_id = ? ORDER BY position").all(attemptId) as {
    question_id: number;
    position: number;
  }[];
const att = (id: number) => db.prepare("SELECT status, error, time_limit_sec FROM attempts WHERE id = ?").get(id) as { status: string; error: string | null; time_limit_sec: number | null };

function setup() {
  const userId = makeUser();
  const mine = makeExam(userId, null, [1, 1]);
  const other = makeExam(userId, null, [1]);
  return { mine, other };
}

describe("dropForeignQuestions: open exams lose unanswered questions from other exams", () => {
  it("removes them, renumbers positions, shortens the clock, and is idempotent", () => {
    const { mine, other } = setup();
    const a1 = q(mine.examId, mine.topicIds[0], "a1");
    const f1 = q(other.examId, other.topicIds[0], "f1");
    const a2 = q(mine.examId, mine.topicIds[1], "a2");
    const f2 = q(other.examId, other.topicIds[0], "f2");
    const id = attempt(mine.examId, [a1, f1, a2, f2]);
    expect(dropForeignQuestions()).toBeGreaterThanOrEqual(2);
    expect(rows(id)).toEqual([
      { question_id: a1, position: 0 },
      { question_id: a2, position: 1 },
    ]);
    expect(att(id).time_limit_sec).toBe(2 * SECONDS_PER_QUESTION);
    expect(att(id).status).toBe("ready");
    // Second run changes nothing.
    dropForeignQuestions();
    expect(rows(id)).toHaveLength(2);
    expect(att(id).time_limit_sec).toBe(2 * SECONDS_PER_QUESTION);
  });

  it("keeps answered foreign questions (history) and leaves finished exams alone", () => {
    const { mine, other } = setup();
    const a1 = q(mine.examId, mine.topicIds[0], "a1");
    const fAnswered = q(other.examId, other.topicIds[0], "answered");
    const fOpen = q(other.examId, other.topicIds[0], "open");
    const open = attempt(mine.examId, [a1, fAnswered, fOpen], { answered: [fAnswered] });
    const done = attempt(mine.examId, [a1, fOpen], { status: "finished" });
    dropForeignQuestions();
    expect(rows(open).map((r) => r.question_id)).toEqual([a1, fAnswered]);
    expect(rows(done).map((r) => r.question_id)).toEqual([a1, fOpen]);
  });

  it("tutor exams keep no time limit", () => {
    const { mine, other } = setup();
    const a1 = q(mine.examId, mine.topicIds[0], "a1");
    const f1 = q(other.examId, other.topicIds[0], "f1");
    const id = attempt(mine.examId, [a1, f1], { mode: "tutor" });
    dropForeignQuestions();
    expect(att(id).time_limit_sec).toBeNull();
  });

  it("an exam left with nothing becomes an error with a friendly message (no empty exam)", () => {
    const { mine, other } = setup();
    const f1 = q(other.examId, other.topicIds[0], "f1");
    const id = attempt(mine.examId, [f1]);
    dropForeignQuestions();
    expect(rows(id)).toHaveLength(0);
    expect(att(id).status).toBe("error");
    expect(att(id).error).toMatch(/start a new one/i);
  });

  it("classmate's copy: questions belong to the copy's own exam, so nothing is removed", () => {
    const { mine } = setup();
    const a1 = q(mine.examId, mine.topicIds[0], "a1");
    const id = attempt(mine.examId, [a1]);
    dropForeignQuestions();
    expect(rows(id)).toHaveLength(1);
  });
});

describe("shuffle (Fisher–Yates)", () => {
  it("keeps every element and doesn't change the input", () => {
    const xs = [1, 2, 3, 4, 5];
    const out = shuffle(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual(xs);
    expect(shuffle([])).toEqual([]);
  });

  it("puts the first element in each of 5 positions about equally often", () => {
    const counts = [0, 0, 0, 0, 0];
    const N = 20000;
    for (let i = 0; i < N; i++) counts[shuffle([0, 1, 2, 3, 4]).indexOf(0)]++;
    for (const c of counts) expect(Math.abs(c / N - 0.2)).toBeLessThan(0.02);
  });
});
