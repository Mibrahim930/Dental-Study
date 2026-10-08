import { beforeEach, describe, expect, it, vi } from "vitest";

type GenQ = { stem: string; concept?: string };
let questionStems: (n: number) => GenQ[] = (n) => Array.from({ length: n }, (_, i) => ({ stem: `gen ${Math.random()} ${i}` }));
let caseGen: (n: number) => number = (n) => n;
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
        cases: Array.from({ length: caseGen(count) }, () => ({
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
      questions: questionStems(count).map((g) => ({
        type: "recall",
        image_page_id: null,
        patient_box: null,
        stem: g.stem,
        options: ["A", "B", "C", "D", "E"],
        correct_index: 0,
        explanation: "e",
        source_page_id: page,
        concept: g.concept ?? "Gen concept",
      })),
    };
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db } from "@/lib/db";
import { answerQuestion, startAttempt, finishAttempt } from "@/lib/practice";
import { retryCases, retryQuestions } from "@/lib/practicePlan";
import { makeUser } from "./helpers";

const OPTIONS = ["A", "B", "C", "D", "E"];

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
function q(examId: number, topicId: number | null, stem: string, extra: { caseId?: number; type?: string; conceptId?: number } = {}): number {
  return Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, case_id, concept_id) VALUES (?, ?, ?, ?, ?, 0, 'e', ?, ?)")
      .run(examId, topicId, extra.type ?? "recall", stem, JSON.stringify(OPTIONS), extra.caseId ?? null, extra.conceptId ?? null).lastInsertRowid,
  );
}
function mkCase(examId: number): number {
  return Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box) VALUES (?, 's', '{}')").run(examId).lastInsertRowid);
}
function att(examId: number, ids: number[], status = "ready", startedAgo?: string): number {
  const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', ?)").run(examId, status).lastInsertRowid);
  if (startedAgo) db.prepare("UPDATE attempts SET started_at = datetime('now', ?) WHERE id = ?").run(startedAgo, id);
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
  questionStems = (n) => Array.from({ length: n }, (_, i) => ({ stem: `gen ${++counter} ${i}` }));
  caseGen = (n) => n;
});

describe("B1 case-set retries only bring back missed questions of a case", () => {
  it("retryCases returns only the missed questions, grouped by case", () => {
    const w = world(1);
    const c = mkCase(w.examId);
    const [q1, q2, q3] = [0, 1, 2].map((i) => q(w.examId, w.topicIds[0], `cq${i}`, { caseId: c, type: "case" }));
    const a = att(w.examId, [q1, q2, q3]);
    answerQuestion(a, q1, 0);
    answerQuestion(a, q2, 1);
    answerQuestion(a, q3, 2);
    expect(retryCases(w.examId, w.topicIds, 5)).toEqual([[q2, q3]]);
  });

  it("an end-to-end caseset exam: retried case has only missed questions, plus >=1 new case even at size 4", async () => {
    const w = world(1);
    const c = mkCase(w.examId);
    const [q1, q2, q3] = [0, 1, 2].map((i) => q(w.examId, w.topicIds[0], `cq${i}`, { caseId: c, type: "case" }));
    const a = att(w.examId, [q1, q2, q3]);
    answerQuestion(a, q1, 0);
    answerQuestion(a, q2, 1);
    answerQuestion(a, q3, 1);
    finishAttempt(a);
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset" });
    expect((await ready(id)).status).toBe("ready");
    const ids = members(id).map((m) => m.question_id);
    expect(ids).not.toContain(q1);
    expect(ids).toContain(q2);
    expect(ids).toContain(q3);
    const fresh = ids.filter((x) => ![q1, q2, q3].includes(x));
    expect(fresh.length).toBeGreaterThanOrEqual(3); // a new case of 3 questions
  });

  it("size 1..4 caseset with a pending retry still gets a new case", async () => {
    for (const size of [1, 2, 4]) {
      const w = world(1);
      const c = mkCase(w.examId);
      const qs = [0, 1].map((i) => q(w.examId, w.topicIds[0], `cq${i}`, { caseId: c, type: "case" }));
      const a = att(w.examId, qs);
      qs.forEach((x) => answerQuestion(a, x, 1));
      const id = startAttempt(w.examId, { size, mode: "tutor", style: "caseset" });
      await ready(id);
      const ids = members(id).map((m) => m.question_id);
      expect(ids.some((x) => !qs.includes(x)), `size ${size}`).toBe(true);
    }
  });

  it("retried case questions get shuffled options saved (option_order) and answering maps back", async () => {
    const w = world(1);
    const c = mkCase(w.examId);
    const qs = [0, 1].map((i) => q(w.examId, w.topicIds[0], `cq${i}`, { caseId: c, type: "case" }));
    const a = att(w.examId, qs);
    qs.forEach((x) => answerQuestion(a, x, 1));
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset" });
    await ready(id);
    const m = members(id).filter((r) => qs.includes(r.question_id));
    expect(m).toHaveLength(2);
    expect(m.every((r) => r.option_order != null)).toBe(true);
  });

  it("when the AI returns zero new cases but there are retries, the exam still finishes (retries only)", async () => {
    const w = world(1);
    const c = mkCase(w.examId);
    const qs = [0, 1].map((i) => q(w.examId, w.topicIds[0], `cq${i}`, { caseId: c, type: "case" }));
    const a = att(w.examId, qs);
    qs.forEach((x) => answerQuestion(a, x, 1));
    caseGen = () => 0;
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset" });
    const r = await ready(id);
    expect(r.status).toBe("ready");
  });
});

