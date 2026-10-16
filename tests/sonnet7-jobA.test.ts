import { beforeEach, describe, expect, it, vi } from "vitest";

// QA (sonnet7) for Job A: practice exams never hold another exam's questions.
const calls: { purpose: string; content: string }[] = [];
let counter = 0;
let stemFor: (n: number) => string = (n) => `generated ${n}`;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    const asked = Number(/Write (\d+) /.exec(opts.content)?.[1] ?? 1);
    const page = Number(/\[P(\d+)\]/.exec(opts.content)?.[1] ?? 0);
    if (opts.purpose === "case sets") {
      return {
        cases: Array.from({ length: asked }, () => ({
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
      questions: Array.from({ length: asked }, () => ({
        type: "recall",
        image_page_id: null,
        patient_box: null,
        stem: stemFor(++counter),
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
let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { answerQuestion, dropForeignQuestions, startAttempt } from "@/lib/practice";
import { lecturePageIds, scopeTopicIds } from "@/lib/practicePlan";
import { POST as attemptsPOST } from "@/app/api/exams/[id]/attempts/route";
import { makeUser } from "./helpers";

const OPTS = JSON.stringify(["A", "B", "C", "D", "E"]);

function world(topicDocs: number[][], user = makeUser()) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(user).lastInsertRowid);
  const docCount = Math.max(...topicDocs.flat()) + 1;
  const docs = Array.from({ length: docCount }, (_, d) => Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, ?, 'done')").run(examId, `lec${d}.pdf`).lastInsertRowid));
  let pn = 0;
  const pageOf: Record<string, number> = {};
  const topicIds = topicDocs.map((ds, t) => {
    const pages = ds.map((d, k) => {
      const id = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, text) VALUES (?, ?, '', 'slide text')").run(docs[d], ++pn).lastInsertRowid);
      pageOf[`${t}.${k}`] = id;
      return id;
    });
    return Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)").run(examId, t, `Topic ${t + 1}`, JSON.stringify(pages)).lastInsertRowid);
  });
  return { userId: user, examId, docs, topicIds, pageOf };
}
function addQuestion(examId: number, topicId: number | null, stem: string, o: { page?: number | null; caseId?: number | null; type?: string } = {}) {
  return Number(
    db
      .prepare(
        "INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id, case_id) VALUES (?, ?, ?, ?, ?, 0, 'e', ?, ?)",
      )
      .run(examId, topicId, o.type ?? (o.caseId ? "case" : "recall"), stem, OPTS, o.page ?? null, o.caseId ?? null).lastInsertRowid,
  );
}
function addCase(examId: number) {
  return Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box) VALUES (?, 's', '{}')").run(examId).lastInsertRowid);
}
function attemptWith(examId: number, status: string, mode: string, qids: number[], startedMinAgo = 1, answered: number[] = []) {
  const id = Number(
    db
      .prepare(`INSERT INTO attempts (exam_id, mode, status, started_at, time_limit_sec) VALUES (?, ?, ?, datetime('now', '-${startedMinAgo} minutes'), ?)`)
      .run(examId, mode, status, mode === "timed" ? qids.length * 72 : null).lastInsertRowid,
  );
  qids.forEach((q, i) => {
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, ?, ?, ?)").run(id, q, i, answered.includes(q) ? 0 : null, answered.includes(q) ? 1 : null);
  });
  return id;
}
async function ready(attemptId: number) {
  for (let i = 0; i < 500; i++) {
    const a = db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(attemptId) as { status: string; error: string | null };
    if (a.status !== "generating") return a;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("still generating");
}
const qidsOf = (attemptId: number) =>
  (db.prepare("SELECT question_id FROM attempt_questions WHERE attempt_id = ? ORDER BY position").all(attemptId) as { question_id: number }[]).map((r) => r.question_id);

beforeEach(() => {
  calls.length = 0;
  counter = 0;
  stemFor = (n) => `generated ${n}`;
});

describe("Job A: lecture scope", () => {
  it("documentIds from another exam select nothing and never leak slides", () => {
    const a = world([[0], [0]]);
    const b = world([[0], [0]]);
    expect(lecturePageIds(a.examId, [b.docs[0]]).size).toBe(0);
    expect(scopeTopicIds(a.examId, { kind: "lectures", documentIds: [b.docs[0]] })).toEqual([]);
    expect(lecturePageIds(a.examId, [a.docs[0], b.docs[0]]).size).toBe(2);
  });

  it("the attempts route answers 400 for another exam's lecture ids, and 404 for an exam that isn't yours", async () => {
    const a = world([[0]]);
    const b = world([[0]]);
    currentUserId = a.userId;
    const req = (examId: number, body: unknown) => attemptsPOST(new Request("http://x/a", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(examId) }) } as never);
    expect((await req(a.examId, { scope: { kind: "lectures", documentIds: [b.docs[0]] } })).status).toBe(400);
    expect((await req(a.examId, { scope: { kind: "lectures", documentIds: [] } })).status).toBe(400);
    expect((await req(a.examId, { scope: { kind: "lectures", documentIds: ["x", null, 1.5] } })).status).toBe(400);
    expect((await req(b.examId, { scope: { kind: "all" } })).status).toBe(404);
  });

  it("a lecture whose slides all sit in topics shared with another lecture: only that lecture's slides reach the AI", async () => {
    // Both topics hold one slide from lecture 0 and one from lecture 1.
    const w = world([[0, 1], [0, 1]]);
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "recall", topicIds: w.topicIds, documentIds: [w.docs[0]], adaptive: false });
    const a = await ready(id);
    expect(a.status).toBe("ready");
    const ai = calls.filter((c) => c.purpose === "practice questions");
    expect(ai.length).toBeGreaterThan(0);
    for (const c of ai) {
      const ids = [...c.content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
      for (const other of [w.pageOf["0.1"], w.pageOf["1.1"]]) expect(ids).not.toContain(other);
    }
  });

  it("lecture scope: unanswered questions about the other lecture's slides are not reused", async () => {
    const w = world([[0, 1]]);
    const mine = addQuestion(w.examId, w.topicIds[0], "mine", { page: w.pageOf["0.0"] });
    const theirs = addQuestion(w.examId, w.topicIds[0], "theirs", { page: w.pageOf["0.1"] });
    const nopage = addQuestion(w.examId, w.topicIds[0], "no slide", { page: null });
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "recall", topicIds: w.topicIds, documentIds: [w.docs[0]], adaptive: false });
    await ready(id);
    const q = qidsOf(id);
    expect(q).toContain(mine);
    expect(q).not.toContain(theirs);
    expect(q).not.toContain(nopage);
  });
});

