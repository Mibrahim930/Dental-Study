import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the AI call; everything else (selection, prompts, DB writes) is the real code.
const calls: { purpose: string; content: string }[] = [];
let counter = 0;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    const count = Number(/Write (\d+) /.exec(opts.content)?.[1] ?? 1);
    const page = Number(/\[P(\d+)\]/.exec(opts.content)?.[1] ?? 0);
    if (opts.purpose === "case sets") {
      return {
        cases: Array.from({ length: count }, () => ({
          scenario: `scenario ${++counter}`,
          patient_box: { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" },
          image_page_id: null,
          questions: Array.from({ length: 3 }, (_, i) => ({
            stem: `case-q ${++counter}-${i}`,
            options: ["A", "B", "C", "D", "E"],
            correct_index: 0,
            explanation: "e",
            source_page_id: page,
            concept: "Gen concept",
          })),
        })),
      };
    }
    return {
      questions: Array.from({ length: count }, () => ({
        type: "recall",
        image_page_id: null,
        patient_box: null,
        stem: `generated ${++counter}`,
        options: ["A", "B", "C", "D", "E"],
        correct_index: 0,
        explanation: "e",
        source_page_id: page,
        concept: "Gen concept",
      })),
    };
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db } from "@/lib/db";
import { answerQuestion, startAttempt, finishAttempt, dueCards, reviewCard } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { retryQuestions } from "@/lib/practicePlan";
import { makeUser } from "./helpers";

const OPTIONS = ["A", "B", "C", "D", "E"];

/** An exam whose topics each have real slide pages (so prompts contain [P<id>] slides). */
function world(topics = 2, slidesEach = 3) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'lec.pdf')").run(examId).lastInsertRowid);
  let pn = 0;
  const topicIds: number[] = [];
  const pageIds: number[][] = [];
  for (let t = 0; t < topics; t++) {
    const pages = Array.from({ length: slidesEach }, () =>
      Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, text) VALUES (?, ?, '', 'slide text')").run(docId, ++pn).lastInsertRowid),
    );
    pageIds.push(pages);
    topicIds.push(
      Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)").run(examId, t, `Topic ${t + 1}`, JSON.stringify(pages)).lastInsertRowid),
    );
  }
  return { userId, examId, docId, topicIds, pageIds };
}

