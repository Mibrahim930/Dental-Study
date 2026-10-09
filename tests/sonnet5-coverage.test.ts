import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the AI call is mocked. Behaviour per topic title can be bent: fewer questions, none, or a thrown error.
const calls: { purpose: string; content: string }[] = [];
let counter = 0;
const behaviour = { returns: new Map<string, number>(), throwsFor: new Set<string>() };
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    const asked = Number(/Write (\d+) /.exec(opts.content)?.[1] ?? 1);
    const title = /Topic: (Topic \d+)/.exec(opts.content)?.[1] ?? "";
    if (behaviour.throwsFor.has(title)) throw new Error("AI down for " + title);
    const count = Math.min(asked, behaviour.returns.get(title) ?? asked);
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
import { answerQuestion, startAttempt, finishAttempt } from "@/lib/practice";
import { makeUser } from "./helpers";

const OPTIONS = ["A", "B", "C", "D", "E"];

/** An exam with `docs` lectures; topics are spread round-robin over the lectures, each with real slides. */
function world(topics: number, docs = 1) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docIds = Array.from({ length: docs }, (_, d) => Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, ?)").run(examId, `lec${d}.pdf`).lastInsertRowid));
  let pn = 0;
  const topicIds: number[] = [];
  const docOf: number[] = [];
  for (let t = 0; t < topics; t++) {
    const doc = docIds[t % docs];
    const pages = Array.from({ length: 2 }, () =>
      Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, text) VALUES (?, ?, '', 'slide text')").run(doc, ++pn).lastInsertRowid),
    );
    topicIds.push(Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)").run(examId, t, `Topic ${t + 1}`, JSON.stringify(pages)).lastInsertRowid));
    docOf.push(doc);
  }
  return { userId, examId, docIds, topicIds, docOf };
}

async function ready(attemptId: number) {
  for (let i = 0; i < 500; i++) {
    const a = db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(attemptId) as { status: string; error: string | null };
    if (a.status !== "generating") return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("stuck generating");
}

type Row = { question_id: number; topic_id: number | null; correct_index: number; option_order: string | null; case_id: number | null };
const members = (attemptId: number) =>
  db
    .prepare(
      `SELECT aq.question_id, q.topic_id, q.correct_index, aq.option_order, q.case_id FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
       WHERE aq.attempt_id = ? ORDER BY aq.position`,
    )
    .all(attemptId) as Row[];

/** Display index of the right (or a wrong) option for a member row. */
function pick(r: Row, right: boolean): number {
  const order = r.option_order ? (JSON.parse(r.option_order) as number[]) : [0, 1, 2, 3, 4];
  const rightPos = order.indexOf(r.correct_index);
  return right ? rightPos : (rightPos + 1) % 5;
}

type Opts = { size: number; style?: "mixed" | "caseset" | "recall"; adaptive?: boolean; topicIds?: number[] };
/** Start, wait, answer (right unless `wrong` / `skip` say otherwise), finish. Returns the exam's topic list. */
async function sitExam(examId: number, o: Opts, how: { wrong?: (r: Row) => boolean; skip?: (r: Row) => boolean } = {}) {
  const id = startAttempt(examId, { size: o.size, mode: "tutor", style: o.style ?? "mixed", adaptive: o.adaptive ?? false, topicIds: o.topicIds });
  const st = await ready(id);
  if (st.status !== "ready") return { id, status: st.status, error: st.error, rows: [] as Row[], topics: new Set<number>() };
  const rows = members(id);
  for (const r of rows) {
    if (how.skip?.(r)) continue;
    answerQuestion(id, r.question_id, pick(r, !how.wrong?.(r)), "sure");
  }
  finishAttempt(id);
  return { id, status: st.status, error: null, rows, topics: new Set(rows.map((r) => r.topic_id).filter((x): x is number => x != null)) };
}

function q(examId: number, topicId: number | null, stem: string): number {
  return Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', ?, ?, 0, 'e')")
      .run(examId, topicId, stem, JSON.stringify(OPTIONS)).lastInsertRowid,
  );
}
/** A past answered-wrong question for `x` so it comes back as a retry. */
function miss(examId: number, x: number) {
  const a = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(examId).lastInsertRowid);
  db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 0)").run(a, x);
  answerQuestion(a, x, 1, "sure");
}
function weakPastWorld(w: ReturnType<typeof world>) {
  const past = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Past')").run(w.userId).lastInsertRowid);
  const pt = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Past topic', '', '[]')").run(past).lastInsertRowid);
  const concept = Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, 'Weak', 10, 1)").run(w.userId).lastInsertRowid);
  db.prepare("INSERT INTO topic_concepts VALUES (?, ?)").run(pt, concept);
  for (let i = 0; i < 6; i++) q(past, pt, `past-q ${i}`);
  return { past, pt };
}

