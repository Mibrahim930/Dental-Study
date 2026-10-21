// QA of the five performance commits (loading skeletons are checked in the browser): quiz started with the lesson under
// concurrency, practice concurrency 8/6 with failures, and the batched exam-page lookups on adversarial data.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- one AI mock for lessons, section quizzes and practice questions ----
const calls: { purpose: string; content: string }[] = [];
let lessonGate: Promise<void> = Promise.resolve();
let quizGate: Promise<void> = Promise.resolve();
let failQuiz = false;
let quizSerial = 0;
let counter = 0;
let inFlight = 0;
let maxInFlight = 0;
const failTopics = new Set<string>();
const shortTopics = new Map<string, number>();
let failRatio = 0;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; system: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    if (opts.purpose === "lesson") {
      await lessonGate;
      return { explanation: "Lesson text", key_points: ["a", "b", "c", "d"], slides: [], connections: null };
    }
    if (opts.purpose === "section quiz") {
      await quizGate;
      if (failQuiz) throw new Error("529 overloaded");
      const serial = ++quizSerial;
      const slots = [...opts.content.matchAll(/^Q(\d+): (?:slide P(\d+)|the topic)/gm)].map((m) => ({ n: Number(m[1]), page: m[2] ? Number(m[2]) : 0 }));
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          question: `Q${s.n} v${serial} on P${s.page}`,
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
    // practice questions / case sets
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 10));
      const title = /Topic: (Topic \d+)/.exec(opts.content)?.[1] ?? "";
      if (failTopics.has(title) || (failRatio > 0 && Math.random() < failRatio)) {
        throw Object.assign(new Error("429 rate_limit_error"), { status: 429 });
      }
      const asked = Number(/Write (\d+) /.exec(opts.content)?.[1] ?? 1);
      const count = Math.min(asked, shortTopics.get(title) ?? asked);
      const page = Number(/\[P(\d+)\]/.exec(opts.content)?.[1] ?? 0);
      if (opts.purpose === "case sets") {
        return {
          cases: Array.from({ length: count }, () => ({
            scenario: `scenario ${++counter}`,
            patient_box: { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" },
            image_page_id: null,
            questions: Array.from({ length: 3 }, (_, i) => ({ stem: `case-q ${++counter}-${i}`, options: ["A", "B", "C", "D", "E"], correct_index: 0, explanation: "e", source_page_id: page, concept: "Gen concept" })),
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
    } finally {
      inFlight--;
    }
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
import { POST as regenPOST } from "@/app/api/sessions/[id]/quiz/regenerate/route";
import { QUIZ_VERSION } from "@/lib/study";
import { startAttempt } from "@/lib/practice";
import { mastery, topicConcepts, topicConceptsForExam, type ConceptRow } from "@/lib/memory";
import { pendingCounts, pendingCountsByTopic } from "@/lib/practicePlan";
import { examProgress } from "@/lib/readiness";
import { makeUser } from "./helpers";

const notes = (i: number) =>
  JSON.stringify({ title: `slide ${i}`, summary: "s", image_description: null, key_facts: ["a", "b"], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

function quizWorld(topics = 2) {
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
const regen = (sessionId: number, topicId: number) =>
  regenPOST(new Request("http://x/r", { method: "POST", body: JSON.stringify({ topicId }) }), ctx(sessionId));
const quizWrites = () => calls.filter((c) => c.purpose === "section quiz").length;
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, tries = 400) {
  for (let i = 0; i < tries && !cond(); i++) await tick();
}
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  calls.length = 0;
  lessonGate = Promise.resolve();
  quizGate = Promise.resolve();
  failQuiz = false;
  failTopics.clear();
  shortTopics.clear();
  failRatio = 0;
  inFlight = 0;
  maxInFlight = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});

describe("job 2: quiz started with the lesson, under concurrency", () => {
  it("two lesson GETs at once make one quiz generation (not two), and both succeed", async () => {
    const w = quizWorld();
    let release!: () => void;
    quizGate = new Promise((r) => (release = r));
    const [a, b] = [lesson(w.sessionId, 0), lesson(w.sessionId, 0)];
    await until(() => quizWrites() >= 2);
    await tick();
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    await until(() => !!w.topic(w.topicIds[0]).checks_json);
    expect(quizWrites()).toBe(2);
    expect(w.topic(w.topicIds[0]).checks_version).toBe(QUIZ_VERSION);
  });

  it("lesson + quiz GET + a second lesson open overlap: still one generation, and the quiz GET gets the written quiz", async () => {
    const w = quizWorld();
    let release!: () => void;
    quizGate = new Promise((r) => (release = r));
    const l1 = lesson(w.sessionId, 0);
    await until(() => quizWrites() >= 2);
    const q = quiz(w.sessionId, 0);
    const l2 = lesson(w.sessionId, 0);
    release();
    await Promise.all([l1, l2]);
    const body = await (await q).json();
    expect(body.questions.length).toBeGreaterThan(0);
    expect(quizWrites()).toBe(2);
    const stored = JSON.parse(w.topic(w.topicIds[0]).checks_json!);
    expect(body.questions.map((x: { id: string }) => x.id)).toEqual(stored.map((x: { id: string }) => x.id));
  });

  it("'Write new questions' while the lesson-started run is still in flight joins it (no second generation, no lost quiz)", async () => {
    const w = quizWorld();
    let release!: () => void;
    quizGate = new Promise((r) => (release = r));
    const l = lesson(w.sessionId, 0);
    await until(() => quizWrites() >= 2);
    const r = regen(w.sessionId, w.topicIds[0]);
    release();
    await l;
    const res = await r;
    expect(res.status).toBe(200);
    expect(quizWrites()).toBe(2);
    expect(w.topic(w.topicIds[0]).checks_json).not.toBeNull();
  });

  it("a lesson opened during 'Write new questions' of a current quiz starts nothing, and the old quiz is served until the swap", async () => {
    const w = quizWorld();
    await lesson(w.sessionId, 0);
    await until(() => !!w.topic(w.topicIds[0]).checks_json);
    const old = w.topic(w.topicIds[0]).checks_json!;
    calls.length = 0;
    let release!: () => void;
    quizGate = new Promise((r) => (release = r));
    const r = regen(w.sessionId, w.topicIds[0]);
    await until(() => quizWrites() >= 2);
    expect(quizWrites()).toBe(2);
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    const during = await (await quiz(w.sessionId, 0)).json();
    expect(JSON.stringify(during.questions.map((q: { id: string }) => q.id))).toBe(JSON.stringify(JSON.parse(old).map((q: { id: string }) => q.id)));
    expect(quizWrites()).toBe(2); // no extra generation
    release();
    expect((await r).status).toBe(200);
    expect(w.topic(w.topicIds[0]).checks_json).not.toBe(old);
    expect(quizWrites()).toBe(2);
  });

  it("failure then retry: the failed run is forgotten (not stuck in the in-flight map) and the next open writes the quiz", async () => {
    const w = quizWorld();
    failQuiz = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    await until(() => logged.mock.calls.some((c) => String(c[0]).includes("started with the lesson")));
    expect(w.topic(w.topicIds[0]).checks_json).toBeNull();
    failQuiz = false;
    calls.length = 0;
    // Opening the topic again restarts it (the lesson is cached now).
    expect((await lesson(w.sessionId, 0)).status).toBe(200);
    await until(() => !!w.topic(w.topicIds[0]).checks_json);
    expect(w.topic(w.topicIds[0]).checks_json).not.toBeNull();
    expect(unhandled).toEqual([]);
  });

  it("a failing background quiz is never an unhandled rejection, even when the quiz GET also joined and failed", async () => {
    const w = quizWorld();
    failQuiz = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const l = lesson(w.sessionId, 0);
    const q = quiz(w.sessionId, 0);
    expect((await l).status).toBe(200);
    expect((await q).status).toBe(500);
    await new Promise((r) => setTimeout(r, 30));
    expect(unhandled).toEqual([]);
  });

  it("a prefetch of a topic with an out-of-date quiz (older QUIZ_VERSION) does not rewrite it; a real open does, once", async () => {
    const w = quizWorld();
    const old = JSON.stringify([{ id: "old1", question: "q", options: ["a", "b"], correct_index: 0, explanation: "e", concept: "C", source_page_id: null, image_page_id: null, kind: "recall" }]);
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(old, QUIZ_VERSION - 1, w.topicIds[1]);
    expect((await lesson(w.sessionId, 1, true)).status).toBe(200);
    await tick();
    expect(quizWrites()).toBe(0);
    expect(w.topic(w.topicIds[1]).checks_json).toBe(old);
    expect((await lesson(w.sessionId, 1)).status).toBe(200);
    await until(() => w.topic(w.topicIds[1]).checks_version === QUIZ_VERSION);
    expect(w.topic(w.topicIds[1]).checks_version).toBe(QUIZ_VERSION);
    expect(quizWrites()).toBe(2);
  });

  it("someone else's session or a position that doesn't exist starts no quiz", async () => {
    const w = quizWorld();
    const other = quizWorld(); // switches currentUserId to the other student
    expect((await lesson(w.sessionId, 0)).status).toBe(404);
    expect((await lesson(other.sessionId, 99)).status).toBe(404);
    expect((await lessonGET(new Request("http://x/l?position=abc"), ctx(other.sessionId))).status).toBe(404);
    await tick();
    expect(quizWrites()).toBe(0);
  });

  it("a topic whose lectures were removed (slides gone): opening it neither crashes nor leaves an unhandled rejection", async () => {
    const w = quizWorld();
    db.prepare("DELETE FROM pages").run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await lesson(w.sessionId, 0);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
    void logged;
  });

  it("opening a topic whose user has no API key logs the quiz failure and still answers the lesson request normally", async () => {
    const w = quizWorld();
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify({ explanation: "x", key_points: [], slides: [], connections: null }), w.topicIds[0]);
    failQuiz = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await lesson(w.sessionId, 0);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(unhandled).toEqual([]);
  });
});

// ---- job 3: practice concurrency ----
function practiceWorld(topics: number) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'lec.pdf')").run(examId).lastInsertRowid);
  let pn = 0;
  const topicIds: number[] = [];
  for (let t = 0; t < topics; t++) {
    const pages = Array.from({ length: 2 }, () => Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, text) VALUES (?, ?, '', 'slide text')").run(docId, ++pn).lastInsertRowid));
    topicIds.push(Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)").run(examId, t, `Topic ${t + 1}`, JSON.stringify(pages)).lastInsertRowid));
  }
  return { userId, examId, topicIds };
}
async function ready(attemptId: number) {
  for (let i = 0; i < 2000; i++) {
    const a = db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(attemptId) as { status: string; error: string | null };
    if (a.status !== "generating") return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("stuck generating");
}
const members = (attemptId: number) =>
  db.prepare("SELECT q.id, q.topic_id, q.case_id, q.stem FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ?").all(attemptId) as {
    id: number;
    topic_id: number;
    case_id: number | null;
    stem: string;
  }[];

describe("job 3: practice exams with 8 sections at once", () => {
  it("20 sections, 12 rate limited (only 8 work): the exam still reaches its full size, no repeats", async () => {
    const w = practiceWorld(20);
    for (let t = 9; t <= 20; t++) failTopics.add(`Topic ${t}`);
    const id = startAttempt(w.examId, { size: 25, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    const rows = members(id);
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((r) => r.id)).size).toBe(25);
    expect(new Set(rows.map((r) => r.stem)).size).toBe(25);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("random 429s on ~half the calls: the exam is never empty and never over-size, no duplicate questions", async () => {
    for (let run = 0; run < 5; run++) {
      const w = practiceWorld(16);
      failRatio = 0.5;
      const id = startAttempt(w.examId, { size: 20, mode: "tutor", style: "recall", adaptive: false });
      const st = await ready(id);
      failRatio = 0;
      if (st.status === "error") {
        expect(st.error).toMatch(/429|rate/);
        continue;
      }
      const rows = members(id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(20);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    }
  });

  it("sections that write fewer than asked, mixed with failures, still end in a ready exam of the right size from the full ones", async () => {
    const w = practiceWorld(12);
    failTopics.add("Topic 1").add("Topic 2");
    for (let t = 3; t <= 6; t++) shortTopics.set(`Topic ${t}`, 1);
    const id = startAttempt(w.examId, { size: 24, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(members(id)).toHaveLength(24);
  });

  it("two exams started together are built one after another: never more than 8 calls at once, and no shared questions", async () => {
    const w = practiceWorld(10);
    const a = startAttempt(w.examId, { size: 10, mode: "tutor", style: "recall", adaptive: false });
    const b = startAttempt(w.examId, { size: 10, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(a)).status).toBe("ready");
    expect((await ready(b)).status).toBe("ready");
    expect(maxInFlight).toBeLessThanOrEqual(8);
    const qa = new Set(members(a).map((r) => r.id));
    expect(members(b).some((r) => qa.has(r.id))).toBe(false);
  });

  it("a scoped exam (few topics) never runs more calls at once than it has sections", async () => {
    const w = practiceWorld(10);
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false, topicIds: w.topicIds.slice(0, 3) });
    expect((await ready(id)).status).toBe("ready");
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(members(id).every((r) => w.topicIds.slice(0, 3).includes(r.topic_id))).toBe(true);
  });

  it("case-set exam where 2 of 8 sets are rate limited is ready but short (case sets are not backfilled; pre-existing)", async () => {
    const w = practiceWorld(8);
    failTopics.add("Topic 2").add("Topic 5");
    const id = startAttempt(w.examId, { size: 32, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    const cases = new Set(members(id).map((r) => r.case_id));
    expect(cases.size).toBeLessThan(8);
    expect(cases.size).toBeGreaterThan(0);
  });

  it("every case set rate limited: the exam errors out with the rate-limit message", async () => {
    const w = practiceWorld(6);
    for (let t = 1; t <= 6; t++) failTopics.add(`Topic ${t}`);
    const id = startAttempt(w.examId, { size: 24, mode: "tutor", style: "caseset", adaptive: false });
    const st = await ready(id);
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/429|rate/);
  });
});

// ---- job 5: batched lookups on adversarial data ----
function examOld(userId: number, examId: number) {
  const topics = db.prepare("SELECT id FROM topics WHERE exam_id = ?").all(examId) as Pick<Topic, "id">[];
  if (topics.length === 0) return { mastery: null, studied: 0, readiness: 0, topics: 0 };
  const studied = new Set(
    (db.prepare("SELECT topic_id FROM topic_study WHERE user_id = ? AND topic_id IN (SELECT id FROM topics WHERE exam_id = ?)").all(userId, examId) as { topic_id: number }[]).map((r) => r.topic_id),
  );
  const conceptsOf = db.prepare("SELECT c.attempts, c.correct FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?");
  const all: number[] = [];
  let readiness = 0;
  for (const t of topics) {
    const ms = (conceptsOf.all(t.id) as ConceptRow[]).map(mastery).filter((m): m is number => m != null);
    all.push(...ms);
    const tm = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
    if (studied.has(t.id) || tm != null) readiness += tm ?? 0.5;
  }
  return { mastery: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null, studied: studied.size / topics.length, readiness: readiness / topics.length, topics: topics.length };
}
const mkExam = (userId: number, name: string, createdAt: string, topics: number) => {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, created_at) VALUES (?, ?, ?)").run(userId, name, createdAt).lastInsertRowid);
  const topicIds = Array.from({ length: topics }, (_, i) =>
    Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', '[]')").run(examId, i, `${name} t${i}`).lastInsertRowid),
  );
  return { examId, topicIds };
};

describe("job 5: batched lookups on adversarial data", () => {
  it("equal created_at, identical exam names, concepts shared by many topics of the same exam: batched == per-topic", () => {
    const userId = makeUser();
    const same = "2026-05-05 12:00:00";
    const a = mkExam(userId, "Twin", same, 2);
    const b = mkExam(userId, "Twin", same, 2);
    const c = mkExam(userId, "Twin", same, 3); // the exam under test shares name and timestamp with a and b
    const d = mkExam(userId, "Zed", same, 1);
    const concepts = ["béta", "Alpha", "alpha2", "Zulu", "10%", "a_b", "A%B"].map((n, i) =>
      Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, ?, ?, ?)").run(userId, n, i % 2 ? 0 : 4, i % 3).lastInsertRowid),
    );
    const link = (t: number, k: number) => db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(t, k);
    for (const k of concepts) for (const t of c.topicIds) link(t, k); // every concept in every topic of the exam
    concepts.forEach((k, i) => link([...a.topicIds, ...b.topicIds, ...d.topicIds][i % 5], k));
    concepts.forEach((k) => link(a.topicIds[0], k));
    const batched = topicConceptsForExam(c.examId);
    for (const t of c.topicIds) expect(batched.get(t) ?? []).toEqual(topicConcepts(t, c.examId));
    const names = batched.get(c.topicIds[0])!.flatMap((x) => x.earlier_exams);
    expect(names).toContain("Twin"); // same name, other exam, same time: listed (<=), once per concept
    for (const x of batched.get(c.topicIds[0])!) expect(new Set(x.earlier_exams).size).toBe(x.earlier_exams.length);
    // the earlier list is oldest exam first
    const withTwo = batched.get(c.topicIds[0])!.find((x) => x.earlier_exams.length > 1);
    if (withTwo) expect(withTwo.earlier_exams).toEqual(topicConcepts(c.topicIds[0], c.examId).find((x) => x.id === withTwo.id)!.earlier_exams);
  });

  it("an exam with no topics / topics with no concepts / concepts of other students", () => {
    const u = makeUser();
    const v = makeUser();
    const empty = mkExam(u, "Empty", "2026-01-01 00:00:00", 0);
    expect(topicConceptsForExam(empty.examId).size).toBe(0);
    expect(pendingCountsByTopic(empty.examId).size).toBe(0);
    expect(examProgress(u, empty.examId)).toEqual({ mastery: null, studied: 0, readiness: 0, topics: 0 });
    const e = mkExam(u, "Lone", "2026-01-02 00:00:00", 2);
    const other = mkExam(v, "Lone", "2026-01-01 00:00:00", 1);
    const cid = Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, 'x', 2, 1)").run(v).lastInsertRowid);
    db.prepare("INSERT INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(other.topicIds[0], cid);
    expect(topicConceptsForExam(e.examId).size).toBe(0);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(v, e.topicIds[0]); // another student's study mark
    expect(examProgress(u, e.examId)).toEqual(examOld(u, e.examId));
    expect(examProgress(u, e.examId).studied).toBe(0);
  });

  it("pending counts: NULL topics, flagged, foreign exams, skipped answers, answers replaced in later attempts", () => {
    const u = makeUser();
    const main = mkExam(u, "Main", "2026-03-01 00:00:00", 5);
    const other = mkExam(u, "Other", "2026-02-01 00:00:00", 2);
    const q = (examId: number, topicId: number | null, flagged = 0) =>
      Number(db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, flagged) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)").run(examId, topicId, flagged).lastInsertRowid);
    const att = (examId: number) => Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(examId).lastInsertRowid);
    const ans = (attemptId: number, qid: number, chosen: number | null, correct: number | null, conf: string | null) =>
      db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct, confidence) VALUES (?, ?, 0, ?, ?, ?)").run(attemptId, qid, chosen, correct, conf);
    const [t0, t1, t2, t3] = main.topicIds;
    const qs = {
      missed: q(main.examId, t0),
      unsureRight: q(main.examId, t1),
      guessRight: q(main.examId, t1),
      sureRight: q(main.examId, t1),
      flagged: q(main.examId, t2, 1),
      nullTopic: q(main.examId, null),
      foreign: q(other.examId, other.topicIds[0]),
      fixedLater: q(main.examId, t3),
      brokeLater: q(main.examId, t3),
      skippedAfterMiss: q(main.examId, t0),
      foreignTopicOwnExam: q(main.examId, other.topicIds[1]), // a question of this exam whose topic sits in another exam
    };
    const a1 = att(main.examId);
    const a2 = att(main.examId);
    const a3 = att(main.examId);
    ans(a1, qs.missed, 1, 0, "sure");
    ans(a1, qs.unsureRight, 0, 1, "unsure");
    ans(a1, qs.guessRight, 0, 1, "guess");
    ans(a1, qs.sureRight, 0, 1, "sure");
    ans(a1, qs.flagged, 1, 0, null);
    ans(a1, qs.nullTopic, 1, 0, null);
    ans(a1, qs.foreign, 1, 0, null);
    ans(a1, qs.fixedLater, 1, 0, null);
    ans(a1, qs.brokeLater, 0, 1, "sure");
    ans(a1, qs.skippedAfterMiss, 1, 0, null);
    ans(a1, qs.foreignTopicOwnExam, 1, 0, null);
    ans(a2, qs.fixedLater, 0, 1, "sure");
    ans(a2, qs.brokeLater, 1, 0, null);
    ans(a2, qs.skippedAfterMiss, null, null, null); // skipped: the earlier miss stays the latest answer
    ans(a3, qs.unsureRight, 0, 1, "sure"); // now sure: no longer pending
    const batched = pendingCountsByTopic(main.examId);
    for (const t of main.topicIds) expect(batched.get(t) ?? { missed: 0, unsure: 0 }).toEqual(pendingCounts(main.examId, [t]));
    expect(batched.get(t0)).toEqual({ missed: 2, unsure: 0 });
    expect(batched.get(t1)).toEqual({ missed: 0, unsure: 1 });
    expect(batched.get(t3)).toEqual({ missed: 1, unsure: 0 });
    expect(batched.has(t2)).toBe(false);
  });

  it("examProgress with 60 topics, shared concepts and mixed studied/untested topics equals the per-topic version", () => {
    const u = makeUser();
    const e = mkExam(u, "Big", "2026-04-01 00:00:00", 60);
    const concepts = Array.from({ length: 25 }, (_, i) => Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, ?, ?, ?)").run(u, `c${i}`, i % 5 === 0 ? 0 : i, i % 4).lastInsertRowid));
    e.topicIds.forEach((t, i) => {
      if (i % 7 === 0) return;
      for (let k = 0; k < i % 5; k++) db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(t, concepts[(i + k * 3) % 25]);
      if (i % 3 === 0) db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(u, t);
    });
    const now = examProgress(u, e.examId);
    const before = examOld(u, e.examId);
    expect(now.topics).toBe(60);
    expect(now.studied).toBe(before.studied);
    expect(now.readiness).toBeCloseTo(before.readiness, 12);
    expect(now.mastery).toBeCloseTo(before.mastery!, 12);
  });
});
