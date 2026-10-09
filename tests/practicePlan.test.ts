import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { answerQuestion } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { allocate, focusPoints, lastPracticed, pendingCounts, retryQuestions, scopeTopicIds, type Confidence } from "@/lib/practicePlan";
import type { Topic } from "@/lib/db";
import { makeExam, makeUser } from "./helpers";

const OPTIONS = ["A", "B", "C", "D", "E"];

function question(examId: number, topicId: number, stem = "Q"): number {
  return Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', ?, ?, 0, 'e')")
      .run(examId, topicId, stem, JSON.stringify(OPTIONS)).lastInsertRowid,
  );
}

function attempt(examId: number, questionIds: number[], optionOrder?: number[]): number {
  const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(examId).lastInsertRowid);
  questionIds.forEach((q, i) =>
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, option_order) VALUES (?, ?, ?, ?)").run(id, q, i, optionOrder ? JSON.stringify(optionOrder) : null),
  );
  return id;
}

/** Answer as the student sees it: 0 is right (no shuffle), 1 is wrong. */
const answer = (attemptId: number, q: number, right: boolean, confidence: Confidence = "sure") => answerQuestion(attemptId, q, right ? 0 : 1, confidence);

describe("practice exam question selection", () => {
  it("brings back missed questions in the next exam until they are answered right, and never repeats right answers", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5]);
    const [right, wrong] = [question(examId, topicIds[0], "right"), question(examId, topicIds[0], "wrong")];

    const first = attempt(examId, [right, wrong]);
    answer(first, right, true);
    answer(first, wrong, false);
    expect(retryQuestions(examId, [], 10)).toEqual([wrong]);

    // Missed again: still comes back. Answered right: done.
    const second = attempt(examId, [wrong]);
    answer(second, wrong, false);
    expect(retryQuestions(examId, [], 10)).toEqual([wrong]);
    const third = attempt(examId, [wrong]);
    answer(third, wrong, true);
    expect(retryQuestions(examId, [], 10)).toEqual([]);
  });

  it("caps how many missed questions come back, newest misses first", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5]);
    const qs = [1, 2, 3, 4].map((n) => question(examId, topicIds[0], `q${n}`));
    const a1 = attempt(examId, qs.slice(0, 2));
    qs.slice(0, 2).forEach((q) => answer(a1, q, false));
    const a2 = attempt(examId, qs.slice(2));
    qs.slice(2).forEach((q) => answer(a2, q, false));
    expect(retryQuestions(examId, [], 2).sort()).toEqual(qs.slice(2).sort());
  });

  it("only brings back missed questions from the chosen topics", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5, 5]);
    const [q1, q2] = [question(examId, topicIds[0]), question(examId, topicIds[1])];
    const a = attempt(examId, [q1, q2]);
    answer(a, q1, false);
    answer(a, q2, false);
    expect(retryQuestions(examId, [topicIds[1]], 10)).toEqual([q2]);
  });

  it("records confidence and maps shuffled options back for retried questions", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5]);
    const q = question(examId, topicIds[0]);
    // Display order: shown option 0 is stored option 3, ..., shown option 2 is stored option 0 (the right answer).
    const a = attempt(examId, [q], [3, 1, 0, 4, 2]);
    expect(attemptView(a)!.questions[0].options).toEqual(["D", "B", "A", "E", "C"]);
    answerQuestion(a, q, 2, "guess");
    const row = db.prepare("SELECT chosen_index, correct, confidence FROM attempt_questions WHERE attempt_id = ?").get(a);
    expect(row).toEqual({ chosen_index: 0, correct: 1, confidence: "guess" });
    const shown = attemptView(a)!.questions[0];
    expect([shown.chosen_index, shown.correct_index, shown.retry]).toEqual([2, 2, true]);
  });

  it("treats missed and right-but-unsure answers as weak spots, but not confident right answers", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5]);
    const [sure, guessed, missed] = ["sure", "guessed", "missed"].map((s) => question(examId, topicIds[0], s));
    const a = attempt(examId, [sure, guessed, missed]);
    answer(a, sure, true, "sure");
    answer(a, guessed, true, "guess");
    answer(a, missed, false, "sure");
    const points = focusPoints(examId, []).get(topicIds[0])!;
    expect(points.map((p) => [p.stem, p.why])).toEqual([
      ["guessed", "unsure"],
      ["missed", "missed"],
    ]);
    expect(pendingCounts(examId)).toEqual({ missed: 1, unsure: 1 });
  });

  it("with focus off spreads questions by topic size; with focus on, weak topics get more", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [10, 10]);
    const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
    expect(allocate(topics, 10, null).map((a) => a.count)).toEqual([5, 5]);
    const focus = new Map([[topicIds[1], Array(6).fill({ concept: null, source_page_id: null, stem: "s", why: "missed" })]]);
    const [a, b] = allocate(topics, 10, focus).map((x) => x.count);
    expect(b).toBeGreaterThan(a);
    expect(a + b).toBe(10);
  });

  it("finds the topics that belong to the chosen lectures", () => {
    const u = makeUser();
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(u).lastInsertRowid);
    const doc = (name: string) => Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, ?)").run(examId, name).lastInsertRowid);
    const page = (d: number) => Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path) VALUES (?, 1, '')").run(d).lastInsertRowid);
    const [d1, d2] = [doc("one.pdf"), doc("two.pdf")];
    const [p1, p2] = [page(d1), page(d2)];
    const topic = (pages: number[]) =>
      Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 't', '', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
    const [onlyOne, both, onlyTwo] = [topic([p1]), topic([p1, p2]), topic([p2])];
    expect(scopeTopicIds(examId, { kind: "lectures", documentIds: [d2] })).toEqual([both, onlyTwo]);
    expect(scopeTopicIds(examId, { kind: "topics", topicIds: [onlyOne, 999999] })).toEqual([onlyOne]);
    expect(scopeTopicIds(examId, { kind: "all" })).toEqual([]);
  });

  it("gives every section at least one question when the exam is long enough, however lopsided the weights", () => {
    const u = makeUser();
    const { examId } = makeExam(u, null, [40, 1, 1, 1, 1]);
    const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
    const plan = allocate(topics, 10, null);
    expect(plan).toHaveLength(5);
    expect(plan.every((p) => p.count >= 1)).toBe(true);
    expect(plan.reduce((n, p) => n + p.count, 0)).toBe(10);
  });

  it("when the exam is too short, covers the sections practised longest ago, and the ones left out lead the next exam", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5, 5, 5, 5, 5]);
    const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
    // Topics 0-2 were practised (0 longest ago); 3 and 4 never.
    const last = new Map([
      [topicIds[0], 5],
      [topicIds[1], 6],
      [topicIds[2], 7],
    ]);
    const first = allocate(topics, 3, null, { last }).map((p) => p.topic.id);
    expect(first.sort()).toEqual([topicIds[0], topicIds[3], topicIds[4]].sort());
    // After that exam, the two left out (1 and 2) come first.
    for (const id of first) last.set(id, 8);
    const second = allocate(topics, 2, null, { last }).map((p) => p.topic.id);
    expect(second.sort()).toEqual([topicIds[1], topicIds[2]].sort());
  });

  it("counts a section as covered when a missed question from it is coming back", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5, 5, 5]);
    const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
    const plan = allocate(topics, 2, null, { covered: new Set([topicIds[0]]) });
    expect(plan.map((p) => p.topic.id).sort()).toEqual([topicIds[1], topicIds[2]].sort());
  });

  it("only counts a section as practised when one of its questions was actually answered", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [5, 5]);
    const [answered, skipped] = [question(examId, topicIds[0]), question(examId, topicIds[1])];
    const a = attempt(examId, [answered, skipped]);
    answer(a, answered, true);
    db.prepare("UPDATE attempts SET status = 'finished' WHERE id = ?").run(a);
    const last = lastPracticed(examId);
    expect(last.get(topicIds[0])).toBe(a);
    expect(last.has(topicIds[1])).toBe(false);
  });
});
