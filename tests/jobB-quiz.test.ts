import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Verdict = { n: number; ok: boolean; reason: string };
const calls: { purpose: string; content: string }[] = [];
let judge: (questions: number) => Verdict[] = () => [];
let pageFor: (planned: number, slot: number) => number = (planned) => planned;
let tryNo = 0;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    if (opts.purpose === "section quiz") {
      tryNo++;
      const slots = [...opts.content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          question: `Q${s.n} on P${s.page} (try ${tryNo})`,
          options: ["right", "w1", "w2", "w3"],
          correct_index: 0,
          correct_answer: "right",
          explanation: "because (L1, slide 1)",
          source_page_id: pageFor(s.page, s.n),
          concept: "Quiz concept",
        })),
      };
    }
    if (opts.purpose === "section quiz check") {
      const n = (opts.content.match(/^\d+\. /gm) ?? []).length;
      return { verdicts: judge(n) };
    }
    throw new Error("unexpected " + opts.purpose);
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

import { db, type Topic } from "@/lib/db";
import { getSectionQuiz, QUIZ_SIZE, type QuizQuestion } from "@/lib/study";
import { removeDocument } from "@/lib/processing";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as reportPOST } from "@/app/api/sessions/[id]/quiz/report/route";
import { makeUser } from "./helpers";

const notes = (i: number, emphasized = false) =>
  JSON.stringify({
    title: `slide ${i}`,
    summary: "s",
    image_description: null,
    key_facts: ["a", "b"],
    annotations: [],
    emphasized,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
  });

/** One topic over `n` slides of one lecture (or split over two lectures with `split`). */
function world(n: number, o: { starred?: number[]; split?: number } = {}) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc1 = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const doc2 = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L2.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized) VALUES (?, ?, '', 'done', ?, ?)")
        .run(o.split != null && i >= o.split ? doc2 : doc1, i + 1, notes(i, o.starred?.includes(i)), o.starred?.includes(i) ? 1 : 0).lastInsertRowid,
    ),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, pages, topicId, sessionId, topic, doc1, doc2 };
}
const count = (purpose: string) => calls.filter((c) => c.purpose === purpose).length;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  calls.length = 0;
  judge = () => [];
  pageFor = (planned) => planned;
  tryNo = 0;
});
afterEach(() => {
  delete process.env.QUIZ_JUDGE;
});

describe("coverage-first section quiz", () => {
  it("12 slides: two calls of 10, 20 questions, every slide tested and tagged with its slide", async () => {
    const w = world(12);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(QUIZ_SIZE);
    expect(count("section quiz")).toBe(2);
    for (const c of calls.filter((x) => x.purpose === "section quiz")) expect([...c.content.matchAll(/^Q\d+:/gm)]).toHaveLength(10);
    const tested = new Set(qs.map((q) => q.source_page_id));
    for (const p of w.pages) expect(tested.has(p), `slide ${p}`).toBe(true);
    expect(qs.every((q) => q.kind)).toBe(true);
  });

  it("6 slides: still 20, extra questions on the starred slides, no duplicate questions", async () => {
    const w = world(6, { starred: [1, 4] });
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(20);
    const per = (p: number) => qs.filter((q) => q.source_page_id === p).length;
    expect(per(w.pages[1])).toBeGreaterThan(per(w.pages[0]));
    expect(per(w.pages[4])).toBeGreaterThan(per(w.pages[3]));
    expect(new Set(qs.map((q) => q.question)).size).toBe(20);
  });

  it("25 slides: 20 questions over 20 different slides", async () => {
    const w = world(25, { starred: [24] });
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(20);
    const tested = new Set(qs.map((q) => q.source_page_id));
    expect(tested.size).toBe(20);
    expect(tested.has(w.pages[24])).toBe(true);
  });

  it("the check rejects half: one repair call refills them, and the repaired ones are checked too", async () => {
    const w = world(12);
    let round = 0;
    judge = (n) => {
      round++;
      return round === 1 ? Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: i % 2 === 0, reason: "r" })) : [];
    };
    const qs = await getSectionQuiz(w.topic());
    expect(count("section quiz")).toBe(3);
    expect(count("section quiz check")).toBe(2);
    expect(qs).toHaveLength(20);
    expect(qs.filter((q) => q.question.includes("try 3"))).toHaveLength(10);
  });

  it("the check rejects everything, every time: no endless calls, a clear error, nothing cached", async () => {
    const w = world(4);
    judge = (n) => Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: false, reason: "wrong key" }));
    await expect(getSectionQuiz(w.topic())).rejects.toThrow(/couldn't write/i);
    expect(count("section quiz")).toBe(3);
    expect(w.topic().checks_json).toBeNull();
  });

  it("the check itself failing keeps the questions (the quiz isn't lost)", async () => {
    const w = world(5);
    judge = () => {
      throw new Error("judge down");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getSectionQuiz(w.topic())).toHaveLength(20);
    err.mockRestore();
  });

  it("QUIZ_JUDGE=0 turns the check off", async () => {
    process.env.QUIZ_JUDGE = "0";
    const w = world(5);
    expect(await getSectionQuiz(w.topic())).toHaveLength(20);
    expect(count("section quiz check")).toBe(0);
  });

  it("a question citing a slide outside the topic is dropped and repaired", async () => {
    const w = world(12);
    pageFor = (planned, slot) => (tryNo <= 2 && slot === 3 ? 999999 : planned);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(20);
    expect(qs.every((q) => w.pages.includes(q.source_page_id!))).toBe(true);
    expect(count("section quiz")).toBe(3);
  });

  it("links the quiz's concepts to the topic (they count toward its mastery)", async () => {
    const w = world(3);
    await getSectionQuiz(w.topic());
    const linked = db.prepare("SELECT c.name FROM topic_concepts tc JOIN concepts c ON c.id = tc.concept_id WHERE tc.topic_id = ?").all(w.topicId);
    expect(linked).toEqual([{ name: "Quiz concept" }]);
  });
});