function q(examId: number, topicId: number, stem: string, extra: { caseId?: number; sourcePage?: number } = {}): number {
  return Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, case_id, source_page_id) VALUES (?, ?, 'recall', ?, ?, 0, 'e', ?, ?)")
      .run(examId, topicId, stem, JSON.stringify(OPTIONS), extra.caseId ?? null, extra.sourcePage ?? null).lastInsertRowid,
  );
}
function att(examId: number, ids: number[]): number {
  const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(examId).lastInsertRowid);
  ids.forEach((x, i) => db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)").run(id, x, i));
  return id;
}
async function ready(attemptId: number) {
  for (let i = 0; i < 300; i++) {
    const a = db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(attemptId) as { status: string; error: string | null };
    if (a.status !== "generating") return a;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("attempt stuck generating");
}
const members = (attemptId: number) =>
  db.prepare("SELECT question_id, option_order FROM attempt_questions WHERE attempt_id = ? ORDER BY position").all(attemptId) as { question_id: number; option_order: string | null }[];

beforeEach(() => {
  calls.length = 0;
});

describe("startAttempt end to end (AI mocked)", () => {
  it("brings back missed questions shuffled, never right ones, no duplicates, respects the 40% cap", async () => {
    const w = world();
    const rights = [0, 1, 2].map((i) => q(w.examId, w.topicIds[0], `right ${i}`));
    const wrongs = Array.from({ length: 8 }, (_, i) => q(w.examId, w.topicIds[i % 2], `wrong ${i}`));
    const a1 = att(w.examId, [...rights, ...wrongs]);
    rights.forEach((x) => answerQuestion(a1, x, 0, "sure"));
    wrongs.forEach((x) => answerQuestion(a1, x, 1, "sure"));
    finishAttempt(a1);

    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "mixed" });
    expect((await ready(id)).status).toBe("ready");
    const m = members(id);
    const ids = m.map((r) => r.question_id);
    expect(m.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
    for (const r of rights) expect(ids).not.toContain(r);
    const retried = m.filter((r) => wrongs.includes(r.question_id));
    expect(retried.length).toBe(4); // floor(10 * 0.4)
    for (const r of retried) {
      const order = JSON.parse(r.option_order!) as number[];
      expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
    }
    expect(m.filter((r) => !wrongs.includes(r.question_id)).every((r) => r.option_order === null)).toBe(true);
    expect(id).not.toBe(a1);
  });

  it("size 5 caps retries at 2; tiny sizes still produce a full exam", async () => {
    const w = world(1);
    const wrongs = Array.from({ length: 6 }, (_, i) => q(w.examId, w.topicIds[0], `wrong ${i}`));
    const a1 = att(w.examId, wrongs);
    wrongs.forEach((x) => answerQuestion(a1, x, 1, "sure"));
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(id);
    expect(members(id).filter((r) => wrongs.includes(r.question_id)).length).toBe(2);
    expect(members(id).length).toBe(5);
  });

  async function promptFor(adaptive: boolean) {
    const w = world(1);
    const wrong = q(w.examId, w.topicIds[0], "STEM-MISSED-ONE", { sourcePage: w.pageIds[0][0] });
    const unsure = q(w.examId, w.topicIds[0], "STEM-UNSURE-ONE", { sourcePage: w.pageIds[0][1] });
    const a1 = att(w.examId, [wrong, unsure]);
    answerQuestion(a1, wrong, 1, "sure");
    answerQuestion(a1, unsure, 0, "guess");
    calls.length = 0;
    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "mixed", adaptive });
    await ready(id);
    return { prompt: calls.map((c) => c.content).join(" | "), id, wrong };
  }

  it("includes the already-had stems in the prompt, and the focus section only when adaptive is on", async () => {
    const on = await promptFor(true);
    expect(on.prompt).toContain("already had");
    expect(on.prompt).toContain("STEM-MISSED-ONE");
    expect(on.prompt).toContain("STEM-UNSURE-ONE");
    expect(on.prompt).toContain("missed or wasn't sure");
    expect(on.prompt).toContain("(asked 1x)");
    expect(db.prepare("SELECT adaptive FROM attempts WHERE id = ?").get(on.id)).toEqual({ adaptive: 1 });

    const off = await promptFor(false);
    expect(off.prompt).toContain("already had");
    expect(off.prompt).not.toContain("missed or wasn't sure");
    expect(db.prepare("SELECT adaptive FROM attempts WHERE id = ?").get(off.id)).toEqual({ adaptive: 0 });
    // Wrong answers still repeat with focus off.
    expect(members(off.id).map((r) => r.question_id)).toContain(off.wrong);
  });

  it("uses the saved focus_weak preference when adaptive is not given", async () => {
    const w = world(1);
    db.prepare("UPDATE users SET focus_weak = 0 WHERE id = ?").run(w.userId);
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(id);
    expect(db.prepare("SELECT adaptive FROM attempts WHERE id = ?").get(id)).toEqual({ adaptive: 0 });
  });

  it("only draws from the chosen topics, for new and retried questions", async () => {
    const w = world(3);
    const w0 = q(w.examId, w.topicIds[0], "w0");
    const w1 = q(w.examId, w.topicIds[1], "w1");
    const a1 = att(w.examId, [w0, w1]);
    answerQuestion(a1, w0, 1, "sure");
    answerQuestion(a1, w1, 1, "sure");
    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "mixed", topicIds: [w.topicIds[1]] });
    await ready(id);
    const ids = members(id).map((r) => r.question_id);
    expect(ids).toContain(w1);
    expect(ids).not.toContain(w0);
    const topics = db.prepare(`SELECT DISTINCT topic_id FROM questions WHERE id IN (${ids.join(",")})`).all();
    expect(topics).toEqual([{ topic_id: w.topicIds[1] }]);
    expect(calls.every((c) => c.content.includes("Topic: Topic 2"))).toBe(true);
  });

  it("reuses never-answered questions instead of generating, and never reuses answered ones", async () => {
    const w = world(1);
    const spare = Array.from({ length: 3 }, (_, i) => q(w.examId, w.topicIds[0], `spare ${i}`));
    const done = q(w.examId, w.topicIds[0], "done");
    answerQuestion(att(w.examId, [done]), done, 0, "sure");
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(id);
    const ids = members(id).map((r) => r.question_id);
    for (const s of spare) expect(ids).toContain(s);
    expect(ids).not.toContain(done);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("timed mode keeps answers hidden but stores confidence", async () => {
    const w = world(1);
    const id = startAttempt(w.examId, { size: 5, mode: "timed", style: "mixed" });
    await ready(id);
    const first = members(id)[0].question_id;
    answerQuestion(id, first, 1, "unsure");
    const v = attemptView(id)!.questions[0];
    expect(v.confidence).toBe("unsure");
    expect(v.chosen_index).toBe(1);
    expect("correct_index" in v).toBe(false);
    expect("explanation" in v).toBe(false);
    finishAttempt(id);
    expect("correct_index" in attemptView(id)!.questions[0]).toBe(true);
  });

  it("a shuffled retry reads correctly in the results view and in daily review (original indexes)", async () => {
    const w = world(1);
    const wrong = q(w.examId, w.topicIds[0], "w");
    const a1 = att(w.examId, [wrong]);
    answerQuestion(a1, wrong, 1, "sure");
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(id);
    const order = JSON.parse(members(id).find((r) => r.question_id === wrong)!.option_order!) as number[];
    const shownRight = order.indexOf(0); // display position of the true answer
    answerQuestion(id, wrong, shownRight, "sure");
    finishAttempt(id);
    const v = attemptView(id)!.questions.find((x) => x.id === wrong)!;
    expect(v.chosen_index).toBe(shownRight);
    expect((v as { correct_index: number }).correct_index).toBe(shownRight);
    expect(v.options[shownRight]).toBe("A");
    expect((v as { correct: boolean }).correct).toBe(true);
    expect(retryQuestions(w.examId, w.topicIds, 10)).not.toContain(wrong);
    // The earlier miss created a review card; daily review uses original option indexes.
    db.prepare("UPDATE review_cards SET due = '2000-01-01T00:00:00.000Z'").run();
    const due = dueCards(w.userId, 10).filter((c) => c.id === wrong);
    expect(due.length).toBe(1);
    expect(due[0].correct_index).toBe(0);
    reviewCard(due[0].card_id, true, "good");
  });

  it("case-set exam brings back a missed case whole", async () => {
    const w = world(1);
    const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box) VALUES (?, 's', '{}')").run(w.examId).lastInsertRowid);
    const cq = [0, 1, 2].map((i) => q(w.examId, w.topicIds[0], `cq${i}`, { caseId }));
    const a1 = att(w.examId, cq);
    answerQuestion(a1, cq[0], 0, "sure"); // right
    answerQuestion(a1, cq[1], 1, "sure"); // wrong
    answerQuestion(a1, cq[2], 0, "sure"); // right
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset" });
    await ready(id);
    const ids = members(id).map((r) => r.question_id);
    expect(ids).toContain(cq[1]);
    // Requirement 1 says right answers never repeat; the retried case drags the two right answers along.
    expect(ids, "right-answered case questions repeat when their case is retried").not.toContain(cq[0]);
    expect(ids).not.toContain(cq[2]);
  });

  it("case questions never come back in non-caseset exams", async () => {
    const w = world(1);
    const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box) VALUES (?, 's', '{}')").run(w.examId).lastInsertRowid);
    const cq = q(w.examId, w.topicIds[0], "cq", { caseId });
    answerQuestion(att(w.examId, [cq]), cq, 1, "sure");
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(id);
    expect(members(id).map((r) => r.question_id)).not.toContain(cq);
  });

  it("caseset size 4 with a missed case is made only of the retried case (no new material)", async () => {
    const w = world(1);
    const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box) VALUES (?, 's', '{}')").run(w.examId).lastInsertRowid);
    const cq = [0, 1].map((i) => q(w.examId, w.topicIds[0], `cq${i}`, { caseId }));
    const a1 = att(w.examId, cq);
    cq.forEach((x) => answerQuestion(a1, x, 1, "sure"));
    const id = startAttempt(w.examId, { size: 4, mode: "tutor", style: "caseset" });
    await ready(id);
    const generatedCases = db.prepare("SELECT COUNT(*) n FROM cases WHERE id != ? AND exam_id = ?").get(caseId, w.examId) as { n: number };
    // RETRY_SHARE is 40% but a one-case exam is 100% retry.
    expect(generatedCases.n).toBeGreaterThan(0);
  });
});