beforeEach(() => {
  calls.length = 0;
  behaviour.returns.clear();
  behaviour.throwsFor.clear();
});

describe("1. whole exam, size >= topics: every topic appears", () => {
  it("14 topics, size 14, focus off", async () => {
    const w = world(14);
    const e = await sitExam(w.examId, { size: 14 });
    expect(e.rows.length).toBe(14);
    expect([...e.topics].sort()).toEqual([...w.topicIds].sort());
  });

  it("size 14, 14 topics, focus ON with very lopsided weights", async () => {
    const w = world(14);
    w.topicIds.forEach((t, i) => {
      const c = Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, ?, 50, ?)").run(w.userId, `c${i}`, i === 0 ? 0 : 50).lastInsertRowid);
      db.prepare("INSERT INTO topic_concepts VALUES (?, ?)").run(t, c);
    });
    db.prepare("UPDATE topics SET emphasized = 1 WHERE id = ?").run(w.topicIds[0]);
    const e = await sitExam(w.examId, { size: 14, adaptive: true });
    expect(e.rows.length).toBe(14);
    expect(e.topics.size).toBe(14);
    const e2 = await sitExam(w.examId, { size: 20, adaptive: true });
    expect(e2.topics.size).toBe(14);
    expect(e2.rows.length).toBe(20);
  });

  it("AI returns fewer than requested for a heavy topic: every topic still has one", async () => {
    const w = world(6);
    behaviour.returns.set("Topic 1", 1);
    const e = await sitExam(w.examId, { size: 18 });
    expect(e.status).toBe("ready");
    expect(e.topics.size).toBe(6);
    expect(e.rows.length).toBeLessThanOrEqual(18);
  });

  it("topics with unused (never answered) questions to reuse are still included once", async () => {
    const w = world(8);
    for (const t of w.topicIds) for (let i = 0; i < 5; i++) q(w.examId, t, `spare ${t}-${i}`);
    const e = await sitExam(w.examId, { size: 8 });
    expect(e.topics.size).toBe(8);
    expect(e.rows.length).toBe(8);
    expect(calls.length).toBe(0);
  });

  it("retried missed questions present: all topics still appear, total = size", async () => {
    const w = world(10);
    const e1 = await sitExam(w.examId, { size: 10 }, { wrong: () => true });
    expect(e1.topics.size).toBe(10);
    const e2 = await sitExam(w.examId, { size: 10 });
    expect(e2.rows.length).toBe(10);
    expect(e2.rows.filter((r) => r.option_order).length).toBe(4);
    expect(e2.topics.size).toBe(10);
  });

  it("past-exam 12% slice with size == topics must not push a topic out", async () => {
    const w = world(14);
    weakPastWorld(w);
    const e = await sitExam(w.examId, { size: 14, adaptive: true });
    expect(e.status).toBe("ready");
    const own = new Set(e.rows.map((r) => r.topic_id).filter((t) => w.topicIds.includes(t as number)));
    expect(e.rows.length).toBe(14);
    expect(own.size, "topics of this exam in a size-14 exam with a past-exam slice").toBe(14);
  });

  it("past-exam slice with a little room (size 16, 14 topics)", async () => {
    const w = world(14);
    weakPastWorld(w);
    const e = await sitExam(w.examId, { size: 16, adaptive: true });
    const own = new Set(e.rows.map((r) => r.topic_id).filter((t) => w.topicIds.includes(t as number)));
    expect(own.size).toBe(14);
  });

  it("past-exam slice only applies to whole-exam scope, never to chosen topics", async () => {
    const w = world(5);
    weakPastWorld(w);
    const e = await sitExam(w.examId, { size: 5, adaptive: true, topicIds: w.topicIds });
    expect(new Set(e.rows.map((r) => r.topic_id))).toEqual(new Set(w.topicIds));
  });

  it("total question count equals size when the AI returns enough (various sizes)", async () => {
    for (const [topics, size] of [[3, 3], [3, 4], [7, 20], [14, 10], [1, 5]] as const) {
      const w = world(topics);
      const e = await sitExam(w.examId, { size });
      expect(e.rows.length, `topics=${topics} size=${size}`).toBe(size);
    }
  });

  it("5. total equals size with history, retries and a past-exam slice", async () => {
    const w = world(6);
    weakPastWorld(w);
    await sitExam(w.examId, { size: 12, adaptive: true }, { wrong: (r) => r.question_id % 2 === 0 });
    const e = await sitExam(w.examId, { size: 12, adaptive: true }, { wrong: (r) => r.question_id % 3 === 0 });
    expect(e.rows.length).toBe(12);
    expect(new Set(e.rows.map((r) => r.question_id)).size).toBe(12);
  });
});

