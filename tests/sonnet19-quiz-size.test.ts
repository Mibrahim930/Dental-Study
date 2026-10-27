import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const calls: { purpose: string; content: string }[] = [];
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    if (opts.purpose === "lesson") return { explanation: "Lesson text", key_points: ["a", "b", "c", "d"], slides: [], connections: null };
    if (opts.purpose === "session summary") return { summary: "Summed up" };
    if (opts.purpose === "section quiz") {
      const slots = [...opts.content.matchAll(/^Q(\d+): (?:slide P(\d+)|the section)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2] ?? 0) }));
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          question: `Q${s.n} on P${s.page} #${calls.length}`,
          options: ["right", "w1", "w2", "w3"],
          correct_index: 0,
          correct_answer: "right",
          explanation: "because",
          source_page_id: s.page,
          concept: "C",
        })),
      };
    }
    if (opts.purpose === "section quiz check") {
      const n = (opts.content.match(/^\d+\. /gm) ?? []).length;
      return { verdicts: Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: true, reason: "" })) };
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
import * as study from "@/lib/study";
import { getSectionQuiz, quizIsCurrent, QUIZ_VERSION } from "@/lib/study";
import { planQuizByFacts, quizSize, type FactSlide } from "@/lib/quizPlan";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as regenPOST } from "@/app/api/sessions/[id]/quiz/regenerate/route";
import { POST as endPOST } from "@/app/api/sessions/[id]/end/route";
import { makeUser } from "./helpers";

