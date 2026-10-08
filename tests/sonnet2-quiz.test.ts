import { beforeEach, describe, expect, it, vi } from "vitest";

type Q = { question: string; options: string[]; correct_index: number; explanation: string; concept: string };
let quizResponse: () => { questions: Q[] } = () => ({ questions: [] });
let genCalls: string[] = [];
let summaryText = "sum";
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    genCalls.push(opts.purpose);
    await new Promise((r) => setTimeout(r, 5));
    if (opts.purpose === "section quiz") return quizResponse();
    if (opts.purpose === "session summary") return { summary: summaryText };
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
import { getSectionQuiz, getLesson, QUIZ_SIZE } from "@/lib/study";
import { weakConcepts } from "@/lib/memory";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as endPOST } from "@/app/api/sessions/[id]/end/route";
import { makeUser, makeExam } from "./helpers";

const mk = (n: number, over: Partial<Q> = {}): Q[] =>
  Array.from({ length: n }, (_, i) => ({
    question: `Question ${i}?`,
    options: [`a${i}`, `b${i}`, `c${i}`, `d${i}`],
    correct_index: 1,
    explanation: "because",
    concept: `Concept ${i % 3}`,
    ...over,
  }));

function world(slides = 2) {
  const userId = makeUser();
  const { examId, topicIds } = makeExam(userId, null, [slides, slides]);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = (i = 0) => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicIds[i]) as Topic;
  return { userId, examId, topicIds, sessionId, topic };
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const get = (sessionId: number, position: number) => quizGET(new Request(`http://x/api/sessions/${sessionId}/quiz?position=${position}`), ctx(sessionId));
const post = (sessionId: number, body: unknown) =>
  checkPOST(new Request("http://x/c", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(sessionId));

beforeEach(() => {
  genCalls = [];
  quizResponse = () => ({ questions: mk(QUIZ_SIZE) });
});

describe("getSectionQuiz", () => {
  it("returns 10 questions, shuffled consistently, cached in checks_json", async () => {
    const w = world();
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(10);
    for (const q of qs) {
      expect(q.options).toHaveLength(4);
      expect(q.options[q.correct_index]).toBe("b" + q.question.match(/\d+/)![0]);
    }
    expect(JSON.parse(w.topic().checks_json!)).toEqual(qs);
    await getSectionQuiz(w.topic());
    expect(genCalls.filter((c) => c === "section quiz")).toHaveLength(1);
  });

  it("dedupes concurrent generation", async () => {
    const w = world();
    const t = w.topic();
    await Promise.all([getSectionQuiz(t), getSectionQuiz(t), getSectionQuiz(t)]);
    expect(genCalls).toHaveLength(1);
  });

  it("works for a topic with zero slides", async () => {
    const userId = makeUser();
    const { topicIds } = makeExam(userId, null, [0]);
    const t = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicIds[0]) as Topic;
    expect(await getSectionQuiz(t)).toHaveLength(10);
  });

  it("truncates >10 and filters malformed, accepts <10 and caches the short quiz permanently", async () => {
    const w = world();
    quizResponse = () => ({ questions: [...mk(8), { ...mk(1)[0], options: ["only"] }, { ...mk(1)[0], correct_index: 9 }, ...mk(5)] });
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(10);
    const w2 = world();
    quizResponse = () => ({ questions: mk(3) });
    expect(await getSectionQuiz(w2.topic())).toHaveLength(3); // documented behaviour: no top-up/retry
    expect(w2.topic().checks_json).not.toBeNull();
  });

  it("throws and does not cache when nothing valid comes back, then can retry", async () => {
    const w = world();
    quizResponse = () => ({ questions: mk(4, { correct_index: -1 }) });
    await expect(getSectionQuiz(w.topic())).rejects.toThrow();
    expect(w.topic().checks_json).toBeNull();
    quizResponse = () => ({ questions: mk(10) });
    expect(await getSectionQuiz(w.topic())).toHaveLength(10);
  });

  it("BUG? non-integer correct_index (1.5) passes validation and yields an unanswerable question", async () => {
    const w = world();
    quizResponse = () => ({ questions: mk(10, { correct_index: 1.5 }) });
    let qs: Q[] = [];
    try {
      qs = await getSectionQuiz(w.topic());
    } catch {
      /* dropping them all is acceptable */
    }
    expect(qs.every((q) => Number.isInteger(q.correct_index) && q.correct_index >= 0)).toBe(true);
  });

  it("BUG? duplicate/blank options are not rejected", async () => {
    const w = world();
    quizResponse = () => ({ questions: mk(10, { options: ["x", "x", "", "  "] }) });
    let qs: Q[] = [];
    try {
      qs = await getSectionQuiz(w.topic());
    } catch {
      /* ok */
    }
    expect(qs.every((q) => new Set(q.options.map((o) => o.trim())).size === q.options.length && q.options.every((o) => o.trim()))).toBe(true);
  });

  it("old cached lessons with a checks array still load", async () => {
    const w = world();
    const lesson = { explanation: "e", key_points: ["k"], slides: [], connections: null, checks: [{ question: "q", options: ["a", "b"], correct_index: 0, explanation: "x" }] };
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), w.topicIds[0]);
    expect(await getLesson(w.topic())).toMatchObject({ explanation: "e" });
    expect(genCalls).toHaveLength(0);
  });
});