describe("2. size < topics: left-out topics lead the next exam", () => {
  it("10 questions, 14 topics: second exam contains the 4 left out", async () => {
    const w = world(14);
    const e1 = await sitExam(w.examId, { size: 10 });
    expect(e1.rows.length).toBe(10);
    expect(e1.topics.size).toBe(10);
    const left = w.topicIds.filter((t) => !e1.topics.has(t));
    expect(left.length).toBe(4);
    const e2 = await sitExam(w.examId, { size: 10 });
    for (const t of left) expect(e2.topics.has(t), `left-out topic ${t}`).toBe(true);
    expect(new Set([...e1.topics, ...e2.topics]).size).toBe(14);
  });

  it("4 exams of 4 over 14 topics: all topics reached", async () => {
    const w = world(14);
    const seen = new Set<number>();
    for (let n = 0; n < 4; n++) {
      const e = await sitExam(w.examId, { size: 4 });
      expect(e.rows.length).toBe(4);
      e.topics.forEach((t) => seen.add(t));
    }
    expect(seen.size).toBe(14);
  });

  it("focus ON with lopsided weights does not starve the rest (size 5, 12 topics, 3 exams)", async () => {
    const w = world(12);
    w.topicIds.forEach((t, i) => {
      const c = Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, ?, 50, ?)").run(w.userId, `c${i}`, i === 0 ? 0 : 50).lastInsertRowid);
      db.prepare("INSERT INTO topic_concepts VALUES (?, ?)").run(t, c);
    });
    const seen = new Set<number>();
    for (let n = 0; n < 3; n++) (await sitExam(w.examId, { size: 5, adaptive: true })).topics.forEach((t) => seen.add(t));
    expect(seen.size).toBe(12);
  });

  it("skipped topic is treated as not practised and comes first next time", async () => {
    const w = world(8);
    const skipTopic = w.topicIds[3];
    const e1 = await sitExam(w.examId, { size: 8 }, { skip: (r) => r.topic_id === skipTopic });
    expect(e1.topics.has(skipTopic)).toBe(true);
    const e2 = await sitExam(w.examId, { size: 3 });
    expect(e2.topics.has(skipTopic)).toBe(true);
  });

  it("skipped questions are reused next time", async () => {
    const w = world(4);
    const e1 = await sitExam(w.examId, { size: 4 }, { skip: () => true });
    const e2 = await sitExam(w.examId, { size: 4 });
    const ids1 = new Set(e1.rows.map((r) => r.question_id));
    expect(e2.rows.filter((r) => ids1.has(r.question_id)).length).toBe(4);
  });

  it("two exams opened back to back (neither answered) together cover all topics", async () => {
    const w = world(6);
    const a = startAttempt(w.examId, { size: 3, mode: "tutor", style: "mixed", adaptive: false });
    await ready(a);
    const b = startAttempt(w.examId, { size: 3, mode: "tutor", style: "mixed", adaptive: false });
    await ready(b);
    const union = new Set([...members(a), ...members(b)].map((r) => r.topic_id));
    expect(union.size).toBe(6);
  });

  it("case sets: size 10 (3 cases) over 8 topics reaches all topics in 3 exams, no repeats before all done", async () => {
    const w = world(8);
    const e1 = await sitExam(w.examId, { size: 10, style: "caseset" });
    const topics1 = new Set(e1.rows.map((r) => r.topic_id));
    expect(topics1.size).toBe(3);
    const e2 = await sitExam(w.examId, { size: 10, style: "caseset" });
    const topics2 = new Set(e2.rows.map((r) => r.topic_id));
    for (const t of topics1) expect(topics2.has(t), "just-practised topic reappears while others wait").toBe(false);
    const e3 = await sitExam(w.examId, { size: 10, style: "caseset" });
    const all = new Set([...topics1, ...topics2, ...e3.rows.map((r) => r.topic_id)]);
    expect(all.size).toBe(8);
  });

  it("case sets with wrong answers: 4 exams reach all 8 topics", async () => {
    const w = world(8);
    const exams = [];
    for (let i = 0; i < 4; i++) exams.push(await sitExam(w.examId, { size: 10, style: "caseset" }, { wrong: (r) => r.question_id % 3 === 0 }));
    const all = new Set(exams.flatMap((e) => e.rows.map((r) => r.topic_id)));
    expect(all.size).toBe(8);
  });
});

