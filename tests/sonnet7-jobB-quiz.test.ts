import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { purpose: string; content: string }[] = [];
let tryNo = 0;
type Q = Record<string, unknown>;
let mutate: (q: Q, slot: number, page: number) => Q | null = (q) => q;
let verdicts: (n: number, call: number) => unknown = () => [];
let judgeThrows = false;
let judgeCalls = 0;
let repairThrows = false;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    if (opts.purpose === "section quiz") {
      tryNo++;
      if (repairThrows && tryNo > 2) throw new Error("repair down");
      // A slot names its slide ("slide P<id>"), or "the section" when the topic has no slides.
      const slots = [...opts.content.matchAll(/^Q(\d+): (?:slide P(\d+)|the section)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2] ?? 0) }));
      return {
        questions: slots
          .map((s) =>
            mutate(
              {
                slot: s.n,
                question: `Q${s.n} on P${s.page} (try ${tryNo})`,
                options: ["right", "w1", "w2", "w3"],
                correct_index: 0,
                correct_answer: "right",
                explanation: "because",
                source_page_id: s.page,
                concept: "Quiz concept",
              },
              s.n,
              s.page,
            ),
          )
          .filter(Boolean),
      };
    }
    if (opts.purpose === "section quiz check") {
      judgeCalls++;
      if (judgeThrows) throw new Error("judge down");
      const n = (opts.content.match(/^\d+\. /gm) ?? []).length;
      return { verdicts: verdicts(n, judgeCalls) };
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
import { getSectionQuiz, QUIZ_VERSION, type QuizQuestion } from "@/lib/study";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as reportPOST } from "@/app/api/sessions/[id]/quiz/report/route";
import { addSharedExam, createClass, shareExam, joinClass } from "@/lib/classes";
import { makeUser } from "./helpers";

// Two facts of its own per slide, so the quiz size is one per fact: 2 × slides (no floor, no cap).
const notes = (i: number) =>
  JSON.stringify({ title: `slide ${i}`, summary: "s", image_description: null, key_facts: [`fact a${i}`, `fact b${i}`], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });
/** The planned quiz size for an n-slide world. */
const sizeFor = (n: number) => (n === 0 ? 1 : Math.min(25, 2 * n));
function world(n: number, userId = makeUser()) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(doc, i + 1, notes(i)).lastInsertRowid),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, pages, topicId, sessionId, topic };
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  calls.length = 0;
  tryNo = 0;
  mutate = (q) => q;
  verdicts = () => [];
  judgeThrows = false;
  judgeCalls = 0;
  repairThrows = false;
});
afterEach(() => {
  delete process.env.QUIZ_JUDGE;
});

describe("quiz sizes", () => {
  // [slides, expected size, slides tested]: two questions per slide up to 25, then condensed; every slide still tested.
  for (const [n, size, tested] of [
    [1, 2, 1],
    [2, 4, 2],
    [3, 6, 3],
    [12, 24, 12],
    [13, 25, 13],
    [21, 25, 21],
  ]) {
    it(`${n}-slide topic gives ${size} distinct questions, all citing the topic's slides`, async () => {
      expect(sizeFor(n)).toBe(size);
      const w = world(n);
      const qs = await getSectionQuiz(w.topic());
      expect(qs).toHaveLength(size);
      expect(new Set(qs.map((q) => q.id)).size).toBe(size);
      expect(new Set(qs.map((q) => q.question)).size).toBe(size);
      expect(qs.every((q) => /^[0-9a-f]{8}$/.test(q.id!))).toBe(true);
      expect(qs.every((q) => w.pages.includes(q.source_page_id!))).toBe(true);
      expect(new Set(qs.map((q) => q.source_page_id)).size).toBe(tested);
    });
  }
  it("a 1-slide topic: its 2 fact questions and nothing more (no padding, so nothing to repeat)", async () => {
    const w = world(1);
    await getSectionQuiz(w.topic());
    const prompts = calls.filter((c) => c.purpose === "section quiz").map((c) => c.content);
    const lines = prompts.flatMap((c) => c.match(/^Q\d+: .*$/gm) ?? []);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.includes(`slide P${w.pages[0]}`))).toBe(true);
    const facts = lines.flatMap((l) => [...l.matchAll(/fact: "(.*?)"/g)].map((m) => m[1]));
    expect(facts.sort()).toEqual(["fact a0", "fact b0"]);
  });
  it("a topic with no slides at all still gets a one-question quiz", async () => {
    const w = world(0);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(1);
    expect(qs.every((q) => q.source_page_id == null)).toBe(true);
  });
});

