// Wave 1, practice exams (audit M3, M9, R1, L2, L3): chunked writing, double-start reuse, stale attempts, the shared
// question validator, the picture rule for case sets, and the start-up picture repair running once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; maxTokens?: number; system: string };
const gen = vi.hoisted(() => ({
  calls: [] as Call[],
  failOn: new Set<number>(), // 1-based call numbers that throw
  gate: null as Promise<void> | null,
  cases: null as null | ((asked: number, call: number) => unknown[]),
  counter: 0,
}));
/** The planned questions a prompt lists ("Q4: slide P12 — fact: … — recall"), grouped by case in case sets. */
const planned = (content: string) => [...content.matchAll(/^Q(\d+): slide P(\d+)(?: — case (\d+))?/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]), caseN: m[3] ? Number(m[3]) : null }));
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: Call) => {
    gen.calls.push(opts);
    const n = gen.calls.length;
    if (gen.gate) await gen.gate;
    if (gen.failOn.has(n)) throw new Error("overloaded_error 529");
    const slots = planned(opts.content);
    const asked = Number(/Write (\d+) /.exec(opts.content)?.[1] ?? 1);
    const page = Number(/\[P(\d+)\]/.exec(opts.content)?.[1] ?? 0);
    const q = (stem: string, source = page) => ({
      stem,
      options: ["A1", "B2", "C3", "D4", "E5"],
      correct_index: 0,
      correct_answer: "A1",
      explanation: "e",
      option_notes: ["n1", "n2", "n3", "n4", "n5"],
      source_page_id: source,
      concept: "Gen concept",
    });
    if (opts.purpose === "case sets") {
      // Each case answers the planned case listed in the same place; its questions take that case's slots in order.
      const groups = [...new Set(slots.map((s) => s.caseN))].map((c) => slots.filter((s) => s.caseN === c));
      const withSlots = (cases: { questions: object[] }[]) =>
        cases.map((c, i) => ({ ...c, questions: c.questions.map((x, j) => ({ slot: groups[i]?.[j]?.n, ...x })) }));
      if (gen.cases) return { cases: withSlots(gen.cases(asked, n) as { questions: object[] }[]) };
      return {
        cases: groups.map((g) => {
          const c = ++gen.counter;
          return {
            scenario: `scenario ${c}`,
            patient_box: { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" },
            image_page_id: null,
            questions: g.map((s, i) => ({ slot: s.n, ...q(`case ${c} question ${i + 1}`, s.page) })),
          };
        }),
      };
    }
    return { questions: slots.map((s) => ({ slot: s.n, type: "recall", image_page_id: null, patient_box: null, ...q(`generated stem ${++gen.counter}`, s.page) })) };
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});

import { sessionToken } from "@/lib/auth";
import { db, getMeta } from "@/lib/db";
import {
  CASES_PER_CALL,
  CASESET_CONCURRENCY,
  chunkSizes,
  INTERRUPTED_ATTEMPT,
  QUESTIONS_PER_CALL,
  recoverStaleAttempts,
  SECTION_CONCURRENCY,
  startAttempt,
  writingAttempt,
} from "@/lib/practice";
import { validateMcq, type ValidMcq } from "@/lib/mcq";
import { PICTURE_DETECTOR_VERSION, repairPictureQuestionsOnce } from "@/lib/questionImage";
import { EXAM_STYLE } from "@/lib/examStyle";
import { POST as attemptsPOST } from "@/app/api/exams/[id]/attempts/route";
import { POST as taskStartPOST } from "@/app/api/planner/tasks/[id]/start/route";
import { makeUser } from "./helpers";

/** A slide's notes: twelve facts of its own (an exam is planned one question per fact). */
const notes = (image: string | null, crop = false, slide = 0) =>
  JSON.stringify({
    title: "slide",
    summary: "s",
    image_description: image,
    key_facts: Array.from({ length: 12 }, (_, k) => `fact ${slide}.${k + 1}`),
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: crop ? { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } : null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
  });

function student(): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc', must_change_password = 0 WHERE id = ?").run(id);
  return id;
}