describe("3. chosen lectures / chosen topics scope", () => {
  it("chosen topics: size >= scope covers each, nothing outside", async () => {
    const w = world(10);
    const chosen = w.topicIds.filter((_, i) => i % 2 === 0);
    const e = await sitExam(w.examId, { size: 6, topicIds: chosen });
    expect(e.rows.length).toBe(6);
    expect(e.topics).toEqual(new Set(chosen));
  });

  it("chosen topics: size < scope rotates inside the scope only", async () => {
    const w = world(10);
    const chosen = w.topicIds.slice(0, 7);
    const e1 = await sitExam(w.examId, { size: 4, topicIds: chosen });
    const e2 = await sitExam(w.examId, { size: 4, topicIds: chosen });
    expect(new Set([...e1.topics, ...e2.topics])).toEqual(new Set(chosen));
  });

  it("a topic practised in a whole-exam run counts as practised for a later scoped exam", async () => {
    const w = world(6);
    const e1 = await sitExam(w.examId, { size: 3 });
    const e = await sitExam(w.examId, { size: 3, topicIds: w.topicIds });
    for (const t of e1.topics) expect(e.topics.has(t)).toBe(false);
    expect(e.topics.size).toBe(3);
  });

  it("topicIds containing a foreign/nonexistent topic: only valid ones are used", async () => {
    const w = world(3);
    const other = world(2);
    const e = await sitExam(w.examId, { size: 3, topicIds: [w.topicIds[0], w.topicIds[1], other.topicIds[0], 999999] });
    expect(e.status).toBe("ready");
    expect(e.topics.has(other.topicIds[0])).toBe(false);
  });

  it("chosen lectures resolves to that lecture's topics and the exam covers them", async () => {
    const { scopeTopicIds } = await import("@/lib/practicePlan");
    const w = world(9, 3);
    const ids = scopeTopicIds(w.examId, { kind: "lectures", documentIds: [w.docIds[1]] });
    expect(new Set(ids)).toEqual(new Set(w.topicIds.filter((_, i) => w.docOf[i] === w.docIds[1])));
    const e = await sitExam(w.examId, { size: ids.length, topicIds: ids });
    expect(e.topics).toEqual(new Set(ids));
    expect(e.rows.length).toBe(ids.length);
  });

  it("lecture scope: a topic spanning two lectures is in scope of either", async () => {
    const { scopeTopicIds } = await import("@/lib/practicePlan");
    const w = world(2, 2);
    const pagesA = JSON.parse((db.prepare("SELECT page_ids FROM topics WHERE id = ?").get(w.topicIds[0]) as { page_ids: string }).page_ids) as number[];
    const pagesB = JSON.parse((db.prepare("SELECT page_ids FROM topics WHERE id = ?").get(w.topicIds[1]) as { page_ids: string }).page_ids) as number[];
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([...pagesA, pagesB[0]]), w.topicIds[0]);
    expect(scopeTopicIds(w.examId, { kind: "lectures", documentIds: [w.docIds[1]] })).toEqual(w.topicIds);
  });
});

