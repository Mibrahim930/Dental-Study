import { beforeEach, describe, expect, it, vi } from "vitest";

type Q = { question: string; options: string[]; correct_index: number; explanation: string; concept: string; id?: string; slot?: number; source_page_id?: number };
/** Planned slot numbers (1-based) asked for in a section-quiz prompt. */
const slotsIn = (content: string) => [...content.matchAll(/^Q(\d+):/gm)].map((m) => Number(m[1]));
/** The slide each planned slot tests ("Q3: slide P12 …"), or nothing for "the section". */
const pagesIn = (content: string) => new Map([...content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]));
/** By default the AI answers every planned slot with a distinct question. */
let quizResponse: (slots: number[]) => { questions: Q[] } = (slots) => ({
  questions: slots.map((n) => ({ ...mk(1)[0], question: `Question ${n}?`, options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`], concept: `Concept ${n % 3}`, slot: n, source_page_id: 0 })),
});
let genCalls: string[] = [];
/** The writer prompts (section quiz calls), in call order. */
let quizPrompts: string[] = [];
let summaryText = "sum";
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    genCalls.push(opts.purpose);
    if (opts.purpose === "section quiz") quizPrompts.push(opts.content);
    await new Promise((r) => setTimeout(r, 5));
    if (opts.purpose === "section quiz") {
      // A written question must cite one of the topic's slides: the mock fills in the slot's slide unless a test set one.
      const r = quizResponse(slotsIn(opts.content));
      const pages = pagesIn(opts.content);
      return { ...r, questions: r.questions.map((q) => (q.source_page_id ? q : { ...q, source_page_id: pages.get(q.slot ?? 0) ?? q.source_page_id })) };
    }
    if (opts.purpose === "section quiz check") return { verdicts: [] };
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
import { getSectionQuiz, getLesson, LESSON_VERSION, QUIZ_VERSION, type QuizQuestion } from "@/lib/study";
import { quizSize } from "@/lib/quizPlan";
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

/** Two topics with five one-fact slides each, so every quiz is five questions (one per fact). */
function world(slides = 2) {
  const userId = makeUser();
  const { examId, topicIds } = makeExam(userId, null, [slides, slides]);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  let n = 0;
  for (const topicId of topicIds) {
    const pages = Array.from({ length: FACTS }, () => {
      n++;
      const notes = JSON.stringify({ title: `slide ${n}`, summary: "s", image_description: null, key_facts: [`fact ${n}`], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });
      return Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(doc, n, notes).lastInsertRowid);
    });
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify(pages), topicId);
  }
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = (i = 0) => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicIds[i]) as Topic;
  return { userId, examId, topicIds, sessionId, topic };
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const get = (sessionId: number, position: number) => quizGET(new Request(`http://x/api/sessions/${sessionId}/quiz?position=${position}`), ctx(sessionId));
const post = (sessionId: number, body: unknown) =>
  checkPOST(new Request("http://x/c", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(sessionId));

/** Facts per topic in `world`, and so the quiz size: one question per fact. */
const FACTS = 5;
const SIZE = quizSize(Array.from({ length: FACTS }, (_, i) => ({ facts: [`fact ${i}`] })));

const defaultQuiz = quizResponse;
beforeEach(() => {
  genCalls = [];
  quizPrompts = [];
  quizResponse = defaultQuiz;
});

describe("getSectionQuiz", () => {
  it("a five-fact topic gets five questions: stable ids, shuffled consistently, cached as the current version", async () => {
    expect(SIZE).toBe(5);
    const w = world();
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(SIZE);
    for (const q of qs) {
      expect(q.options).toHaveLength(4);
      expect(q.options[q.correct_index]).toBe("b" + q.question.match(/\d+/)![0]);
      expect(q.id).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(new Set(qs.map((q) => q.id)).size).toBe(SIZE);
    expect(JSON.parse(w.topic().checks_json!)).toEqual(qs);
    expect(QUIZ_VERSION).toBe(5);
    expect(w.topic().checks_version).toBe(QUIZ_VERSION);
    await getSectionQuiz(w.topic());
    // Two writing calls splitting the plan in halves, and one checking pass, once.
    expect(genCalls.filter((c) => c === "section quiz")).toHaveLength(2);
    expect(genCalls.filter((c) => c === "section quiz check")).toHaveLength(1);
    const halves = quizPrompts.map((c) => slotsIn(c));
    expect(halves.map((h) => h.length)).toEqual([Math.ceil(SIZE / 2), Math.floor(SIZE / 2)]);
    expect(halves.flat()).toEqual(Array.from({ length: SIZE }, (_, i) => i + 1));
    // Every slot names its slide and pins its fact.
    expect(quizPrompts.every((c) => /^Q\d+: slide P\d+ — fact: /m.test(c))).toBe(true);
  });

  it("dedupes concurrent generation", async () => {
    const w = world();
    const t = w.topic();
    await Promise.all([getSectionQuiz(t), getSectionQuiz(t), getSectionQuiz(t)]);
    expect(genCalls).toHaveLength(3);
  });

  it("works for a topic with zero slides: one general question", async () => {
    const userId = makeUser();
    const { topicIds } = makeExam(userId, null, [0]);
    const t = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicIds[0]) as Topic;
    expect(await getSectionQuiz(t)).toHaveLength(1);
  });

  it("filters malformed answers, repairs the gaps once, and accepts a shorter quiz if the repair falls short", async () => {
    const w = world();
    let call = 0;
    quizResponse = (slots) => {
      call++;
      // First two calls: every 2nd slot comes back broken. Repair call: only half of what's asked.
      const keep = call <= 2 ? slots : slots.slice(0, Math.ceil(slots.length / 2));
      return {
        questions: keep.map((n) => ({
          ...mk(1)[0],
          question: `Q ${n} try ${call}?`,
          options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
          slot: n,
          ...(call <= 2 && n % 2 === 0 ? { correct_index: 9 } : {}),
        })),
      };
    };
    const qs = await getSectionQuiz(w.topic());
    expect(genCalls.filter((c) => c === "section quiz")).toHaveLength(3); // 2 + one repair, never more
    const broken = Math.floor(SIZE / 2); // slots 2 and 4
    expect(slotsIn(quizPrompts[2])).toEqual([2, 4]); // the repair asks for exactly the broken slots
    expect(qs).toHaveLength(SIZE - broken + Math.ceil(broken / 2)); // 2 broken, 1 of them repaired
    expect(w.topic().checks_json).not.toBeNull();
  });

  it("throws and does not cache when nothing valid comes back, then can retry", async () => {
    const w = world();
    quizResponse = (slots) => ({ questions: slots.map((n) => ({ ...mk(1)[0], question: `x${n}`, correct_index: -1, slot: n })) });
    await expect(getSectionQuiz(w.topic())).rejects.toThrow();
    expect(w.topic().checks_json).toBeNull();
    quizResponse = defaultQuiz;
    expect(await getSectionQuiz(w.topic())).toHaveLength(SIZE);
  });

  it("BUG? non-integer correct_index (1.5) passes validation and yields an unanswerable question", async () => {
    const w = world();
    quizResponse = (slots) => ({ questions: slots.map((n) => ({ ...mk(1)[0], question: `q${n}`, correct_index: 1.5, slot: n })) });
    let qs: QuizQuestion[] = [];
    try {
      qs = await getSectionQuiz(w.topic());
    } catch {
      /* dropping them all is acceptable */
    }
    expect(qs.every((q) => Number.isInteger(q.correct_index) && q.correct_index >= 0)).toBe(true);
  });

  it("BUG? duplicate/blank options are not rejected", async () => {
    const w = world();
    quizResponse = (slots) => ({ questions: slots.map((n) => ({ ...mk(1)[0], question: `q${n}`, options: ["x", "x", "", "  "], slot: n })) });
    let qs: QuizQuestion[] = [];
    try {
      qs = await getSectionQuiz(w.topic());
    } catch {
      /* ok */
    }
    expect(qs.every((q) => new Set(q.options.map((o) => o.trim())).size === q.options.length && q.options.every((o) => o.trim()))).toBe(true);
  });

  it("cached lessons with a leftover checks array still load", async () => {
    const w = world();
    // Stamped with the current lesson version: an unversioned lesson is now rewritten once on open (LESSON_VERSION).
    const lesson = {
      version: LESSON_VERSION,
      intro: "e",
      key_points: ["k"],
      slides: [],
      connections: null,
      checks: [{ question: "q", options: ["a", "b"], correct_index: 0, explanation: "x" }],
    };
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), w.topicIds[0]);
    expect(await getLesson(w.topic())).toMatchObject({ intro: "e" });
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

  it("answered is the student's progress on the section, across sessions (not per session)", async () => {
    const w = world();
    currentUserId = w.userId;
    const r = await (await get(w.sessionId, 0)).json();
    expect(r.questions).toHaveLength(SIZE);
    expect(r.answered).toEqual({});
    expect((await post(w.sessionId, { topicId: r.topicId, index: 2, chosen: 3 })).status).toBe(200);
    const s2 = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId).lastInsertRowid);
    expect((await (await get(w.sessionId, 0)).json()).answered).toEqual({ 2: 3 });
    // A new study session of the same exam resumes where she left it.
    expect((await (await get(s2, 0)).json()).answered).toEqual({ 2: 3 });
    // Another section of the same exam has its own progress.
    expect((await (await get(s2, 1)).json()).answered).toEqual({});
    // Re-answering the same question from session 2 changes nothing and writes no session-2 row.
    expect(await (await post(s2, { topicId: r.topicId, index: 2, chosen: 0 })).json()).toEqual({ ok: true });
    expect((await (await get(s2, 0)).json()).answered).toEqual({ 2: 3 });
    expect(db.prepare("SELECT COUNT(*) n FROM session_checks WHERE session_id = ?").get(s2)).toEqual({ n: 0 });
    // A new question answered in session 2 is recorded there, and shows in session 1 too.
    expect((await post(s2, { topicId: r.topicId, index: 4, chosen: 1 })).status).toBe(200);
    expect(db.prepare("SELECT check_index FROM session_checks WHERE session_id = ?").all(s2)).toEqual([{ check_index: 4 }]);
    expect((await (await get(w.sessionId, 0)).json()).answered).toEqual({ 2: 3, 4: 1 });
  });

  it("another student's answers on the same section don't show (progress is per student)", async () => {
    const w = world();
    currentUserId = w.userId;
    const r = await (await get(w.sessionId, 0)).json();
    expect((await post(w.sessionId, { topicId: r.topicId, index: 1, chosen: 2 })).status).toBe(200);
    // Simulate a second student's row on the same topic: it must not leak into this student's map.
    const other = makeUser();
    db.prepare("INSERT INTO quiz_answers (user_id, topic_id, check_index, chosen, correct) VALUES (?, ?, 3, 0, 0)").run(other, r.topicId);
    expect((await (await get(w.sessionId, 0)).json()).answered).toEqual({ 1: 2 });
  });

  it("returns 500 with a message when the AI fails, and a retry works", async () => {
    const w = world();
    currentUserId = w.userId;
    quizResponse = () => {
      throw new Error("boom");
    };
    const res = await get(w.sessionId, 0);
    expect(res.status).toBe(500);
    // The technical text stays in the server log; the student gets a plain message.
    const error = (await res.json()).error as string;
    expect(error).not.toContain("boom");
    expect(error).toMatch(/try again/i);
    quizResponse = defaultQuiz;
    expect((await get(w.sessionId, 0)).status).toBe(200);
  });

  it("a current-version checks_json (e.g. class-copied) is served as-is (no AI call)", async () => {
    const w = world();
    currentUserId = w.userId;
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(JSON.stringify(mk(10)), QUIZ_VERSION, w.topicIds[0]);
    const r = await (await get(w.sessionId, 0)).json();
    expect(r.questions).toHaveLength(10);
    expect(genCalls).toHaveLength(0);
  });

  it("a version-2 quiz (the old fixed 20) is rewritten once at the fact-based size", async () => {
    const w = world();
    currentUserId = w.userId;
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = 2 WHERE id = ?").run(JSON.stringify(mk(20)), w.topicIds[0]);
    expect((await post(w.sessionId, { topicId: w.topicIds[0], index: 15, chosen: 1 })).status).toBe(200);
    const r = await (await get(w.sessionId, 0)).json();
    expect(r.questions).toHaveLength(SIZE);
    expect(r.answered).toEqual({});
    expect(w.topic().checks_version).toBe(QUIZ_VERSION);
    expect(db.prepare("SELECT * FROM quiz_answers WHERE topic_id = ?").all(w.topicIds[0])).toEqual([]);
    await get(w.sessionId, 0);
    expect(genCalls.filter((c) => c === "section quiz")).toHaveLength(2);
  });

  it("an old 10-question quiz is rewritten once at the new size; answers given to it are detached but kept", async () => {
    const w = world();
    currentUserId = w.userId;
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(mk(10)), w.topicIds[0]);
    expect((await post(w.sessionId, { topicId: w.topicIds[0], index: 3, chosen: 1 })).status).toBe(200);
    const r = await (await get(w.sessionId, 0)).json();
    expect(r.questions).toHaveLength(SIZE);
    expect(r.answered).toEqual({}); // the old answer no longer points at a (different) question
    expect(db.prepare("SELECT * FROM quiz_answers WHERE topic_id = ?").all(w.topicIds[0])).toEqual([]);
    const rows = db.prepare("SELECT check_index, question FROM session_checks WHERE session_id = ?").all(w.sessionId) as { check_index: number | null; question: string }[];
    expect(rows).toEqual([{ check_index: null, question: "Question 3?" }]);
    await get(w.sessionId, 0);
    expect(genCalls.filter((c) => c === "section quiz")).toHaveLength(2); // only once
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
    expect(w.qs).toHaveLength(SIZE);
    for (const body of [
      { topicId: w.topicId, index: SIZE, chosen: 0 }, // one past the end of the fact-sized quiz
      { topicId: w.topicId, index: 19, chosen: 0 }, // valid under the old fixed 20, not now
      { topicId: w.topicId, index: 25, chosen: 0 },
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

  it("a second POST of the same index: 200, no second session_checks row, the first answer stays", async () => {
    const w = await ready();
    const right = w.qs[1].correct_index;
    const wrong = (right + 1) % 4;
    expect(await (await post(w.sessionId, { topicId: w.topicId, index: 1, chosen: wrong })).json()).toEqual({ ok: true, correct: false });
    const res = await post(w.sessionId, { topicId: w.topicId, index: 1, chosen: right });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rows(w.sessionId).map((r) => [r.check_index, r.chosen])).toEqual([[1, wrong]]);
    expect(db.prepare("SELECT chosen, correct FROM quiz_answers WHERE user_id = ? AND topic_id = ?").all(w.userId, w.topicId)).toEqual([{ chosen: wrong, correct: 0 }]);
    expect((await (await get(w.sessionId, 0)).json()).answered).toEqual({ 1: wrong });
  });

  it("quiz answers feed weakConcepts", async () => {
    const w = await ready();
    expect(w.qs).toHaveLength(SIZE);
    for (let i = 0; i < w.qs.length; i++) {
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

  it("deleting the topic cascades session_checks and quiz_answers", async () => {
    const w = await ready();
    await post(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id = ?").get(w.topicId)).toEqual({ n: 1 });
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicId);
    expect(rows(w.sessionId)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id = ?").get(w.topicId)).toEqual({ n: 0 });
  });
});
