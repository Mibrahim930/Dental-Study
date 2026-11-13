// Wave 1, study-session server side (audit M2, M4, M5, M10, S7, S10, R8, R9, R11).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { purpose: string }[] = [];
let aiDown = false; // every AI call throws (M10: ending a session must make none)
let failLesson = false;
let failQuiz = false;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose });
    if (aiDown) throw new Error(`no AI call expected (${opts.purpose})`);
    if (opts.purpose === "lesson" || opts.purpose === "lesson repair") {
      if (failLesson) throw new Error("max_tokens: the lesson was cut off");
      // One entry per slide, explaining the facts listed under it.
      const slides = opts.content
        .split(/\n(?=\[P\d+\])/)
        .map((block) => ({ id: Number(block.match(/^\[P(\d+)\]/)?.[1]), facts: [...block.matchAll(/^- (.+)$/gm)].map((m) => m[1]) }))
        .filter((b) => b.id)
        .map((b) => ({ page_id: b.id, explanation: `In other words: ${b.facts.join("; ")}.` }));
      return claimAll(opts.content, { intro: "What this section is about.", slides, key_points: ["a"], connections: null });
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
          image_page_id: null,
          concept: "C",
        })),
      };
    }
    if (opts.purpose === "section quiz check") {
      const n = (opts.content.match(/^\d+\. /gm) ?? []).length;
      return { verdicts: Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: true, picture: false, reason: "" })) };
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

import { db, getMeta, setMeta, type Topic } from "@/lib/db";
import { FAILURE_COOLDOWN_MS, getLesson, getSectionQuiz, LESSON_VERSION, QUIZ_VERSION, scanLessonsForFiller, scanLessonsForFillerOnce, type QuizQuestion } from "@/lib/study";
import { FILLER_SCAN_VERSION } from "@/lib/lessonCoverage";
import { claimAll } from "./lessonClaims";
import { recordQuizAnswer } from "@/lib/quizProgress";
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { POST as shownPOST } from "@/app/api/sessions/[id]/shown/route";
import { POST as endPOST } from "@/app/api/sessions/[id]/end/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { makeUser } from "./helpers";

const notes = (t: number, i: number, facts?: unknown) =>
  JSON.stringify({
    title: `slide ${i}`,
    summary: "s",
    image_description: null,
    key_facts: facts ?? [`the enamel fact number ${t}${i} is here`, `the dentin fact number ${t}${i} is there`],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
  });

function world(topics = 2, pageNotes: (t: number, i: number) => string | null = notes) {
  const userId = makeUser();
  currentUserId = userId;
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const topicIds: number[] = [];
  for (let t = 0; t < topics; t++) {
    const pages = Array.from({ length: 3 }, (_, i) =>
      Number(
        db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(docId, t * 3 + i + 1, pageNotes(t, i)).lastInsertRowid,
      ),
    );
    topicIds.push(
      Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)").run(examId, t, `Section ${t}`, JSON.stringify(pages)).lastInsertRowid),
    );
  }
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, 7)").run(examId).lastInsertRowid);
  const topic = (id: number) => db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
  return { userId, examId, sessionId, topicIds, topic };
}
type World = ReturnType<typeof world>;

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const lesson = (sessionId: number, position: number, prefetch = false, headers?: Record<string, string>) =>
  lessonGET(new Request(`http://x/l?position=${position}${prefetch ? "&prefetch=1" : ""}`, { headers }), ctx(sessionId));