/** One exam, one topic: a plain slide, a slide with a picture, and a slide with a clinical-image crop (36 facts). */
function world(userId = student()) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'lec.pdf')").run(examId).lastInsertRowid);
  const ins = db.prepare("INSERT INTO pages (document_id, page_number, image_path, aspect, status, text, notes_json) VALUES (?, ?, 'x.jpg', 1.5, 'done', 'slide text', ?)");
  const plain = Number(ins.run(docId, 1, notes(null, false, 1)).lastInsertRowid);
  const photo = Number(ins.run(docId, 2, notes("a radiograph", false, 2)).lastInsertRowid);
  const crop = Number(ins.run(docId, 3, notes("clinical photo", true, 3)).lastInsertRowid);
  const topicId = Number(
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Topic 1', '', ?)").run(examId, JSON.stringify([plain, photo, crop])).lastInsertRowid,
  );
  return { userId, examId, topicId, plain, photo, crop };
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
  db
    .prepare("SELECT q.id, q.stem, q.case_id, q.image_page_id FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ? ORDER BY q.id")
    .all(attemptId) as { id: number; stem: string; case_id: number | null; image_page_id: number | null }[];
const written = (purpose: string) => gen.calls.filter((c) => c.purpose === purpose);
const asked = (c: Call) => Number(/Write (\d+) /.exec(c.content)?.[1]);

function signIn(userId: number | null) {
  if (userId == null) return void (jar.cookie = undefined);
  const { session_epoch } = db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(userId) as { session_epoch: number };
  jar.cookie = sessionToken(userId, session_epoch);
}
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;

let release: (() => void) | null = null;
beforeEach(() => {
  gen.calls = [];
  gen.failOn.clear();
  gen.cases = null;
  gen.gate = null;
  gen.counter = 0;
});
afterEach(() => {
  release?.();
  release = null;
  gen.gate = null;
});