describe("garbage from the AI", () => {
  for (const [name, slot] of [
    ["0", () => 0],
    ["negative", () => -4],
    ["999", () => 999],
    ["fraction", () => 2.5],
    ["NaN-ish string", () => "x"],
  ] as [string, () => unknown][]) {
    it(`slot ${name}: questions are matched by slide and the quiz is still full size`, async () => {
      const w = world(8);
      mutate = (q) => ({ ...q, slot: slot() });
      const qs = await getSectionQuiz(w.topic());
      expect(qs).toHaveLength(sizeFor(8));
      expect(new Set(qs.map((q) => q.question)).size).toBe(sizeFor(8));
      // Matched to the open slots of the slide they cite: both of each slide's facts are still tested there.
      for (const p of w.pages) expect(qs.filter((q) => q.source_page_id === p), `slide ${p}`).toHaveLength(2);
      expect(qs.every((q) => q.question.includes(`on P${q.source_page_id} `))).toBe(true);
    });
  }

  it("every question using the same slot number: at most one per planned slot, no crash", async () => {
    const w = world(6);
    mutate = (q) => ({ ...q, slot: 1 });
    const qs = await getSectionQuiz(w.topic());
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(sizeFor(6));
  });

  it("answer key contradicting itself, 1 option, duplicate options, index out of range are all dropped", async () => {
    const w = world(5);
    mutate = (q, slot) => {
      if (slot % 4 === 0) return { ...q, correct_index: 2 }; // text says "right" (index 0)
      if (slot % 4 === 1) return { ...q, options: ["only"], correct_answer: "only", correct_index: 0 };
      if (slot % 4 === 2) return { ...q, options: ["same", "same", "x", "y"], correct_answer: "same", correct_index: 0 };
      return q;
    };
    const qs = await getSectionQuiz(w.topic());
    for (const q of qs) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(new Set(q.options.map((o) => o.toLowerCase())).size).toBe(q.options.length);
      expect(q.options[q.correct_index]).toBe("right");
    }
  });

  it("the same question text written for every slot is stored only once", async () => {
    const w = world(5);
    mutate = (q) => ({ ...q, question: "What is it?" });
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(1);
  });

  it("the AI returns zero questions: clear error, nothing cached", async () => {
    const w = world(5);
    mutate = () => null;
    await expect(getSectionQuiz(w.topic())).rejects.toThrow();
    expect(w.topic().checks_json).toBeNull();
  });
});