const quiz = (sessionId: number, position: number, headers?: Record<string, string>) => quizGET(new Request(`http://x/q?position=${position}`, { headers }), ctx(sessionId));
const post = (route: (r: Request, c: never) => Promise<Response>, sessionId: number, body: unknown) =>
  route(new Request("http://x/p", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(sessionId));
const shown = (sessionId: number, position: number) => post(shownPOST, sessionId, { position });
const end = (sessionId: number) => endPOST(new Request("http://x/e", { method: "POST" }), ctx(sessionId));
const count = (p: string) => calls.filter((c) => c.purpose === p).length;
const lessonCalls = () => calls.filter((c) => c.purpose.startsWith("lesson")).length;
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, tries = 300) {
  for (let i = 0; i < tries && !cond(); i++) await tick();
}
const position = (w: World) => (db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(w.sessionId) as { p: number }).p;
const studied = (w: World, topicId: number) => !!db.prepare("SELECT 1 FROM topic_study WHERE user_id = ? AND topic_id = ?").get(w.userId, topicId);
const quizOf = (n: number, concept = (i: number) => `Concept ${i}`): QuizQuestion[] =>
  Array.from({ length: n }, (_, i) => ({ id: `q${i}`, question: `Question ${i}?`, options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: concept(i) }));
const storeQuiz = (topicId: number, qs: QuizQuestion[], version: number | null = QUIZ_VERSION) =>
  db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(JSON.stringify(qs), version, topicId);
const storeLesson = (topicId: number, lesson: object) => db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), topicId);

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls.length = 0;
  aiDown = false;
  failLesson = false;
  failQuiz = false;
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 10));
  vi.restoreAllMocks();
});

describe("M4: the lesson GET has no side effects", () => {
  it("a direct GET writes the lesson but moves nothing, marks nothing and starts no quiz", async () => {
    const w = world();
    const res = await lesson(w.sessionId, 0);
    expect(res.status).toBe(200);
    expect((await res.json()).lesson.slides.length).toBeGreaterThan(0);
    await tick();
    expect(position(w)).toBe(7);
    expect(studied(w, w.topicIds[0])).toBe(false);
    expect(count("section quiz")).toBe(0);
    expect(w.topic(w.topicIds[0]).checks_json).toBeNull();
    expect(w.topic(w.topicIds[0]).lesson_json).not.toBeNull();
  });

  it("a prefetch serves a stored lesson with no AI call", async () => {
    const w = world();
    expect((await lesson(w.sessionId, 1)).status).toBe(200);
    calls.length = 0;
    const res = await lesson(w.sessionId, 1, true);
    expect(res.status).toBe(200);
    expect((await res.json()).lesson.intro).toBe("What this section is about.");
    expect(calls).toHaveLength(0);
  });

  it("a prefetch writes a missing lesson (and still has no side effects)", async () => {
    const w = world();
    const res = await lesson(w.sessionId, 1, true);
    expect(res.status).toBe(200);
    expect(lessonCalls()).toBeGreaterThan(0);
    expect(w.topic(w.topicIds[1]).lesson_json).not.toBeNull();
    expect(position(w)).toBe(7);
    expect(studied(w, w.topicIds[1])).toBe(false);
    expect(count("section quiz")).toBe(0);
  });
});