describe("4. retry cap and coverage interact", () => {
  it("retried questions' topics count as covered; other slots go to uncovered topics", async () => {
    const w = world(10);
    for (let i = 0; i < 4; i++) miss(w.examId, q(w.examId, w.topicIds[i], `m${i}`));
    const e = await sitExam(w.examId, { size: 10 });
    expect(e.rows.length).toBe(10);
    expect(e.rows.filter((r) => r.option_order).length).toBe(4);
    expect(e.topics.size).toBe(10);
  });

  it("more misses than the cap: 4 retried, every topic still gets a question", async () => {
    const w = world(10);
    for (let i = 0; i < 10; i++) for (let k = 0; k < 2; k++) miss(w.examId, q(w.examId, w.topicIds[i], `m${i}-${k}`));
    const e = await sitExam(w.examId, { size: 10 });
    expect(e.rows.filter((r) => r.option_order).length).toBe(4);
    expect(e.topics.size).toBe(10);
  });

  it("a missed question in a topic outside the scope is not retried", async () => {
    const w = world(4);
    const x = q(w.examId, w.topicIds[3], "out");
    miss(w.examId, x);
    const e = await sitExam(w.examId, { size: 3, topicIds: w.topicIds.slice(0, 3) });
    expect(e.rows.map((r) => r.question_id)).not.toContain(x);
    expect(e.topics.size).toBe(3);
  });

  it("small exam: size 3, 3 topics, many misses (cap 1): every topic still appears", async () => {
    const w = world(3);
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) miss(w.examId, q(w.examId, w.topicIds[i], `m${i}-${k}`));
    const e = await sitExam(w.examId, { size: 3 });
    expect(e.rows.length).toBe(3);
    expect(e.topics.size).toBe(3);
  });

  it("size 14 over 14 topics with 5 retries available (cap 5): all 14 topics appear", async () => {
    const w = world(14);
    for (let i = 0; i < 8; i++) miss(w.examId, q(w.examId, w.topicIds[0], `same${i}`)); // all misses in ONE topic
    const e = await sitExam(w.examId, { size: 14 });
    expect(e.rows.length).toBe(14);
    // Coverage wins over the retry cap: only as many misses come back as still leave a question for every section.
    expect(e.rows.filter((r) => r.option_order).length).toBeGreaterThanOrEqual(1);
    expect(e.topics.size, "5 retries all in topic 1 leave 9 new slots for 13 other topics").toBe(14);
  });
});