describe("B3 past-exam and deleted-topic misses retried for whole-exam", () => {
  it("whole exam: question with null topic_id and question from another exam are retried; scoped exam: not", () => {
    const w = world(2);
    const other = world(1);
    const orphan = q(w.examId, null, "orphan");
    // a question from the other exam, asked inside w's attempt (weak-concept slot)
    const past = q(other.examId, other.topicIds[0], "past");
    const here = q(w.examId, w.topicIds[0], "here");
    const a = att(w.examId, [orphan, past, here]);
    [orphan, past, here].forEach((x) => answerQuestion(a, x, 1));
    const whole = retryQuestions(w.examId, w.topicIds, 10, { wholeExam: true });
    expect(new Set(whole)).toEqual(new Set([orphan, past, here]));
    const scoped = retryQuestions(w.examId, [w.topicIds[0]], 10, { wholeExam: false });
    expect(scoped).toEqual([here]);
  });

  it("deleting a topic leaves attempt_questions with topic_id NULL question, which is retried (end to end)", async () => {
    const w = world(2);
    const doomed = q(w.examId, w.topicIds[1], "doomed");
    const a = att(w.examId, [doomed]);
    answerQuestion(a, doomed, 1);
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicIds[1]);
    const row = db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(doomed) as { topic_id: number | null } | undefined;
    expect(row).toBeDefined(); // question survives
    expect(row!.topic_id).toBeNull();
    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "mixed" });
    await ready(id);
    expect(members(id).map((m) => m.question_id)).toContain(doomed);
  });

  it("NOTE: retryCases ignores wholeExam, so a missed case whose topic was deleted never comes back", () => {
    const w = world(2);
    const c = mkCase(w.examId);
    const cq = q(w.examId, w.topicIds[1], "cq", { caseId: c, type: "case" });
    const a = att(w.examId, [cq]);
    answerQuestion(a, cq, 1);
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicIds[1]);
    expect(retryCases(w.examId, [w.topicIds[0]], 3, { wholeExam: true })).toEqual([[cq]]);
  });

  it("past-exam weak-concept slot: miss in whole-exam attempt comes back (end to end)", async () => {
    const w = world(1);
    const other = world(1);
    // other exam belongs to a different user in helpers; same user needed
    db.prepare("UPDATE exams SET user_id = ? WHERE id = ?").run(w.userId, other.examId);
    const pastQ = q(other.examId, other.topicIds[0], "past slot");
    const a = att(w.examId, [pastQ]);
    answerQuestion(a, pastQ, 1);
    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "mixed", adaptive: false });
    await ready(id);
    expect(members(id).map((m) => m.question_id)).toContain(pastQ);
  });
});