describe("the checking pass", () => {
  it("nonsense verdict numbers (0, -1, 999, 1.5, NaN-like) reject nothing", async () => {
    const w = world(6);
    verdicts = () => [0, -1, 999, 1.5, 1e9].map((n) => ({ n, ok: false, reason: "x" }));
    expect(await getSectionQuiz(w.topic())).toHaveLength(sizeFor(6));
  });

  it("verdicts as a non-array / missing field does not lose the quiz", async () => {
    const w = world(5);
    verdicts = () => "garbage";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const qs = await getSectionQuiz(w.topic());
    err.mockRestore();
    expect(qs).toHaveLength(sizeFor(5));
  });

  it("judge throws on every call: quiz kept; repair throws too: first batch still saved", async () => {
    const w = world(5);
    judgeThrows = true;
    repairThrows = true;
    const half = Math.ceil(sizeFor(5) / 2); // 10 slots: Q1-Q5 in the first call, Q6-Q10 in the second
    mutate = (q, slot) => (slot > half ? null : q); // the second half is empty -> repair needed -> throws
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const qs = await getSectionQuiz(w.topic());
    err.mockRestore();
    expect(qs).toHaveLength(half);
    expect(calls.filter((c) => c.purpose === "section quiz")).toHaveLength(3);
    expect(w.topic().checks_version).toBe(QUIZ_VERSION);
    expect(QUIZ_VERSION).toBe(5);
  });

  it("judge rejects ok:false for the same question twice in verdicts - no double count", async () => {
    const w = world(5);
    verdicts = (n, call) => (call === 1 ? [{ n: 1, ok: false, reason: "a" }, { n: 1, ok: false, reason: "b" }] : []);
    expect(await getSectionQuiz(w.topic())).toHaveLength(sizeFor(5));
    // Exactly one slot was refilled.
    expect([...calls.filter((c) => c.purpose === "section quiz")[2].content.matchAll(/^Q\d+:/gm)]).toHaveLength(1);
  });

  it("QUIZ_JUDGE=0 makes no check calls even when repair is needed", async () => {
    process.env.QUIZ_JUDGE = "0";
    const w = world(5);
    mutate = (q, slot) => (slot === 3 && tryNo <= 2 ? null : q);
    await getSectionQuiz(w.topic());
    expect(calls.filter((c) => c.purpose === "section quiz check")).toHaveLength(0);
  });
});

describe("old 10-question quiz with answers", () => {
  it("is rewritten once, answers detached, rewrite not repeated, concurrent opens share one rewrite", async () => {
    const w = world(6);
    const old = Array.from({ length: 10 }, (_, i) => ({ question: `old ${i}`, options: ["a", "b", "c", "d"], correct_index: 0, explanation: "", concept: "c" }));
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(old), w.topicId);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'old 3', 1, 3, 0)").run(w.sessionId, w.topicId);
    db.prepare("INSERT INTO quiz_answers (user_id, topic_id, check_index, chosen, correct) VALUES (?, ?, 3, 0, 1)").run(w.userId, w.topicId);
    currentUserId = w.userId;
    const [a, b] = await Promise.all([quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId)), quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId))]);
    const ja = await a.json();
    const jb = await b.json();
    expect(ja.questions).toHaveLength(sizeFor(6));
    expect(jb.questions.map((q: QuizQuestion) => q.id)).toEqual(ja.questions.map((q: QuizQuestion) => q.id));
    expect(ja.answered).toEqual({});
    expect(db.prepare("SELECT check_index FROM session_checks WHERE topic_id = ?").all(w.topicId)).toEqual([{ check_index: null }]);
    expect(db.prepare("SELECT * FROM quiz_answers WHERE topic_id = ?").all(w.topicId)).toEqual([]);
    const n = calls.length;
    await quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId));
    expect(calls.length).toBe(n);
  });

  it("opening with a failing AI returns a 500 with a message and leaves the old quiz and its answers alone", async () => {
    const w = world(4);
    const old = [{ question: "old", options: ["a", "b"], correct_index: 0, explanation: "", concept: "c" }];
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(old), w.topicId);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'old', 1, 0, 0)").run(w.sessionId, w.topicId);
    mutate = () => null;
    currentUserId = w.userId;
    const res = await quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId));
    expect(res.status).toBe(500);
    expect(w.topic().checks_json).toBe(JSON.stringify(old));
    expect(db.prepare("SELECT check_index FROM session_checks WHERE topic_id = ?").all(w.topicId)).toEqual([{ check_index: 0 }]);
  });
});