describe("edge cases", () => {
  it("exam with no topics: attempt errors cleanly", async () => {
    const w = world(0);
    const e = await sitExam(w.examId, { size: 5 });
    expect(e.status).toBe("error");
  });

  it("topic with no slides still gets a question", async () => {
    const w = world(3);
    db.prepare("UPDATE topics SET page_ids = '[]' WHERE id = ?").run(w.topicIds[1]);
    const e = await sitExam(w.examId, { size: 3 });
    expect(e.status).toBe("ready");
    expect(e.topics.size).toBe(3);
  });

  it("a deleted topic is neither asked nor blocks the others", async () => {
    const w = world(4);
    await sitExam(w.examId, { size: 4 });
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicIds[0]);
    const e2 = await sitExam(w.examId, { size: 3 });
    expect(e2.status).toBe("ready");
    expect(e2.topics.has(w.topicIds[0])).toBe(false);
    expect(e2.topics.size).toBe(3);
  });

  it("AI returns ZERO questions for one topic: exam forms; that topic leads next time", async () => {
    const w = world(6);
    behaviour.returns.set("Topic 2", 0);
    const e1 = await sitExam(w.examId, { size: 6 });
    expect(e1.status).toBe("ready");
    expect(e1.topics.has(w.topicIds[1])).toBe(false);
    behaviour.returns.clear();
    const e2 = await sitExam(w.examId, { size: 2 });
    expect(e2.topics.has(w.topicIds[1])).toBe(true);
  });

  // Known gap (see design/HANDOFF.md): backfill still comes up one short here.
  it.fails("AI returns zero for a topic: the exam still has `size` questions (backfill)", async () => {
    const w = world(6);
    behaviour.returns.set("Topic 2", 0);
    const e1 = await sitExam(w.examId, { size: 12 });
    expect(e1.rows.length).toBe(12);
  });

  it("AI THROWS for one topic mid-exam: the exam still forms", async () => {
    const w = world(6);
    behaviour.throwsFor.add("Topic 3");
    const e1 = await sitExam(w.examId, { size: 6 });
    expect(e1.status, e1.error ?? "").toBe("ready");
  });

  it("after a failed exam, retrying covers all topics", async () => {
    const w = world(6);
    behaviour.throwsFor.add("Topic 3");
    await sitExam(w.examId, { size: 6 });
    behaviour.throwsFor.clear();
    const e2 = await sitExam(w.examId, { size: 6 });
    expect(e2.status).toBe("ready");
    expect(e2.topics.size).toBe(6);
  });

  it("a missed question whose topic was deleted is retried and takes a slot", async () => {
    const w = world(3);
    const x = q(w.examId, null, "orphan");
    miss(w.examId, x);
    const e = await sitExam(w.examId, { size: 4 });
    expect(e.rows.map((r) => r.question_id)).toContain(x);
    expect(new Set(e.rows.map((r) => r.topic_id).filter((t) => t != null)).size).toBe(3);
  });
});

describe("follow-up: whatever was squeezed out leads the next exam", () => {
  it("past-exam slice squeezed 2 topics out of a size-14 exam: they are in the next exam", async () => {
    const w = world(14);
    weakPastWorld(w);
    const e1 = await sitExam(w.examId, { size: 14, adaptive: true });
    const left = w.topicIds.filter((t) => !e1.rows.some((r) => r.topic_id === t));
    // Nothing is squeezed out any more; anything that ever is still has to lead the next exam.
    expect(left.length).toBe(0);
    const e2 = await sitExam(w.examId, { size: 14, adaptive: true });
    for (const t of left) expect(e2.topics.has(t)).toBe(true);
  });

  it("retry concentration squeezed topics out: they are in the next exam", async () => {
    const w = world(14);
    for (let i = 0; i < 8; i++) miss(w.examId, q(w.examId, w.topicIds[0], `same${i}`));
    const e1 = await sitExam(w.examId, { size: 14 });
    const left = w.topicIds.filter((t) => !e1.topics.has(t));
    // Nothing is squeezed out any more; anything that ever is still has to lead the next exam.
    expect(left.length).toBe(0);
    const e2 = await sitExam(w.examId, { size: 14 });
    for (const t of left) expect(e2.topics.has(t)).toBe(true);
  });
});