describe("B4 unusedQuestions skips questions in open attempts", () => {
  it("a spare question already in a ready attempt (<1 day) is not reused; one in an old attempt is", async () => {
    const w = world(1);
    const inOpen = q(w.examId, w.topicIds[0], "in open");
    const inOld = q(w.examId, w.topicIds[0], "in old");
    const free = q(w.examId, w.topicIds[0], "free");
    att(w.examId, [inOpen], "ready");
    att(w.examId, [inOld], "ready", "-3 days");
    const id = startAttempt(w.examId, { size: 2, mode: "tutor", style: "mixed", adaptive: false });
    await ready(id);
    const ids = members(id).map((m) => m.question_id);
    expect(ids).not.toContain(inOpen);
    // 2 questions from 3 spares (free, inOld) + inOpen excluded
    expect(ids.every((x) => x === free || x === inOld || ![inOpen].includes(x))).toBe(true);
  });

  it("a finished attempt with the question unanswered does not block reuse; an answered one does", async () => {
    const w = world(1);
    const unanswered = q(w.examId, w.topicIds[0], "unanswered");
    const answered = q(w.examId, w.topicIds[0], "answered-right");
    const a = att(w.examId, [unanswered, answered], "finished");
    answerQuestion(a, answered, 0);
    const id = startAttempt(w.examId, { size: 1, mode: "tutor", style: "mixed", adaptive: false });
    await ready(id);
    const ids = members(id).map((m) => m.question_id);
    expect(ids).toEqual([unanswered]);
  });

  it("two exams started back to back share no questions", async () => {
    const w = world(1);
    Array.from({ length: 6 }, (_, i) => q(w.examId, w.topicIds[0], `spare ${i}`));
    const a = startAttempt(w.examId, { size: 3, mode: "tutor", style: "mixed", adaptive: false });
    await ready(a);
    const b = startAttempt(w.examId, { size: 3, mode: "tutor", style: "mixed", adaptive: false });
    await ready(b);
    const A = members(a).map((m) => m.question_id);
    const B = members(b).map((m) => m.question_id);
    expect(A.filter((x) => B.includes(x))).toEqual([]);
  });

  it("two exams started simultaneously (no await between) share no questions", async () => {
    const w = world(1);
    Array.from({ length: 6 }, (_, i) => q(w.examId, w.topicIds[0], `spare ${i}`));
    const a = startAttempt(w.examId, { size: 3, mode: "tutor", style: "mixed", adaptive: false });
    const b = startAttempt(w.examId, { size: 3, mode: "tutor", style: "mixed", adaptive: false });
    await ready(a);
    await ready(b);
    const A = members(a).map((m) => m.question_id);
    const B = members(b).map((m) => m.question_id);
    expect(A.filter((x) => B.includes(x))).toEqual([]);
  });

  it("a missed question already sitting in another open exam is not put into a second open exam", async () => {
    const w = world(1);
    const missed = q(w.examId, w.topicIds[0], "missed");
    const a1 = att(w.examId, [missed], "finished");
    answerQuestion(a1, missed, 1);
    const x = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed", adaptive: false });
    await ready(x);
    const y = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed", adaptive: false });
    await ready(y);
    const inBoth = members(x).filter((m) => members(y).some((n) => n.question_id === m.question_id));
    expect(inBoth).toEqual([]);
  });
});