describe("M4: POST …/shown", () => {
  it("sets the position, marks the section studied, answers { ok: true } and starts the quiz once", async () => {
    const w = world();
    const res = await shown(w.sessionId, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(position(w)).toBe(1);
    expect(studied(w, w.topicIds[1])).toBe(true);
    expect(studied(w, w.topicIds[0])).toBe(false);
    // A second report while the first quiz is still being written joins it.
    await shown(w.sessionId, 1);
    await until(() => !!w.topic(w.topicIds[1]).checks_json);
    expect(w.topic(w.topicIds[1]).checks_version).toBe(QUIZ_VERSION);
    expect(count("section quiz")).toBe(2); // one generation = two writers of half the plan each
    // Once written, showing the lesson again starts nothing.
    calls.length = 0;
    await shown(w.sessionId, 1);
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("answers at once, before the quiz is written", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { generate } = await import("@/lib/ai");
    const real = vi.mocked(generate).getMockImplementation()!;
    vi.mocked(generate).mockImplementation((async (opts: Parameters<typeof real>[0]) => {
      await gate;
      return real(opts);
    }) as typeof real);
    expect((await shown(w.sessionId, 0)).status).toBe(200);
    expect(w.topic(w.topicIds[0]).checks_json).toBeNull();
    release();
    await until(() => !!w.topic(w.topicIds[0]).checks_json);
    vi.mocked(generate).mockImplementation(real);
    expect(w.topic(w.topicIds[0]).checks_json).not.toBeNull();
  });

  it("does not start the quiz while a recent quiz failure is marked", async () => {
    const w = world();
    setMeta(`quiz_fail:${w.topicIds[0]}`, `${new Date().toISOString()} 529 overloaded`);
    await shown(w.sessionId, 0);
    await tick();
    expect(count("section quiz")).toBe(0);
    expect(studied(w, w.topicIds[0])).toBe(true);
    // An old marker (past the cool-down) no longer holds it back.
    setMeta(`quiz_fail:${w.topicIds[0]}`, `${new Date(Date.now() - FAILURE_COOLDOWN_MS - 1000).toISOString()} old`);
    await shown(w.sessionId, 0);
    await until(() => !!w.topic(w.topicIds[0]).checks_json);
    expect(count("section quiz")).toBe(2);
  });

  it("M5: does not rewrite an out-of-date quiz that has answers; does rewrite one nobody answered", async () => {
    const w = world();
    storeQuiz(w.topicIds[0], quizOf(4), 2);
    recordQuizAnswer(w.userId, w.topicIds[0], 1, 2, false);
    await shown(w.sessionId, 0);
    await tick();
    expect(calls).toHaveLength(0);
    expect(w.topic(w.topicIds[0]).checks_version).toBe(2);

    storeQuiz(w.topicIds[1], quizOf(4), 2);
    await shown(w.sessionId, 1);
    await until(() => w.topic(w.topicIds[1]).checks_version === QUIZ_VERSION);
    expect(w.topic(w.topicIds[1]).checks_version).toBe(QUIZ_VERSION);
  });

  it("a stranger gets 404 and changes nothing; no sign-in is 401; a bad body or position is refused", async () => {
    const w = world();
    currentUserId = makeUser();
    expect((await shown(w.sessionId, 0)).status).toBe(404);
    currentUserId = 0;
    expect((await shown(w.sessionId, 0)).status).toBe(401);
    expect(position(w)).toBe(7);
    expect(studied(w, w.topicIds[0])).toBe(false);
    currentUserId = w.userId;
    expect((await post(shownPOST, w.sessionId, "not json")).status).toBe(400);
    expect((await post(shownPOST, w.sessionId, { position: "1" })).status).toBe(400);
    expect((await post(shownPOST, w.sessionId, { position: 1.5 })).status).toBe(400);
    expect((await shown(w.sessionId, 99)).status).toBe(404);
    await tick();
    expect(calls).toHaveLength(0);
  });
});

describe("M2: failure markers", () => {
  it("a failed lesson is marked; a prefetch then answers 204 with no AI call; her own GET still retries and a success clears it", async () => {
    const w = world();
    failLesson = true;
    const res = await lesson(w.sessionId, 0);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/try again/i);
    expect(getMeta(`lesson_fail:${w.topicIds[0]}`)).toMatch(/^\d{4}-\d\d-\d\dT.* max_tokens/);
    calls.length = 0;
    const pre = await lesson(w.sessionId, 0, true);
    expect(pre.status).toBe(204);
    expect(await pre.text()).toBe("");
    expect(calls).toHaveLength(0);
    // "Try again": the direct GET still calls the writer, even under the marker.
    failLesson = false;
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    expect(lessonCalls()).toBeGreaterThan(0);
    expect(getMeta(`lesson_fail:${w.topicIds[0]}`)).toBeNull();
  });

  it("a prefetch under an expired marker writes the lesson", async () => {
    const w = world();
    setMeta(`lesson_fail:${w.topicIds[1]}`, `${new Date(Date.now() - FAILURE_COOLDOWN_MS - 1000).toISOString()} old`);
    expect((await lesson(w.sessionId, 1, true)).status).toBe(200);
    expect(getMeta(`lesson_fail:${w.topicIds[1]}`)).toBeNull();
  });

  it("a failed background quiz is marked; the quiz GET still tries and its success clears the marker", async () => {
    const w = world();
    failQuiz = true;
    await shown(w.sessionId, 0);
    await until(() => !!getMeta(`quiz_fail:${w.topicIds[0]}`));
    expect(getMeta(`quiz_fail:${w.topicIds[0]}`)).toMatch(/529 overloaded/);
    failQuiz = false;
    const res = await quiz(w.sessionId, 0);
    expect(res.status).toBe(200);
    expect((await res.json()).questions.length).toBeGreaterThan(0);
    expect(getMeta(`quiz_fail:${w.topicIds[0]}`)).toBeNull();
  });

  it("S7: a failing quiz GET answers 502 with a plain message", async () => {
    const w = world();
    failQuiz = true;
    const res = await quiz(w.sessionId, 0);
    expect(res.status).toBe(502);
    expect((await res.json()).error).not.toMatch(/529/);
  });
});

describe("M5: an answered out-of-date quiz is served as it is", () => {
  it("the quiz GET serves it with the answers and no AI call", async () => {
    const w = world();
    const old = quizOf(3);
    storeQuiz(w.topicIds[0], old, 3);
    recordQuizAnswer(makeUser(), w.topicIds[0], 0, 1, false); // anyone's answer keeps it
    const body = await (await quiz(w.sessionId, 0)).json();
    expect(body.questions.map((q: QuizQuestion) => q.id)).toEqual(old.map((q) => q.id));
    expect(calls).toHaveLength(0);
    expect(await getSectionQuiz(w.topic(w.topicIds[0]))).toEqual(old);
    expect(w.topic(w.topicIds[0]).checks_version).toBe(3);
  });
});

describe("M10: ending a session", () => {
  it("builds the note with no AI call, from what was shown and answered, and gives the same note on a second press", async () => {
    const w = world(3);
    aiDown = true;
    storeQuiz(w.topicIds[0], quizOf(3, (i) => (i === 2 ? "Occlusion" : "Enamel")));
    storeQuiz(w.topicIds[1], quizOf(2, () => "Occlusion"));
    await shown(w.sessionId, 0);
    await shown(w.sessionId, 1);
    for (const [topicId, index, chosen] of [
      [w.topicIds[0], 0, 0],
      [w.topicIds[0], 1, 0],
      [w.topicIds[0], 2, 1],
      [w.topicIds[1], 0, 3],
      [w.topicIds[1], 1, 0],
    ])
      expect((await post(checkPOST, w.sessionId, { topicId, index, chosen })).status).toBe(200);
    const res = await end(w.sessionId);
    expect(res.status).toBe(200);
    const { summary } = await res.json();
    expect(summary).toBe("You covered 2 sections: Section 0 and Section 1. You got 3 of 5 section-quiz questions right. Worth another look: Occlusion.");
    expect(calls).toHaveLength(0);
    const row = db.prepare("SELECT summary, ended_at FROM study_sessions WHERE id = ?").get(w.sessionId) as { summary: string; ended_at: string | null };
    expect(row.summary).toBe(summary);
    expect(row.ended_at).not.toBeNull();
    expect(getMeta(`session_shown:${w.sessionId}`)).toBeNull();
    expect((await (await end(w.sessionId)).json()).summary).toBe(summary);
    expect(calls).toHaveLength(0);
  });

  it("a session with nothing done says so; a stranger gets 404", async () => {
    const w = world();
    aiDown = true;
    currentUserId = makeUser();
    expect((await end(w.sessionId)).status).toBe(404);
    currentUserId = w.userId;
    expect((await (await end(w.sessionId)).json()).summary).toBe("You didn't open any section in this session.");
    expect(calls).toHaveLength(0);
  });

  it("nothing in src reads chat_messages any more", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const hits = walk(path.join(process.cwd(), "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("db.ts") && /chat_messages/.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("S10: cross-site requests", () => {
  it("the lesson and quiz GETs refuse cross-site and same-site requests and allow same-origin, typed-in and header-less ones", async () => {
    const w = world();
    storeQuiz(w.topicIds[0], quizOf(2));
    for (const site of ["cross-site", "same-site"]) {
      const l = await lesson(w.sessionId, 0, false, { "Sec-Fetch-Site": site });
      expect(l.status).toBe(403);
      expect((await l.json()).error).toBeTruthy();
      expect((await quiz(w.sessionId, 0, { "Sec-Fetch-Site": site })).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
    expect(w.topic(w.topicIds[0]).lesson_json).toBeNull();
    expect((await lesson(w.sessionId, 0, false, { "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await lesson(w.sessionId, 0, false, { "Sec-Fetch-Site": "none" })).status).toBe(200);
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    expect((await quiz(w.sessionId, 0, { "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  });
});

describe("R8: no lost update when a stored lesson is cleaned", () => {
  const RAMBLE = "Done.\nOk.\nStop.\nBye.";
  const lessonFor = (w: World, topicId: number, text: string, intro = "What this section is about.") => ({
    intro,
    slides: (JSON.parse(w.topic(topicId).page_ids) as number[]).map((page_id) => ({ page_id, explanation: text })),
    key_points: [],
    connections: null,
    version: LESSON_VERSION,
  });

  it("a stale snapshot does not overwrite a lesson saved since; the newer one is served", async () => {
    const w = world(1);
    const t = w.topicIds[0];
    storeLesson(t, lessonFor(w, t, `The pulp is the soft tissue inside the tooth.\n\n${RAMBLE}`));
    const stale = w.topic(t);
    const newer = lessonFor(w, t, "A newer explanation of the pulp and dentin.", "Newer");
    storeLesson(t, newer);
    const served = await getLesson(stale);
    expect(served.intro).toBe("Newer");
    expect(JSON.parse(w.topic(t).lesson_json!)).toEqual(newer);
    expect(calls).toHaveLength(0);
  });

  it("the filler scan cleans a lesson; the start-up variant runs once per trimmer version", () => {
    const w = world(1);
    const t = w.topicIds[0];
    db.prepare("DELETE FROM meta WHERE key = 'lesson_filler_scan_done'").run();
    storeLesson(t, lessonFor(w, t, `The pulp is the soft tissue inside the tooth.\n\n${RAMBLE}`));
    const first = scanLessonsForFillerOnce();
    expect(first?.found.some((f) => f.topicId === t)).toBe(true);
    expect(JSON.parse(w.topic(t).lesson_json!).slides[0].explanation).toBe("The pulp is the soft tissue inside the tooth.");
    expect(getMeta("lesson_filler_scan_done")).toBe(String(FILLER_SCAN_VERSION));
    storeLesson(t, lessonFor(w, t, `Again.\n\nThe pulp.\n\n${RAMBLE}`));
    expect(scanLessonsForFillerOnce()).toBeNull();
    expect(JSON.parse(w.topic(t).lesson_json!).slides[0].explanation).toContain("Bye.");
    // The Admin button always scans.
    expect(scanLessonsForFiller().found.some((f) => f.topicId === t)).toBe(true);
    // A new trimmer version scans again at the next start.
    setMeta("lesson_filler_scan_done", String(FILLER_SCAN_VERSION - 1));
    expect(scanLessonsForFillerOnce()).not.toBeNull();
  });
});

describe("R9: damaged slide notes", () => {
  it("unreadable notes and non-text facts are skipped: the lesson, the quiz and the lesson route still work", async () => {
    const w = world(1, (t, i) => (i === 0 ? "{not json" : i === 1 ? notes(t, i, [1, null, { a: 1 }, "the periodontal ligament anchors the tooth"]) : notes(t, i, "not a list")));
    const res = await lesson(w.sessionId, 0);
    expect(res.status).toBe(200);
    expect(lessonCalls()).toBeGreaterThan(0);
    const qs = await getSectionQuiz(w.topic(w.topicIds[0]));
    expect(qs.length).toBeGreaterThan(0);
    expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining("Lesson for topic"), expect.anything());
  });
});