describe("gaps and edge cases", () => {
  it("a missed question from a past-exam weak-concept slot is retried in the next exam", async () => {
    const w = world(1);
    // A past exam with a weak concept (mastery well below 0.7), same student.
    const past = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Past')").run(w.userId).lastInsertRowid);
    const pastTopic = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Past topic', '', '[]')").run(past).lastInsertRowid);
    const concept = Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, 'Weak', 10, 1)").run(w.userId).lastInsertRowid);
    db.prepare("INSERT INTO topic_concepts VALUES (?, ?)").run(pastTopic, concept);
    const pastQ = q(past, pastTopic, "past-q");

    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "mixed", adaptive: true });
    await ready(id);
    const ids = members(id).map((r) => r.question_id);
    expect(ids).toContain(pastQ); // reused via the past-topic slot
    answerQuestion(id, pastQ, 1, "sure");
    finishAttempt(id);
    const topicIds = (db.prepare("SELECT id FROM topics WHERE exam_id = ?").all(w.examId) as { id: number }[]).map((t) => t.id);
    expect(retryQuestions(w.examId, topicIds, 10, { wholeExam: true })).toContain(pastQ);
  });

  it("starting a second exam while the first is still open does not reuse the first one's questions", async () => {
    const w = world(1);
    const first = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(first);
    const second = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(second);
    const a = members(first).map((r) => r.question_id);
    const b = new Set(members(second).map((r) => r.question_id));
    expect(a.filter((x) => b.has(x))).toEqual([]);
  });

  it("a stem identical to an already-right question is not accepted from the AI", async () => {
    const w = world(1);
    const right = q(w.examId, w.topicIds[0], "generated 1000000");
    answerQuestion(att(w.examId, [right]), right, 0, "sure");
    counter = 999999; // next generated stem is exactly "generated 1000000"
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed" });
    await ready(id);
    const stems = (db.prepare("SELECT q.stem FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ?").all(id) as { stem: string }[]).map((r) => r.stem);
    expect(stems.filter((s) => s === "generated 1000000")).toEqual([]);
  });

  it("flagged missed questions are not retried", () => {
    const w = world(1);
    const x = q(w.examId, w.topicIds[0], "flag me");
    answerQuestion(att(w.examId, [x]), x, 1, "sure");
    expect(retryQuestions(w.examId, w.topicIds, 5, { wholeExam: true })).toEqual([x]);
    db.prepare("UPDATE questions SET flagged = 1 WHERE id = ?").run(x);
    expect(retryQuestions(w.examId, w.topicIds, 5)).toEqual([]);
  });

  it("an unfinished attempt's wrong answers already count for retry", () => {
    const w = world(1);
    const x = q(w.examId, w.topicIds[0], "x");
    answerQuestion(att(w.examId, [x]), x, 1, "sure"); // attempt left at status 'ready'
    expect(retryQuestions(w.examId, w.topicIds, 5, { wholeExam: true })).toEqual([x]);
  });

  it("an out-of-range chosen index is not stored as an answer", () => {
    const w = world(1);
    const x = q(w.examId, w.topicIds[0], "x");
    const a = att(w.examId, [x]);
    answerQuestion(a, x, 99, "sure");
    const row = db.prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ?").get(a) as { chosen_index: number | null };
    expect(row.chosen_index).toBeNull();
  });

  it("a missed question whose topic was deleted (topic_id NULL) can still be retried", async () => {
    const w = world(1);
    const x = q(w.examId, w.topicIds[0], "orphan");
    answerQuestion(att(w.examId, [x]), x, 1, "sure");
    db.prepare("UPDATE questions SET topic_id = NULL WHERE id = ?").run(x);
    expect(retryQuestions(w.examId, w.topicIds, 5, { wholeExam: true })).toEqual([x]);
  });
});