describe("B5 AI stems identical to existing ones are dropped", () => {
  it("drops normalized duplicates of existing and of each other", async () => {
    const w = world(1);
    q(w.examId, w.topicIds[0], "What is the Dental Pulp?");
    // existing answered/used question so it is not reusable
    questionStems = () => [{ stem: "what is the dental   pulp" }, { stem: "Brand new one" }, { stem: "brand NEW one!" }, { stem: "Another" }];
    const id = startAttempt(w.examId, { size: 4, mode: "tutor", style: "mixed", adaptive: false });
    await ready(id);
    const stems = (db.prepare("SELECT q.stem FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ?").all(id) as { stem: string }[]).map((r) => r.stem);
    expect(stems.filter((s) => /pulp/i.test(s)).length).toBe(1);
    expect(stems.filter((s) => /brand new one/i.test(s)).length).toBeLessThanOrEqual(1);
  });

  it("NOTE: stems with only non-latin characters normalize to empty and collide", async () => {
    const w = world(1);
    questionStems = () => [{ stem: "؟" }, { stem: "什么?" }, { stem: "Real question" }];
    const id = startAttempt(w.examId, { size: 3, mode: "tutor", style: "mixed", adaptive: false });
    await ready(id);
    expect(members(id).length).toBe(3);
  });

  it("if every generated stem is a duplicate the attempt errors cleanly instead of hanging", async () => {
    const w = world(1);
    q(w.examId, w.topicIds[0], "same");
    // make the existing question unusable for reuse by putting it in an open attempt
    att(w.examId, [Number((db.prepare("SELECT id FROM questions WHERE exam_id = ?").get(w.examId) as { id: number }).id)]);
    questionStems = () => [{ stem: "same" }];
    const id = startAttempt(w.examId, { size: 1, mode: "tutor", style: "mixed", adaptive: false });
    const r = await ready(id);
    expect(r.status).toBe("error");
  });
});

describe("B6 answerQuestion ignores bad chosen", () => {
  it("ignores out-of-range, negative, fractional, NaN, string; records valid; ignores repeat", () => {
    const w = world(1);
    const x = q(w.examId, w.topicIds[0], "x");
    const a = att(w.examId, [x]);
    for (const bad of [5, -1, 1.5, NaN, Infinity, "2" as unknown as number, null as unknown as number]) answerQuestion(a, x, bad);
    expect(db.prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ?").get(a)).toEqual({ chosen_index: null });
    answerQuestion(a, x, 4);
    answerQuestion(a, x, 0);
    expect(db.prepare("SELECT chosen_index, correct FROM attempt_questions WHERE attempt_id = ?").get(a)).toEqual({ chosen_index: 4, correct: 0 });
  });

  it("question id not in the attempt is ignored", () => {
    const w = world(1);
    const x = q(w.examId, w.topicIds[0], "x");
    const y = q(w.examId, w.topicIds[0], "y");
    const a = att(w.examId, [x]);
    answerQuestion(a, y, 0);
    expect(db.prepare("SELECT COUNT(*) n FROM attempt_questions WHERE chosen_index IS NOT NULL").get()).toBeDefined();
    expect(db.prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ?").get(a)).toEqual({ chosen_index: null });
  });
});

describe("B7 retries respect exam style", () => {
  it("recall-only exams never retry case or image type; case exams do not retry recall", () => {
    const w = world(1);
    const r = q(w.examId, w.topicIds[0], "r", { type: "recall" });
    const cs = q(w.examId, w.topicIds[0], "c", { type: "case" });
    const im = q(w.examId, w.topicIds[0], "i", { type: "image" });
    const a = att(w.examId, [r, cs, im]);
    [r, cs, im].forEach((x) => answerQuestion(a, x, 1));
    expect(retryQuestions(w.examId, w.topicIds, 10, { types: ["recall"] })).toEqual([r]);
    expect(new Set(retryQuestions(w.examId, w.topicIds, 10, { types: ["case", "image"] }))).toEqual(new Set([cs, im]));
  });

  it("end to end: recall style exam has no case-type retried question", async () => {
    const w = world(1);
    const cs = q(w.examId, w.topicIds[0], "c", { type: "case" });
    const a = att(w.examId, [cs]);
    answerQuestion(a, cs, 1);
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "recall", adaptive: false });
    await ready(id);
    expect(members(id).map((m) => m.question_id)).not.toContain(cs);
  });
});