describe("M3: no AI call asks for more than 12 questions or 3 case sets", () => {
  it("limits: 12 questions or 3 cases per call; 4 sections and 3 case sets at once", () => {
    expect(QUESTIONS_PER_CALL).toBe(12);
    expect(CASES_PER_CALL).toBe(3);
    expect(SECTION_CONCURRENCY).toBe(4);
    expect(CASESET_CONCURRENCY).toBe(3);
    expect(chunkSizes(30, 12)).toEqual([10, 10, 10]);
    expect(chunkSizes(12, 12)).toEqual([12]);
    expect(chunkSizes(13, 12)).toEqual([7, 6]);
    expect(chunkSizes(100, 12).every((n) => n <= 12)).toBe(true);
    expect(chunkSizes(100, 12).reduce((a, b) => a + b, 0)).toBe(100);
    expect(chunkSizes(0, 12)).toEqual([]);
  });

  it("a 30-question single-topic exam makes 3 calls of at most 12 and delivers 30, with output room sized to the turn", async () => {
    const w = world();
    const id = startAttempt(w.examId, { size: 30, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    const calls = written("practice questions");
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => asked(c) <= 12)).toBe(true);
    expect(calls.map(asked).reduce((a, b) => a + b, 0)).toBe(30);
    expect(calls.every((c) => (c.maxTokens ?? 0) < 32000)).toBe(true);
    expect(members(id)).toHaveLength(30);
  });

  it("the calls each write their own planned questions, side by side; none is told what the others wrote", async () => {
    const w = world();
    const id = startAttempt(w.examId, { size: 30, mode: "tutor", style: "recall", adaptive: false });
    await ready(id);
    const calls = written("practice questions");
    const lists = calls.map((c) => planned(c.content).map((s) => s.n));
    expect(lists.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (const c of calls) expect(c.content).not.toContain("already written for this practice exam");
  });

  it("a failing middle call gets one follow-up for its planned questions; failing twice leaves the exam short", async () => {
    const w = world();
    gen.failOn.add(2);
    const id = startAttempt(w.examId, { size: 30, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    const calls = written("practice questions");
    expect(calls).toHaveLength(4);
    expect(planned(calls[3].content)).toEqual(planned(calls[1].content));
    expect(members(id)).toHaveLength(30);

    gen.calls = [];
    gen.failOn.clear();
    gen.failOn.add(2).add(4);
    const short = startAttempt(w.examId, { size: 30, mode: "tutor", style: "recall", adaptive: false });
    const st = (await ready(short)) as { status: string };
    expect(st.status).toBe("ready");
    expect(members(short)).toHaveLength(20);
    expect((db.prepare("SELECT short_reason FROM attempts WHERE id = ?").get(short) as { short_reason: string }).short_reason).toBe("busy");
  });

  it("every turn failing fails the exam with the writer's error", async () => {
    const w = world();
    [1, 2, 3, 4, 5, 6, 7, 8].forEach((n) => gen.failOn.add(n));
    const id = startAttempt(w.examId, { size: 30, mode: "tutor", style: "recall", adaptive: false });
    const st = await ready(id);
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/overloaded/);
  });

  it("case sets: 8 cases on one topic are written 3 + 3 + 2, each case one patient", async () => {
    const w = world();
    const id = startAttempt(w.examId, { size: 32, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    const calls = written("case sets");
    expect(calls.map(asked)).toEqual([3, 3, 2]);
    expect(calls.map((c) => new Set(planned(c.content).map((s) => s.caseN)).size)).toEqual([3, 3, 2]);
    expect(new Set(members(id).map((m) => m.case_id)).size).toBe(8);
  });

  it("L4: EXAM_STYLE says nothing about how many options there are, nor about one patient carrying several questions", () => {
    expect(EXAM_STYLE).not.toMatch(/\bfour\b/i);
    expect(EXAM_STYLE).not.toMatch(/same patient may carry/);
  });
});

describe("L3: case sets follow the picture rules", () => {
  const box = { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" };
  const cq = (stem: string, source: number) => ({
    stem,
    options: ["A1", "B2", "C3", "D4", "E5"],
    correct_index: 1,
    correct_answer: "B2",
    explanation: "e",
    option_notes: ["n1", "n2", "n3", "n4", "n5"],
    source_page_id: source,
    concept: "c",
  });

  it("a picture question gets the case's picture, else its slide's; one with no slide to show goes, and a case left under three goes", async () => {
    const w = world();
    gen.cases = () => [
      // Case with a clinical picture: every question shows it.
      { scenario: "with picture", patient_box: box, image_page_id: w.crop, questions: [cq("Based on the image below, what is it?", w.plain), cq("Plain 1?", w.plain), cq("Plain 2?", w.plain)] },
      // No case picture: the picture question takes its own slide's picture.
      { scenario: "own slide", patient_box: box, image_page_id: null, questions: [cq("In the radiograph shown, what is the diagnosis?", w.photo), cq("Plain 3?", w.plain), cq("Plain 4?", w.plain)] },
      // No case picture, picture question cites no valid slide: it goes, three remain.
      { scenario: "drops one", patient_box: box, image_page_id: null, questions: [cq("Based on the image below, what next?", 999999), cq("P5?", w.plain), cq("P6?", w.plain), cq("P7?", w.plain)] },
    ];
    const id = startAttempt(w.examId, { size: 12, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    const rows = members(id);
    const byStem = new Map(rows.map((r) => [r.stem, r]));
    expect(byStem.get("Based on the image below, what is it?")?.image_page_id).toBe(w.crop);
    expect(byStem.get("Plain 1?")?.image_page_id).toBe(w.crop);
    expect(byStem.get("In the radiograph shown, what is the diagnosis?")?.image_page_id).toBe(w.photo);
    expect(byStem.get("Plain 3?")?.image_page_id).toBeNull();
    expect(byStem.has("Based on the image below, what next?")).toBe(false);
    expect(["P5?", "P6?", "P7?"].every((s) => byStem.has(s))).toBe(true);
    expect(written("case sets")[0].system).toContain("[IMAGE] or [IMAGE-CASE]");
  });

  it("a case that falls under three questions after dropping a picture question is dropped whole", async () => {
    const w = world();
    gen.cases = () => [
      { scenario: "too short", patient_box: box, image_page_id: null, questions: [cq("Based on the image below, what next?", 999999), cq("S1?", w.plain), cq("S2?", w.plain)] },
      { scenario: "fine", patient_box: box, image_page_id: null, questions: [cq("F1?", w.plain), cq("F2?", w.plain), cq("F3?", w.plain)] },
    ];
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(members(id).map((r) => r.stem)).toEqual(["F1?", "F2?", "F3?"]);
    expect(db.prepare("SELECT COUNT(*) n FROM cases WHERE scenario = 'too short'").get()).toEqual({ n: 0 });
  });
});

describe("M9: a second Start while the first exam is being written gets the same exam", () => {
  const hold = () => {
    gen.gate = new Promise<void>((r) => (release = r));
  };

  it("same exam within ten minutes: same attempt; once ready, or older than ten minutes: a new one", async () => {
    const w = world();
    signIn(w.userId);
    hold();
    const a = (await (await attemptsPOST(post({ size: 10 }), ctx(w.examId))).json()) as { id: number };
    const b = (await (await attemptsPOST(post({ size: 10 }), ctx(w.examId))).json()) as { id: number };
    expect(b.id).toBe(a.id);
    expect((db.prepare("SELECT COUNT(*) n FROM attempts WHERE exam_id = ?").get(w.examId) as { n: number }).n).toBe(1);

    db.prepare("UPDATE attempts SET started_at = datetime('now', '-11 minutes') WHERE id = ?").run(a.id);
    const c = (await (await attemptsPOST(post({ size: 10 }), ctx(w.examId))).json()) as { id: number };
    expect(c.id).not.toBe(a.id);

    db.prepare("UPDATE attempts SET status = 'ready' WHERE id = ?").run(c.id);
    const d = (await (await attemptsPOST(post({ size: 10 }), ctx(w.examId))).json()) as { id: number };
    expect(d.id).not.toBe(c.id);
    expect(d.id).not.toBe(a.id);
  });

  it("another student's exam is never reused", async () => {
    const mine = world();
    const theirs = world();
    hold();
    signIn(mine.userId);
    const a = (await (await attemptsPOST(post({}), ctx(mine.examId))).json()) as { id: number };
    signIn(theirs.userId);
    const b = (await (await attemptsPOST(post({}), ctx(theirs.examId))).json()) as { id: number };
    expect(b.id).not.toBe(a.id);
    expect(writingAttempt(theirs.userId, mine.examId)).toBeNull();
    expect(writingAttempt(mine.userId, mine.examId)).toBe(a.id);
  });

  it("from a plan task: the same task reuses its exam; a different task or the exam page does not", async () => {
    const w = world();
    signIn(w.userId);
    hold();
    const task = (kind: string) =>
      Number(
        db
          .prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, topic_ids, minutes, title) VALUES (?, '2026-11-13', ?, ?, ?, 20, 't')")
          .run(w.userId, w.examId, kind, JSON.stringify([w.topicId])).lastInsertRowid,
      );
    const t1 = task("practice");
    const t2 = task("practice");
    const url = async (t: number) => ((await (await taskStartPOST(post({}), ctx(t))).json()) as { url: string }).url;
    const first = await url(t1);
    expect(await url(t1)).toBe(first);
    const other = await url(t2);
    expect(other).not.toBe(first);
    const fromPage = (await (await attemptsPOST(post({}), ctx(w.examId))).json()) as { id: number };
    expect(`/attempts/${fromPage.id}`).not.toBe(first);
    expect(`/attempts/${fromPage.id}`).not.toBe(other);
  });

  it("a bad body is not a 500", async () => {
    const w = world();
    signIn(w.userId);
    hold();
    const res = await attemptsPOST(new Request("http://x/api", { method: "POST", body: "{not json" }), ctx(w.examId));
    expect(res.status).toBe(200);
  });
});

describe("R1: practice exams cut off by a restart", () => {
  it("generating for over five minutes becomes an error; a fresh one and a ready one are untouched", () => {
    const w = world();
    const add = (status: string, age: string) =>
      Number(db.prepare(`INSERT INTO attempts (exam_id, mode, status, started_at) VALUES (?, 'tutor', ?, datetime('now', ?))`).run(w.examId, status, age).lastInsertRowid);
    const stale = add("generating", "-6 minutes");
    const fresh = add("generating", "-1 minutes");
    const oldReady = add("ready", "-60 minutes");
    expect(recoverStaleAttempts().failed).toBeGreaterThanOrEqual(1);
    const row = (id: number) => db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(id) as { status: string; error: string | null };
    expect(row(stale)).toEqual({ status: "error", error: INTERRUPTED_ATTEMPT });
    expect(INTERRUPTED_ATTEMPT).toBe("This practice exam was interrupted while it was being written. Start it again; questions already written are reused.");
    expect(row(fresh)).toEqual({ status: "generating", error: null });
    expect(row(oldReady)).toEqual({ status: "ready", error: null });
    expect(recoverStaleAttempts()).toEqual({ recovered: 0, failed: 0 });
  });
});

describe("L2: validateMcq", () => {
  const base = { stem: "  What is it?  ", options: ["Alpha", "Beta", "Gamma", "Delta"], correct_index: 2, correct_answer: "Gamma", option_notes: ["na", "nb", "nc", "nd"], source_page_id: 7 };
  const rules = { optionCount: 4, validPageIds: new Set([7, 8]) };
  const ok = (r: ValidMcq | string): ValidMcq => {
    if (typeof r === "string") throw new Error(`rejected: ${r}`);
    return r;
  };

  it.each([
    ["too few options", { options: ["Alpha", "Beta", "Gamma"], option_notes: null }],
    ["too many options", { options: ["Alpha", "Beta", "Gamma", "Delta", "Eps"], option_notes: null }],
    ["a blank option", { options: ["Alpha", "  ", "Gamma", "Delta"] }],
    ["options repeated ignoring case and spacing", { options: ["Alpha", "beta", "Gamma", " BETA "], correct_answer: undefined }],
    ["a non-text option", { options: ["Alpha", 3, "Gamma", "Delta"] }],
    ["index not a whole number", { correct_index: 1.5, correct_answer: undefined }],
    ["index out of range", { correct_index: 4, correct_answer: undefined }],
    ["negative index", { correct_index: -1, correct_answer: undefined }],
    ["NaN index", { correct_index: Number.NaN, correct_answer: undefined }],
    ["answer text matches no option", { correct_answer: "Omega" }],
    ["answer text matches a different option than the index", { correct_answer: "Beta" }],
    ["blank stem", { stem: "   " }],
    ["no options", { options: undefined }],
  ])("drops: %s", (_name, change) => {
    expect(typeof validateMcq({ ...base, ...change }, rules)).toBe("string");
  });

  it("keeps a good question: trims, shuffles with the notes kept beside their options, and keys the moved answer", () => {
    for (let i = 0; i < 30; i++) {
      const q = ok(validateMcq({ ...base, options: [" Alpha", "Beta ", "Gamma", "Delta"] }, rules));
      expect(q.stem).toBe("What is it?");
      expect(q.options[q.correct_index]).toBe("Gamma");
      expect([...q.options].sort()).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
      const noteOf = { Alpha: "na", Beta: "nb", Gamma: "nc", Delta: "nd" } as Record<string, string>;
      expect(q.option_notes).toEqual(q.options.map((o) => noteOf[o]));
      expect(q.order.map((i) => base.options[i])).toEqual(q.options);
    }
  });

  it("answer text: punctuation and case don't matter; missing or blank text trusts the index", () => {
    expect(ok(validateMcq({ ...base, correct_answer: "gamma." }, rules)).options).toContain("Gamma");
    expect(typeof validateMcq({ ...base, correct_answer: undefined }, rules)).toBe("object");
    expect(typeof validateMcq({ ...base, correct_answer: "  " }, rules)).toBe("object");
  });

  it("notes that don't fit are dropped, the question stays", () => {
    for (const notes of [null, ["a", "b", "c"], ["a", "", "c", "d"], ["a", 2, "c", "d"], "x"]) {
      expect(ok(validateMcq({ ...base, option_notes: notes }, rules)).option_notes).toBeNull();
    }
    expect(ok(validateMcq({ ...base, option_notes: [" a ", "b", "c", "d\n"] }, { ...rules, shuffle: false })).option_notes).toEqual(["a", "b", "c", "d"]);
  });

  it("source slide: kept when valid, cleared when not, and required only when asked (and there are slides)", () => {
    expect(ok(validateMcq(base, rules)).source_page_id).toBe(7);
    expect(ok(validateMcq({ ...base, source_page_id: 99 }, rules)).source_page_id).toBeNull();
    expect(ok(validateMcq({ ...base, source_page_id: null }, rules)).source_page_id).toBeNull();
    expect(typeof validateMcq({ ...base, source_page_id: 99 }, { ...rules, requireSource: true })).toBe("string");
    expect(ok(validateMcq({ ...base, source_page_id: 99 }, { optionCount: 4, validPageIds: new Set(), requireSource: true })).source_page_id).toBeNull();
  });

  it("question text may come as `question` (quiz writers); shuffle can be turned off", () => {
    const q = ok(validateMcq({ ...base, stem: undefined, question: "Q?" }, { ...rules, shuffle: false }));
    expect(q.stem).toBe("Q?");
    expect(q.options).toEqual(base.options);
    expect(q.correct_index).toBe(2);
  });
});

describe("R11/L3: the start-up picture repair runs once per detector version", () => {
  it("runs, marks itself done, and is skipped the next time", () => {
    const w = world();
    const insQ = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', ?, '[\"a\",\"b\"]', 0, 'e', NULL)");
    const first = Number(insQ.run(w.examId, w.topicId, "Based on the image below, what is it?").lastInsertRowid);
    expect(getMeta(`picture_repair_v${PICTURE_DETECTOR_VERSION}`)).toBeNull();
    expect(repairPictureQuestionsOnce()).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT id FROM questions WHERE id = ?").get(first)).toBeUndefined();
    expect(getMeta(`picture_repair_v${PICTURE_DETECTOR_VERSION}`)).not.toBeNull();
    const second = Number(insQ.run(w.examId, w.topicId, "Based on the image below, what is that?").lastInsertRowid);
    expect(repairPictureQuestionsOnce()).toBe(0);
    expect(db.prepare("SELECT id FROM questions WHERE id = ?").get(second)).toBeDefined();
  });
});