describe("GET /quiz", () => {
  it("requires sign-in, ownership, and a valid position", async () => {
    const w = world();
    currentUserId = 0;
    expect((await get(w.sessionId, 0)).status).toBe(401);
    currentUserId = makeUser();
    expect((await get(w.sessionId, 0)).status).toBe(404);
    currentUserId = w.userId;
    expect((await get(w.sessionId, 5)).status).toBe(404);
    expect((await get(w.sessionId, -1)).status).toBe(404);
    const bad = await quizGET(new Request(`http://x/q?position=abc`), ctx(w.sessionId));
    expect(bad.status).toBe(404);
    expect((await get(9999999, 0)).status).toBe(404);
  });

  it("returns questions and answered map per session only", async () => {
    const w = world();
    currentUserId = w.userId;
    const r = await (await get(w.sessionId, 0)).json();
    expect(r.questions).toHaveLength(10);
    expect(r.answered).toEqual({});
    expect((await post(w.sessionId, { topicId: r.topicId, index: 2, chosen: 3 })).status).toBe(200);
    const s2 = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId).lastInsertRowid);
    expect((await (await get(w.sessionId, 0)).json()).answered).toEqual({ 2: 3 });
    expect((await (await get(s2, 0)).json()).answered).toEqual({});
  });

  it("returns 500 with a message when the AI fails, and a retry works", async () => {
    const w = world();
    currentUserId = w.userId;
    quizResponse = () => {
      throw new Error("boom");
    };
    const res = await get(w.sessionId, 0);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("boom");
    quizResponse = () => ({ questions: mk(10) });
    expect((await get(w.sessionId, 0)).status).toBe(200);
  });

  it("class-copied checks_json is served as-is (no AI call)", async () => {
    const w = world();
    currentUserId = w.userId;
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(mk(10)), w.topicIds[0]);
    await get(w.sessionId, 0);
    expect(genCalls).toHaveLength(0);
  });
});