describe("Job A: exam isolation", () => {
  it("weak concepts + focus on in ANOTHER exam never put that exam's questions or stems in this one", async () => {
    const user = makeUser();
    const a = world([[0], [0]], user);
    const b = world([[0], [0]], user);
    // The student missed a question in exam B, sharing a concept name with exam A.
    const concept = Number(db.prepare("INSERT INTO concepts (user_id, name) VALUES (?, 'Shared concept')").run(user).lastInsertRowid);
    const qb = addQuestion(b.examId, b.topicIds[0], "B-ONLY STEM about pulpitis", { page: b.pageOf["0.0"] });
    db.prepare("UPDATE questions SET concept_id = ? WHERE id = ?").run(concept, qb);
    const att = attemptWith(b.examId, "finished", "tutor", [qb], 100);
    db.prepare("UPDATE attempt_questions SET chosen_index = 1, correct = 0, confidence = 'sure' WHERE attempt_id = ?").run(att);
    db.prepare("INSERT INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(a.topicIds[0], concept);
    db.prepare("UPDATE concepts SET attempts = 5, correct = 0 WHERE id = ?").run(concept);
    // Also an UNANSWERED stray from B sitting in a topic of A (corrupt data): must not be reused.
    const stray = addQuestion(b.examId, a.topicIds[0], "STRAY from B in A topic", { page: a.pageOf["0.0"] });

    const id = startAttempt(a.examId, { size: 6, mode: "tutor", style: "mixed", adaptive: true });
    const res = await ready(id);
    expect(res.status).toBe("ready");
    const rows = db.prepare("SELECT q.exam_id FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ?").all(id) as { exam_id: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.exam_id === a.examId)).toBe(true);
    expect(qidsOf(id)).not.toContain(stray);
    for (const c of calls) expect(c.content).not.toContain("B-ONLY STEM");
  });

  it("BUG?: a stray foreign question filed in this exam's topic is not even offered to the AI as 'already asked'", async () => {
    const user = makeUser();
    const a = world([[0]], user);
    const b = world([[0]], user);
    addQuestion(b.examId, a.topicIds[0], "FOREIGN STEM IN A TOPIC", { page: a.pageOf["0.0"] });
    // not a failure either way; just documents behaviour (stray row only influences the avoid-list)
    const id = startAttempt(a.examId, { size: 5, mode: "tutor", style: "recall", adaptive: false });
    await ready(id);
    expect(qidsOf(id).every((q) => (db.prepare("SELECT exam_id FROM questions WHERE id = ?").get(q) as { exam_id: number }).exam_id === a.examId)).toBe(true);
  });

  it("case set: a case with questions in two topics is never added twice to one exam", async () => {
    // A rebuild can move one question of a case to a different topic (questions follow their source slide).
    const w = world([[0], [0]]);
    const c = addCase(w.examId);
    addQuestion(w.examId, w.topicIds[0], "case q1", { page: w.pageOf["0.0"], caseId: c });
    addQuestion(w.examId, w.topicIds[1], "case q2", { page: w.pageOf["1.0"], caseId: c });
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset", adaptive: false });
    const res = await ready(id);
    expect(res.error ?? "").toBe("");
    expect(res.status).toBe("ready");
    const q = qidsOf(id);
    expect(new Set(q).size).toBe(q.length);
  });

  it("duplicates from the AI: the same stem over and over does not loop forever or add a stem twice", async () => {
    stemFor = () => "the very same stem";
    const w = world([[0], [0], [0]]);
    const id = startAttempt(w.examId, { size: 9, mode: "tutor", style: "recall", adaptive: false });
    const res = await ready(id);
    expect(["ready", "error"]).toContain(res.status);
    if (res.status === "ready") {
      const stems = qidsOf(id).map((q) => (db.prepare("SELECT stem FROM questions WHERE id = ?").get(q) as { stem: string }).stem);
      // one stem per topic at most (dedupe is per topic), never more than the number of topics
      expect(stems.length).toBeLessThanOrEqual(3);
    }
    expect(calls.length).toBeLessThan(30);
  });
});