describe("report a problem", () => {
  async function ready() {
    const w = world(4);
    currentUserId = w.userId;
    const res = await (await quizGET(new Request(`http://x/q?position=0`), ctx(w.sessionId))).json();
    return { ...w, qs: res.questions as QuizQuestion[] };
  }
  const report = (sessionId: number, body: unknown) => reportPOST(new Request("http://x/r", json(body)), ctx(sessionId));
  const check = (sessionId: number, body: unknown) => checkPOST(new Request("http://x/c", json(body)), ctx(sessionId));

  it("hides the question in place (positions unchanged); it can't be answered any more", async () => {
    const w = await ready();
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[2].id, note: " key is wrong " })).status).toBe(200);
    const after = JSON.parse(w.topic().checks_json!) as QuizQuestion[];
    expect(after).toHaveLength(20);
    expect(after[2]).toMatchObject({ id: w.qs[2].id, hidden: true, report_note: "key is wrong" });
    expect(after.filter((q) => q.hidden)).toHaveLength(1);
    expect((await check(w.sessionId, { topicId: w.topicId, index: 2, chosen: 0 })).status).toBe(400);
    expect((await check(w.sessionId, { topicId: w.topicId, index: 3, chosen: 0 })).status).toBe(200);
  });

  it("rejects strangers, other exams' topics and unknown ids", async () => {
    const w = await ready();
    const other = world(2);
    currentUserId = other.userId;
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[0].id })).status).toBe(404);
    currentUserId = w.userId;
    expect((await report(w.sessionId, { topicId: other.topicId, questionId: w.qs[0].id })).status).toBe(400);
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: "nope" })).status).toBe(400);
    expect((await report(w.sessionId, { topicId: w.topicId })).status).toBe(400);
    expect((await reportPOST(new Request("http://x/r", { method: "POST", body: "not json" }), ctx(w.sessionId))).status).toBe(400);
    expect((JSON.parse(w.topic().checks_json!) as QuizQuestion[]).some((q) => q.hidden)).toBe(false);
  });
});

describe("removing a lecture rewrites the topic's quiz and detaches its answers", () => {
  it("check_index becomes NULL (the row stays), the quiz is cleared", async () => {
    const w = world(4, { split: 2 });
    currentUserId = w.userId;
    await quizGET(new Request(`http://x/q?position=0`), ctx(w.sessionId));
    await checkPOST(new Request("http://x/c", json({ topicId: w.topicId, index: 1, chosen: 0 })), ctx(w.sessionId));
    await removeDocument(w.doc2);
    expect(w.topic().checks_json).toBeNull();
    expect(w.topic().checks_version).toBeNull();
    expect(db.prepare("SELECT check_index FROM session_checks WHERE session_id = ?").all(w.sessionId)).toEqual([{ check_index: null }]);
  });
});