describe("POST /check", () => {
  async function ready() {
    const w = world();
    currentUserId = w.userId;
    const r = await (await get(w.sessionId, 0)).json();
    const qs = r.questions as Q[];
    return { ...w, topicId: r.topicId as number, qs };
  }
  const rows = (sessionId: number) =>
    db.prepare("SELECT * FROM session_checks WHERE session_id = ? ORDER BY check_index").all(sessionId) as { correct: number; check_index: number; chosen: number }[];

  it("decides correctness server-side and records it", async () => {
    const w = await ready();
    const right = w.qs[0].correct_index;
    const res = await (await post(w.sessionId, { topicId: w.topicId, index: 0, chosen: right })).json();
    expect(res).toEqual({ ok: true, correct: true });
    const wrong = (w.qs[1].correct_index + 1) % 4;
    expect(await (await post(w.sessionId, { topicId: w.topicId, index: 1, chosen: wrong })).json()).toEqual({ ok: true, correct: false });
    expect(rows(w.sessionId).map((r) => [r.check_index, r.correct, r.chosen])).toEqual([
      [0, 1, right],
      [1, 0, wrong],
    ]);
  });

  it("rejects other users, other exams' topics, out-of-range and non-integer input", async () => {
    const w = await ready();
    const other = world();
    currentUserId = other.userId;
    expect((await post(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 })).status).toBe(404);
    currentUserId = w.userId;
    expect((await post(w.sessionId, { topicId: other.topicIds[0], index: 0, chosen: 0 })).status).toBe(400);
    for (const body of [
      { topicId: w.topicId, index: 10, chosen: 0 },
      { topicId: w.topicId, index: -1, chosen: 0 },
      { topicId: w.topicId, index: 0, chosen: 4 },
      { topicId: w.topicId, index: 0, chosen: -1 },
      { topicId: w.topicId, index: 0, chosen: 1.5 },
      { topicId: w.topicId, index: 0, chosen: "1" },
      { topicId: w.topicId, index: 0, chosen: null },
      { topicId: 123456, index: 0, chosen: 0 },
    ]) {
      expect((await post(w.sessionId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(rows(w.sessionId)).toHaveLength(0);
  });

  it("returns 400 (not 500) when the topic has no quiz yet", async () => {
    const w = world();
    currentUserId = w.userId;
    expect((await post(w.sessionId, { topicId: w.topicIds[1], index: 0, chosen: 0 })).status).toBe(400);
  });

  it("BUG? malformed index values (length, constructor, fractional) give an error instead of a 400", async () => {
    const w = await ready();
    for (const index of ["length", "constructor", 0.5]) {
      const res = await post(w.sessionId, { topicId: w.topicId, index, chosen: 0 }).catch(() => null);
      expect(res && res.status, String(index)).toBe(400);
    }
  });

  it("BUG? invalid JSON body throws instead of a 400", async () => {
    const w = await ready();
    const res = await post(w.sessionId, "not json").catch(() => null);
    expect(res && res.status).toBe(400);
  });

  it("two tabs / double submit: second answer ignored, mastery counted once, first answer wins", async () => {
    const w = await ready();
    const q = w.qs[0];
    const right = q.correct_index;
    const wrong = (right + 1) % 4;
    const [a, b] = await Promise.all([
      post(w.sessionId, { topicId: w.topicId, index: 0, chosen: wrong }),
      post(w.sessionId, { topicId: w.topicId, index: 0, chosen: right }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(rows(w.sessionId)).toHaveLength(1);
    const c = db.prepare("SELECT attempts FROM concepts WHERE user_id = ? AND name = ?").get(w.userId, q.concept) as { attempts: number };
    expect(c.attempts).toBe(1);
  });

  it("duplicate response lacks `correct` (UI computes locally) - documented", async () => {
    const w = await ready();
    await post(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 });
    expect(await (await post(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 })).json()).toEqual({ ok: true });
  });

  it("quiz answers feed weakConcepts", async () => {
    const w = await ready();
    for (let i = 0; i < 10; i++) {
      const wrong = (w.qs[i].correct_index + 1) % 4;
      await post(w.sessionId, { topicId: w.topicId, index: i, chosen: wrong });
    }
    const weak = weakConcepts(w.userId, 10).map((c) => c.name);
    expect(weak).toEqual(expect.arrayContaining(["Concept 0", "Concept 1", "Concept 2"]));
  });

  it("empty-string concept is skipped; whitespace-only concept must not create a blank-named concept", async () => {
    const w = world();
    currentUserId = w.userId;
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(
      JSON.stringify([...mk(1, { concept: "" }), ...mk(1, { concept: "   " })]),
      w.topicIds[0],
    );
    expect((await post(w.sessionId, { topicId: w.topicIds[0], index: 0, chosen: 0 })).status).toBe(200);
    expect((await post(w.sessionId, { topicId: w.topicIds[0], index: 1, chosen: 0 })).status).toBe(200);
    const blank = db.prepare("SELECT COUNT(*) n FROM concepts WHERE user_id = ? AND trim(name) = ''").get(w.userId) as { n: number };
    expect(blank.n).toBe(0);
  });

  it("session end summary works with new rows", async () => {
    const w = await ready();
    await post(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 });
    summaryText = "Did well";
    const res = await endPOST(new Request("http://x/e", { method: "POST" }), ctx(w.sessionId));
    expect((await res.json()).summary).toBe("Did well");
    expect(genCalls).toContain("session summary");
  });

  it("deleting the topic cascades session_checks", async () => {
    const w = await ready();
    await post(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 });
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicId);
    expect(rows(w.sessionId)).toHaveLength(0);
  });
});