const notes = (facts: string[]) =>
  JSON.stringify({ title: "s", summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

/** One topic; each entry of `slides` is the facts of one slide (null = a page with no notes at all). */
function world(slides: (string[] | null)[], userId = makeUser()) {
  currentUserId = userId;
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = slides.map((f, i) =>
    Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(docId, i + 1, f ? notes(f) : null).lastInsertRowid),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, pages, topicId, sessionId, topic };
}
/** n slides with `per` distinct facts each. */
const distinct = (n: number, per = 1) => Array.from({ length: n }, (_, i) => Array.from({ length: per }, (_, k) => `fact ${i} ${k}`));
const storeQuiz = (topicId: number, version: number | null, nQ = 3) =>
  db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(
    JSON.stringify(Array.from({ length: nQ }, (_, i) => ({ id: `old${i}`, question: `Old ${i}?`, options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", kind: "recall" }))),
    version,
    topicId,
  );
const writes = () => calls.filter((c) => c.purpose === "section quiz");
const slotsOf = (content: string) => [...content.matchAll(/^Q\d+:/gm)].length;
const factsIn = (content: string) => [...content.matchAll(/^Q\d+: .* — fact: "(.*)" — /gm)].map((m) => m[1]);
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const post = (route: (r: Request, c: never) => Promise<Response>, id: number, body: unknown) => route(new Request("http://x/p", { method: "POST", body: JSON.stringify(body) }), ctx(id));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 100; i++) await tick();
}
const slide = (id: number, facts: string[], o: Partial<FactSlide> = {}): FactSlide => ({ id, keyFacts: facts.length, emphasized: false, hasCase: false, facts, ...o });

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  delete process.env.QUIZ_JUDGE;
});

describe("quizSize / planQuizByFacts edge cases", () => {
  it("quizSize: no slides is 1; blank/punctuation-only facts count the slide as one; repeats count once", () => {
    expect(quizSize([])).toBe(1);
    expect(quizSize([{ facts: [] }])).toBe(1);
    expect(quizSize([{ facts: ["", "  ", "—", "..."] }])).toBe(1);
    expect(quizSize([{ facts: ["A b"] }, { facts: ["a  B!"] }, { facts: ["a-b"] }])).toBe(1);
    expect(quizSize([{ facts: ["x"] }, { facts: [] }, { facts: ["y", "x"] }])).toBe(3);
    expect(quizSize([{ facts: ["one"] }])).toBe(1);
  });

  it("never more slots than facts, whatever the explicit size; no padding", () => {
    const slides = [slide(1, ["a", "b"]), slide(2, ["c"])];
    for (const size of [3, 4, 10, 1000]) {
      const slots = planQuizByFacts(slides, size);
      expect(slots, `size ${size}`).toHaveLength(3);
      expect(slots.every((s) => s.fact !== null)).toBe(true);
    }
    expect(planQuizByFacts([slide(1, ["only"])])).toEqual([{ page: 1, fact: "only", angle: "recall" }]);
  });

  it("explicit size 0, negative and NaN: no crash", () => {
    const slides = [slide(1, ["a", "b"])];
    expect(planQuizByFacts(slides, 0)).toEqual([]);
    expect(planQuizByFacts(slides, -3)).toEqual([]);
    expect(planQuizByFacts([], 0)).toEqual([]);
    // NaN is not a size: whatever comes back must be a plain array (not a crash); it must not exceed the facts.
    const nan = planQuizByFacts(slides, NaN);
    expect(Array.isArray(nan)).toBe(true);
    expect(nan.length).toBeLessThanOrEqual(2);
  });

  it("no slides: size general slots (default 1) with page and fact null, angles cycle", () => {
    expect(planQuizByFacts([])).toEqual([{ page: null, fact: null, angle: "recall" }]);
    const four = planQuizByFacts([], 4);
    expect(four.map((s) => s.angle)).toEqual(["recall", "apply", "compare", "recall"]);
    expect(four.every((s) => s.page === null && s.fact === null)).toBe(true);
  });

  it("the same fact on many slides becomes one slot, on the first slide that lists it", () => {
    const slides = Array.from({ length: 9 }, (_, i) => slide(i + 1, ["Shared fact.", `own ${i}`]));
    const slots = planQuizByFacts(slides);
    expect(slots).toHaveLength(10);
    expect(slots.filter((s) => s.fact === "Shared fact.")).toEqual([expect.objectContaining({ page: 1 })]);
  });

  it("smaller explicit size: stressed slides' facts first, then case slides, then slide order, kept in slide order", () => {
    const slides = [slide(1, ["a1", "a2"]), slide(2, ["b1"], { hasCase: true }), slide(3, ["c1", "c2"], { emphasized: true }), slide(4, ["d1"])];
    expect(planQuizByFacts(slides, 3).map((s) => s.fact)).toEqual(["b1", "c1", "c2"]);
    expect(planQuizByFacts(slides, 1).map((s) => s.fact)).toEqual(["c1"]);
    expect(planQuizByFacts(slides, 5).map((s) => s.fact)).toEqual(["a1", "a2", "b1", "c1", "c2"]);
    expect(planQuizByFacts(slides, 6).map((s) => s.fact)).toEqual(["a1", "a2", "b1", "c1", "c2", "d1"]);
  });

  it("angle variety: a 9-fact section uses recall, apply and compare; 'not' appears only on list slides (4+ facts)", () => {
    const slots = planQuizByFacts([slide(1, ["a", "b", "c"]), slide(2, ["d", "e", "f"]), slide(3, ["g", "h", "i"])]);
    expect(new Set(slots.map((s) => s.angle))).toEqual(new Set(["recall", "apply", "compare"]));
    const mixed = planQuizByFacts(Array.from({ length: 12 }, (_, i) => slide(i + 1, i === 5 ? ["l1", "l2", "l3", "l4"] : [`f${i}`])));
    expect(mixed.every((s) => s.angle !== ("not" as string))).toBe(true);
  });

  it("BUG: a slide whose every fact repeats an earlier slide adds a phantom general slot, so the default plan cuts a real fact", () => {
    // quizSize counts 2 (a, b); planQuizByFacts lists a, b plus a fact-less slot for slide 2 = 3 > size, then cuts one.
    const slides = [slide(1, ["a"]), slide(2, ["a"]), slide(3, ["b"])];
    expect(quizSize(slides)).toBe(2);
    const slots = planQuizByFacts(slides);
    expect(slots.map((s) => s.fact).sort()).toEqual(["a", "b"]);
  });

  it("quizSize equals the default plan length over assorted fact shapes", () => {
    const shapes: string[][][] = [
      [["a"], ["a"], ["b"]],
      [["a", "A"], []],
      [["--"], ["a"], ["!!"]],
      [["a"], ["b", "a"], ["b"]],
      [[], [], []],
    ];
    for (const shape of shapes) {
      const slides = shape.map((f, i) => slide(i + 1, f));
      expect(planQuizByFacts(slides), JSON.stringify(shape)).toHaveLength(quizSize(slides));
    }
  });
});

describe("80-fact section", () => {
  it("all 80 facts planned: two writer calls of 40, every fact exactly once in the prompts, 80 questions", async () => {
    const w = world(distinct(20, 4));
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(80);
    expect(writes().map((c) => slotsOf(c.content))).toEqual([40, 40]);
    const facts = writes().flatMap((c) => factsIn(c.content));
    expect(facts.sort()).toEqual(distinct(20, 4).flat().sort());
    expect(w.topic().checks_version).toBe(4);
  });

  it("1-fact section: one slot, one question", async () => {
    const w = world([["the only fact"]]);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(1);
    expect(writes().map((c) => slotsOf(c.content))).toEqual([1]);
  });

  it("page with no notes at all counts as one question", async () => {
    const w = world([null, ["x"]]);
    expect(await getSectionQuiz(w.topic())).toHaveLength(2);
  });
});

describe("quizIsCurrent boundaries", () => {
  it("v3 quiz: 4 facts rewritten, 5 and 25 kept, 26 rewritten", () => {
    for (const [facts, kept] of [[4, false], [5, true], [25, true], [26, false]] as const) {
      const w = world(distinct(facts));
      storeQuiz(w.topicId, 3);
      expect(quizIsCurrent(w.topic()), `${facts} facts`).toBe(kept);
    }
  });

  it("duplicated facts across slides count once; a slide without notes counts as one", () => {
    // 6 slides x same 4 facts = 4 distinct => rewrite; adding a notes-less slide makes 5 => keep
    const dup = Array.from({ length: 6 }, () => ["a", "b", "c", "d"]);
    const w = world(dup);
    storeQuiz(w.topicId, 3);
    expect(quizIsCurrent(w.topic())).toBe(false);
    const w2 = world([...dup, null]);
    storeQuiz(w2.topicId, 3);
    expect(quizIsCurrent(w2.topic())).toBe(true);
    // 25 distinct + a repeated fact stays 25 (kept); + one notes-less slide is 26 (rewritten)
    const w3 = world([...distinct(25), ["fact 0 0"]]);
    storeQuiz(w3.topicId, 3);
    expect(quizIsCurrent(w3.topic())).toBe(true);
    const w4 = world([...distinct(25), null]);
    storeQuiz(w4.topicId, 3);
    expect(quizIsCurrent(w4.topic())).toBe(false);
  });

  it("v3 with checks_json null is never current; v2/null never; v4 and v5 always, whatever the facts", () => {
    const w = world(distinct(7));
    db.prepare("UPDATE topics SET checks_json = NULL, checks_version = 3 WHERE id = ?").run(w.topicId);
    expect(quizIsCurrent(w.topic())).toBe(false);
    for (const [v, expected] of [[2, false], [null, false], [4, true], [5, true], [99, true]] as const) {
      const x = world(distinct(2));
      storeQuiz(x.topicId, v);
      expect(quizIsCurrent(x.topic()), `v${v}`).toBe(expected);
    }
    const big = world(distinct(40));
    storeQuiz(big.topicId, 4);
    expect(quizIsCurrent(big.topic())).toBe(true);
  });

  it("a topic whose page_ids point at missing pages: v3 counts it as 1 fact (rewrite), v4 stays current, no crash", () => {
    const w = world(distinct(8));
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([987001, 987002, 987003]), w.topicId);
    storeQuiz(w.topicId, 3);
    expect(() => quizIsCurrent(w.topic())).not.toThrow();
    expect(quizIsCurrent(w.topic())).toBe(false);
    storeQuiz(w.topicId, 4);
    expect(quizIsCurrent(w.topic())).toBe(true);
    db.prepare("UPDATE topics SET page_ids = '[]' WHERE id = ?").run(w.topicId);
    storeQuiz(w.topicId, 3);
    expect(quizIsCurrent(w.topic())).toBe(false);
  });

  it("class-copied v3 quiz: the classmate's copy follows the same rule on its own pages", () => {
    for (const [facts, kept] of [[3, false], [10, true]] as const) {
      const a = world(distinct(facts));
      storeQuiz(a.topicId, 3);
      const b = makeUser();
      const classId = createClass(a.userId, "C");
      const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
      joinClass(b, code);
      db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(a.examId);
      expect(shareExam(a.userId, classId, a.examId)).toBeNull();
      const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(a.examId) as { id: number }).id;
      const res = addSharedExam(b, sharedId);
      const copyId = (res as { examId: number }).examId;
      const copy = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(copyId) as Topic;
      expect(copy.checks_version).toBe(3);
      expect(copy.page_ids).not.toBe(a.topic().page_ids);
      expect(quizIsCurrent(copy), `${facts} facts`).toBe(kept);
    }
  });
});

