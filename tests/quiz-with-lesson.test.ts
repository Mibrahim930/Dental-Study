// Perf fix #2: opening a topic starts its section quiz alongside the lesson (not after), once, and never for a prefetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { purpose: string }[] = [];
let lessonGate: Promise<void> = Promise.resolve();
let failQuiz = false;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; system: string; content: string }) => {
    calls.push({ purpose: opts.purpose });
    if (opts.purpose === "lesson") {
      await lessonGate;
      return { explanation: "Lesson text", key_points: ["a", "b", "c", "d"], slides: [], connections: null };
    }
    if (opts.purpose === "section quiz") {
      if (failQuiz) throw new Error("529 overloaded");
      const slots = [...opts.content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          question: `Q${s.n} on P${s.page}`,
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
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { makeUser } from "./helpers";

const notes = (i: number) =>
  JSON.stringify({ title: `slide ${i}`, summary: "s", image_description: null, key_facts: ["a", "b"], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

function world(topics = 2) {
  const userId = makeUser();
  currentUserId = userId;
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const topicIds: number[] = [];
  for (let t = 0; t < topics; t++) {
    const pages = Array.from({ length: 4 }, (_, i) =>
      Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(docId, t * 4 + i + 1, notes(i)).lastInsertRowid),
    );
    topicIds.push(Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)").run(examId, t, `T${t}`, JSON.stringify(pages)).lastInsertRowid));
  }
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = (id: number) => db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
  return { userId, examId, sessionId, topicIds, topic };
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const lesson = (sessionId: number, position: number, prefetch = false) =>
  lessonGET(new Request(`http://x/l?position=${position}${prefetch ? "&prefetch=1" : ""}`), ctx(sessionId));
const quiz = (sessionId: number, position: number) => quizGET(new Request(`http://x/q?position=${position}`), ctx(sessionId));
const quizWrites = () => calls.filter((c) => c.purpose === "section quiz").length;
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, tries = 200) {
  for (let i = 0; i < tries && !cond(); i++) await tick();
}

beforeEach(() => {
  calls.length = 0;
  lessonGate = Promise.resolve();
  failQuiz = false;
});
afterEach(() => vi.restoreAllMocks());

describe("section quiz starts with the lesson", () => {
  it("one lesson GET starts the quiz while the lesson is still being written, and the quiz GET joins that run", async () => {
    const w = world();
    let release!: () => void;
    lessonGate = new Promise((r) => (release = r));
    const lessonRes = lesson(w.sessionId, 0);
    // The lesson is held back; the quiz writers must already be running.
    await until(() => quizWrites() >= 2);
    expect(calls.some((c) => c.purpose === "lesson")).toBe(true);
    expect(quizWrites()).toBe(2); // one generation = two parallel writes of half the plan
    // The page asks for the quiz while it's still being written: no second generation.
    const quizRes = quiz(w.sessionId, 0);
    release();
    expect((await lessonRes).status).toBe(200);
    const body = await (await quizRes).json();
    expect(body.questions.length).toBeGreaterThan(0);
    expect(quizWrites()).toBe(2);
    // Later opens are served from the cache with no AI call at all.
    const before = calls.length;
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    expect((await quiz(w.sessionId, 0)).status).toBe(200);
    expect(calls.length).toBe(before);
  });

  it("a prefetch of the next topic writes its lesson but never its quiz", async () => {
    const w = world();
    expect((await lesson(w.sessionId, 1, true)).status).toBe(200);
    await tick();
    expect(calls.filter((c) => c.purpose === "lesson").length).toBe(1);
    expect(quizWrites()).toBe(0);
    expect(w.topic(w.topicIds[1]).checks_json).toBeNull();
  });

  it("a topic whose quiz is already written makes no quiz call when its lesson opens", async () => {
    const w = world();
    await lesson(w.sessionId, 0);
    await quiz(w.sessionId, 0);
    const quizJson = w.topic(w.topicIds[0]).checks_json;
    expect(quizJson).not.toBeNull();
    // Lesson cache cleared (e.g. a new lesson needed) but the quiz is current: still no quiz writes.
    db.prepare("UPDATE topics SET lesson_json = NULL WHERE id = ?").run(w.topicIds[0]);
    calls.length = 0;
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    await tick();
    expect(quizWrites()).toBe(0);
    expect(w.topic(w.topicIds[0]).checks_json).toBe(quizJson);
  });

  it("a quiz that fails in the background is logged, not thrown, and the page's own quiz request tries again", async () => {
    const w = world();
    failQuiz = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    await until(() => logged.mock.calls.some((c) => String(c[0]).includes("started with the lesson")));
    expect(logged.mock.calls.some((c) => String(c[0]).includes("started with the lesson"))).toBe(true);
    failQuiz = false;
    const res = await quiz(w.sessionId, 0);
    expect(res.status).toBe(200);
    expect((await res.json()).questions.length).toBeGreaterThan(0);
  });
});