describe("report and check routes", () => {
  async function ready() {
    const w = world(4);
    currentUserId = w.userId;
    const res = await (await quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId))).json();
    return { ...w, qs: res.questions as QuizQuestion[] };
  }
  const report = (s: number, body: unknown) => reportPOST(new Request("http://x/r", post(body)), ctx(s));

  it("huge note is cut to 500 characters; reporting twice is refused (no second record) and keeps the first note; hidden question can't be answered", async () => {
    const w = await ready();
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[0].id, note: "x".repeat(100000) })).status).toBe(200);
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[0].id, note: "second" })).status).toBe(400);
    const q = (JSON.parse(w.topic().checks_json!) as QuizQuestion[])[0];
    expect(q.report_note).toHaveLength(500);
    const r = await checkPOST(new Request("http://x/c", post({ topicId: w.topicId, index: 0, chosen: 0 })), ctx(w.sessionId));
    expect(r.status).toBe(400);
  });

  it("note of the wrong type, topicId as string/float, other user's session", async () => {
    const w = await ready();
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[1].id, note: { a: 1 } })).status).toBe(200);
    expect((await report(w.sessionId, { topicId: String(w.topicId), questionId: w.qs[2].id })).status).toBe(400);
    expect((await report(w.sessionId, { topicId: 1.5, questionId: w.qs[2].id })).status).toBe(400);
    const stranger = world(1);
    currentUserId = stranger.userId;
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[2].id })).status).toBe(404);
    expect((await checkPOST(new Request("http://x/c", post({ topicId: w.topicId, index: 2, chosen: 0 })), ctx(w.sessionId))).status).toBe(404);
    currentUserId = 0;
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[2].id })).status).toBe(401);
  });

  it("check route: negative/huge/fractional index and choice, double answer counts once", async () => {
    const w = await ready();
    const c = (b: unknown) => checkPOST(new Request("http://x/c", post(b)), ctx(w.sessionId));
    for (const b of [{ index: -1, chosen: 0 }, { index: 999, chosen: 0 }, { index: 1.5, chosen: 0 }, { index: 0, chosen: 9 }, { index: 0, chosen: -1 }, { index: 0, chosen: "1" }]) {
      expect((await c({ topicId: w.topicId, ...b })).status, JSON.stringify(b)).toBe(400);
    }
    expect((await c({ topicId: w.topicId, index: 0, chosen: 1 })).status).toBe(200);
    expect((await c({ topicId: w.topicId, index: 0, chosen: 2 })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM session_checks WHERE session_id = ?").get(w.sessionId)).toEqual({ n: 1 });
  });

  it("a class copy keeps quiz ids and the owner's reports (hidden class-wide), maps source_page_id to the copy's own slides, and answers don't travel", async () => {
    const w = await ready();
    await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[3].id, note: "bad key" });
    const classmate = makeUser();
    const classId = createClass(w.userId, "Class");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    joinClass(classmate, code);
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    const shared = shareExam(w.userId, classId, w.examId);
    expect(shared).toBeNull();
    const sharedId = Number((db.prepare("SELECT id FROM shared_exams WHERE class_id = ?").get(classId) as { id: number }).id);
    const res = addSharedExam(classmate, sharedId);
    expect("examId" in res).toBe(true);
    const copyExam = (res as { examId: number }).examId;
    const t2 = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(copyExam) as Topic;
    const copyQs = JSON.parse(t2.checks_json!) as QuizQuestion[];
    expect(t2.checks_version).toBe(QUIZ_VERSION);
    expect(w.qs).toHaveLength(sizeFor(4));
    expect(copyQs.map((q) => q.id)).toEqual(w.qs.map((q) => q.id));
    const copyPages = new Set(JSON.parse(t2.page_ids) as number[]);
    expect(copyQs.every((q) => q.source_page_id != null && copyPages.has(q.source_page_id))).toBe(true);
    expect(copyQs.some((q) => w.pages.includes(q.source_page_id!))).toBe(false);
    // The owner's "report a problem" hides the question in the owner's copy only; the classmate's copy starts clean.
    expect(copyQs.filter((q) => q.hidden).map((q) => q.id)).toEqual([w.qs[3].id]);
    expect(copyQs[3].report_note).toBe("bad key");
    expect(copyQs).toHaveLength(w.qs.length);
  });
});