describe("lesson route starts the quiz only when quizIsCurrent is false", () => {
  const lesson = (sessionId: number) => lessonGET(new Request("http://x/l?position=0"), ctx(sessionId));

  it("kept v3 quiz (6 facts): no writer call; padded v3 quiz (3 facts): the writer starts and stamps v4; no quiz at all: starts", async () => {
    const kept = world(distinct(6));
    storeQuiz(kept.topicId, 3);
    expect((await lesson(kept.sessionId)).status).toBe(200);
    await settle();
    expect(writes()).toHaveLength(0);
    expect(kept.topic().checks_version).toBe(3);

    calls.length = 0;
    const padded = world(distinct(3));
    storeQuiz(padded.topicId, 3);
    expect((await lesson(padded.sessionId)).status).toBe(200);
    await settle();
    expect(writes().length).toBeGreaterThan(0);
    expect(padded.topic().checks_version).toBe(QUIZ_VERSION);
    expect(JSON.parse(padded.topic().checks_json!)).toHaveLength(3);

    calls.length = 0;
    const none = world(distinct(2));
    await lesson(none.sessionId);
    await settle();
    expect(writes().length).toBeGreaterThan(0);
  });

  it("prefetch never starts the quiz", async () => {
    const w = world(distinct(3));
    storeQuiz(w.topicId, 3);
    await lessonGET(new Request("http://x/l?position=0&prefetch=1"), ctx(w.sessionId));
    await settle();
    expect(writes()).toHaveLength(0);
  });
});