describe("Job A: dropForeignQuestions", () => {
  it("removes unanswered foreign questions (recall + case + mix), renumbers, shrinks a timed clock, leaves answered ones", () => {
    const user = makeUser();
    const a = world([[0]], user);
    const b = world([[0]], user);
    const own1 = addQuestion(a.examId, a.topicIds[0], "own1");
    const own2 = addQuestion(a.examId, a.topicIds[0], "own2");
    const foreignCase = addQuestion(b.examId, b.topicIds[0], "fcase", { caseId: addCase(b.examId) });
    const foreignRecall = addQuestion(b.examId, b.topicIds[0], "frecall");
    const foreignAnswered = addQuestion(b.examId, b.topicIds[0], "fanswered");
    const att = attemptWith(a.examId, "ready", "timed", [foreignCase, own1, foreignRecall, foreignAnswered, own2], 1, [foreignAnswered]);
    expect(dropForeignQuestions()).toBe(2);
    expect(qidsOf(att)).toEqual([own1, foreignAnswered, own2]);
    const pos = db.prepare("SELECT position FROM attempt_questions WHERE attempt_id = ? ORDER BY position").all(att);
    expect(pos).toEqual([{ position: 0 }, { position: 1 }, { position: 2 }]);
    expect((db.prepare("SELECT time_limit_sec t FROM attempts WHERE id = ?").get(att) as { t: number }).t).toBe(3 * 72);
    expect(dropForeignQuestions()).toBe(0);
  });

  it("an exam left with nothing becomes an error with a friendly message; finished exams are never touched", () => {
    const user = makeUser();
    const a = world([[0]], user);
    const b = world([[0]], user);
    const f1 = addQuestion(b.examId, b.topicIds[0], "f1");
    const f2 = addQuestion(b.examId, b.topicIds[0], "f2");
    const open = attemptWith(a.examId, "ready", "tutor", [f1, f2]);
    const done = attemptWith(a.examId, "finished", "tutor", [f1, f2]);
    expect(dropForeignQuestions()).toBe(2);
    expect(db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(open)).toMatchObject({ status: "error" });
    expect(qidsOf(done)).toEqual([f1, f2]);
  });

  it("tutor exam keeps time_limit_sec NULL", () => {
    const user = makeUser();
    const a = world([[0]], user);
    const b = world([[0]], user);
    const own = addQuestion(a.examId, a.topicIds[0], "own");
    const f = addQuestion(b.examId, b.topicIds[0], "f");
    const att = attemptWith(a.examId, "ready", "tutor", [own, f]);
    dropForeignQuestions();
    expect((db.prepare("SELECT time_limit_sec t FROM attempts WHERE id = ?").get(att) as { t: number | null }).t).toBeNull();
  });

  it("fixed: shortening a running timed exam never leaves negative time (time already spent is allowed for)", () => {
    const user = makeUser();
    const a = world([[0]], user);
    const b = world([[0]], user);
    const own = Array.from({ length: 10 }, (_, i) => addQuestion(a.examId, a.topicIds[0], `own${i}`));
    const foreign = Array.from({ length: 10 }, (_, i) => addQuestion(b.examId, b.topicIds[0], `f${i}`));
    // 20 questions = 24 minutes; the student has used 15 minutes (9 left).
    const att = attemptWith(a.examId, "ready", "timed", [...own, ...foreign], 15);
    dropForeignQuestions();
    const row = db.prepare("SELECT (strftime('%s','now') - strftime('%s', started_at)) AS used, time_limit_sec AS lim FROM attempts WHERE id = ?").get(att) as { used: number; lim: number };
    // New limit is 12 min and 15 min were used: the exam is suddenly over. A fair repair would never reduce the time left below what it was or at least keep >0.
    expect(row.lim - row.used).toBeGreaterThan(0);
  });

  it("answerQuestion on a dropped question does nothing", () => {
    const user = makeUser();
    const a = world([[0]], user);
    const b = world([[0]], user);
    const own = addQuestion(a.examId, a.topicIds[0], "own");
    const f = addQuestion(b.examId, b.topicIds[0], "f");
    const att = attemptWith(a.examId, "ready", "tutor", [own, f]);
    dropForeignQuestions();
    answerQuestion(att, f, 0);
    expect(db.prepare("SELECT COUNT(*) n FROM attempt_questions WHERE attempt_id = ? AND question_id = ?").get(att, f)).toEqual({ n: 0 });
  });
});