describe("quiz route with tiny quizzes", () => {
  it("1-fact section: GET returns 1 question and slides count; check index bounds", async () => {
    const w = world([["lonely fact"]]);
    const res = await quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId));
    const body = await res.json();
    expect(body.questions).toHaveLength(1);
    expect(body.slides).toBe(1);
    expect((await post(checkPOST, w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 })).status).toBe(200);
    const bad = await post(checkPOST, w.sessionId, { topicId: w.topicId, index: 1, chosen: 0 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await post(checkPOST, w.sessionId, { topicId: w.topicId, index: -1, chosen: 0 })).status).toBeGreaterThanOrEqual(400);
    expect((await post(checkPOST, w.sessionId, { topicId: w.topicId, index: 0.5, chosen: 0 })).status).toBeGreaterThanOrEqual(400);
    expect(db.prepare("SELECT COUNT(*) n FROM session_checks WHERE session_id = ?").get(w.sessionId)).toEqual({ n: 1 });
  });

  it("zero-slide topic still gets a 1-question quiz without crashing", async () => {
    const w = world([]);
    const res = await quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId));
    expect(res.status).toBe(200);
    expect((await res.json()).questions).toHaveLength(1);
  });
});

describe("Write new questions on a kept v3 quiz", () => {
  it("rewrites at the new size (one per distinct fact) and stamps version 4", async () => {
    const w = world(distinct(7)); // 7 facts: v3 kept
    storeQuiz(w.topicId, 3);
    expect(quizIsCurrent(w.topic())).toBe(true);
    const res = await post(regenPOST, w.sessionId, { topicId: w.topicId });
    expect(await res.json()).toEqual({ ok: true, count: 7 });
    expect(w.topic().checks_version).toBe(4);
    expect(JSON.parse(w.topic().checks_json!)).toHaveLength(7);
    expect(writes().map((c) => slotsOf(c.content)).reduce((a, b) => a + b, 0)).toBe(7);
  });

  it("on a padded 2-fact v3 quiz: 2 questions, no padding", async () => {
    const w = world(distinct(2));
    storeQuiz(w.topicId, 3, 5);
    const res = await post(regenPOST, w.sessionId, { topicId: w.topicId });
    expect((await res.json()).count).toBe(2);
    expect(writes().map((c) => slotsOf(c.content)).reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("tutor chat removal", () => {
  it("the chat route file is gone and cannot be imported", async () => {
    expect(fs.existsSync(path.join(process.cwd(), "src/app/api/sessions/[id]/chat/route.ts"))).toBe(false);
    const p = "@/app/api/sessions/[id]/chat/route";
    await expect(import(/* @vite-ignore */ p)).rejects.toThrow();
  });

  it("no tutorStream / tutorSystem export, and no source references them", () => {
    expect(Object.keys(study).filter((k) => /tutor/i.test(k))).toEqual([]);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const hits = walk(path.join(process.cwd(), "src")).filter((f) => /\.(ts|tsx)$/.test(f) && /tutorStream|tutorSystem|TutorChat|api\/sessions\/\$\{[^}]*\}\/chat/.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("session end with zero chat rows and no activity: plain summary, no AI call", async () => {
    const w = world(distinct(2));
    const res = await endPOST(new Request("http://x/e", { method: "POST" }), ctx(w.sessionId));
    expect(res.status).toBe(200);
    expect((await res.json()).summary).toBe("Session ended with no activity.");
    expect(calls.filter((c) => c.purpose === "session summary")).toHaveLength(0);
  });

  it("session end with leftover chat rows and with quiz answers still summarises", async () => {
    const w = world(distinct(2));
    db.prepare("INSERT INTO chat_messages (session_id, role, content, topic_position) VALUES (?, 'user', 'old question?', 0)").run(w.sessionId);
    db.prepare("INSERT INTO chat_messages (session_id, role, content, topic_position) VALUES (?, 'assistant', 'old answer', 0)").run(w.sessionId);
    const res = await endPOST(new Request("http://x/e", { method: "POST" }), ctx(w.sessionId));
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).summary).toBe("string");

    const v = world(distinct(2));
    await quizGET(new Request("http://x/q?position=0"), ctx(v.sessionId));
    await post(checkPOST, v.sessionId, { topicId: v.topicId, index: 0, chosen: 0 });
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', 'leftover')").run(v.sessionId);
    const res2 = await endPOST(new Request("http://x/e", { method: "POST" }), ctx(v.sessionId));
    expect((await res2.json()).summary).toBe("Summed up");
  });

  it("deleting a session still cascades its leftover chat rows", () => {
    const w = world(distinct(1));
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', 'x')").run(w.sessionId);
    db.prepare("DELETE FROM study_sessions WHERE id = ?").run(w.sessionId);
    expect(db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE session_id = ?").get(w.sessionId)).toEqual({ n: 0 });
  });
});
