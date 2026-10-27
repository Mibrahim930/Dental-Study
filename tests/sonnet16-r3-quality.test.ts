// Sonnet QA 16: attack tests for Release 3 Jobs B (fact-based quiz, quality tier), C (saved progress, Continue card),
// D (option notes) and E (lessons). Tests named "BUG: …" document a real defect and are left failing on purpose.
import fs from "fs";
import path from "path";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; tier?: string };
const calls: Call[] = [];
/** What the quiz writer returns for the planned slots; default: one valid question per slot. */
let writer: (slots: { n: number; page: number | null; fact: string | null }[], tryNo: number) => unknown[] = () => [];
let judge: (n: number) => { n: number; ok: boolean; reason: string }[] = () => [];
let lessonWriter: (call: number, content: string) => unknown = () => ({});
let lessonCalls = 0;
let tryNo = 0;
const OPTIONS = ["right", "w1", "w2", "w3"];

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string; tier?: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content, tier: opts.tier });
    if (opts.purpose === "section quiz") {
      tryNo++;
      const slots = [...opts.content.matchAll(/^Q(\d+): (?:slide P(\d+)|the section)(?: — fact: "(.*)")? — /gm)].map((m) => ({
        n: Number(m[1]),
        page: m[2] ? Number(m[2]) : null,
        fact: m[3] ?? null,
      }));
      return { questions: writer(slots, tryNo) };
    }
    if (opts.purpose === "section quiz check") return { verdicts: judge((opts.content.match(/^\d+\. /gm) ?? []).length) };
    if (opts.purpose === "lesson" || opts.purpose === "lesson repair") return lessonWriter(++lessonCalls, opts.content);
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

import { db, getMeta, resetSectionQuiz, type Topic } from "@/lib/db";
import { getSectionQuiz, getLesson, lessonIsCurrent, lessonText, LESSON_VERSION, QUIZ_VERSION, type QuizQuestion } from "@/lib/study";
import { normStem, planQuizByFacts, quizSize, QUIZ_MAX, QUIZ_MIN, type FactSlide } from "@/lib/quizPlan";
import { clearQuizAnswers, migrateSessionChecks, quizAnswers, recordQuizAnswer } from "@/lib/quizProgress";
import { coveredFacts, keyWords } from "@/lib/lessonCoverage";
import { optionNotes } from "@/lib/attemptView";
import { optionNotesJson } from "@/lib/practice";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as retakePOST } from "@/app/api/sessions/[id]/quiz/retake/route";
import { GET as reviewGET } from "@/app/api/review/route";
import { makeUser } from "./helpers";

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const slide = (id: number, facts: string[], o: Partial<FactSlide> = {}): FactSlide => ({ id, keyFacts: facts.length, emphasized: false, hasCase: false, facts, ...o });
const notesJson = (i: number, facts: string[], emphasized = false) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized, emphasis_note: null,
    case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

/** One exam, one topic over n slides (facts per slide from `facts`), one study session. */
function world(n: number, facts: (i: number) => string[] = (i) => [`fact a${i}`, `fact b${i}`], o: { starred?: number[]; userId?: number } = {}) {
  const userId = o.userId ?? makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized) VALUES (?, ?, '', 'done', ?, ?)")
        .run(doc, i + 1, notesJson(i, facts(i), o.starred?.includes(i)), o.starred?.includes(i) ? 1 : 0).lastInsertRowid,
    ),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, doc, pages, topicId, sessionId, topic };
}

/** A stored version-3 quiz of `count` questions (no AI involved). */
function storeQuiz(topicId: number, count = 4, version = QUIZ_VERSION, o: { hidden?: number[] } = {}) {
  const qs: QuizQuestion[] = Array.from({ length: count }, (_, i) => ({
    id: `q${i}`, question: `Question ${i}?`, options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", option_notes: ["na", "nb", "nc", "nd"],
    kind: "recall", ...(o.hidden?.includes(i) ? { hidden: true } : {}),
  })) as QuizQuestion[];
  db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(JSON.stringify(qs), version, topicId);
  return qs;
}
const newSession = (examId: number) => Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
const check = (sessionId: number, body: unknown) => checkPOST(new Request("http://x/c", post(body)), ctx(sessionId));
const retake = (sessionId: number, body: unknown) => retakePOST(new Request("http://x/r", post(body)), ctx(sessionId));
const getQuiz = async (sessionId: number) => (await (await quizGET(new Request("http://x/q?position=0"), ctx(sessionId))).json()) as { answered: Record<string, number>; questions: QuizQuestion[] };

const factsIn = (content: string) => [...content.matchAll(/^Q\d+: .*? — fact: "(.*)" — /gm)].map((m) => m[1]);
/** Default writer: a unique valid question per planned slot. */
const okWriter = (slots: { n: number; page: number | null }[], t: number, extra: (n: number) => object = () => ({})) =>
  slots.map((s) => ({
    slot: s.n, question: `Q${s.n} (try ${t})`, options: [...OPTIONS], correct_index: 0, correct_answer: "right", explanation: "e (L1, slide 1)",
    source_page_id: s.page ?? 0, concept: "Quiz concept", ...extra(s.n),
  }));

beforeEach(() => {
  calls.length = 0;
  tryNo = 0;
  lessonCalls = 0;
  judge = () => [];
  writer = (slots, t) => okWriter(slots, t);
  currentUserId = 0;
});
afterEach(() => {
  delete process.env.QUIZ_JUDGE;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// B — quizSize / planQuizByFacts
// ---------------------------------------------------------------------------------------------------------------
describe("B: quizSize", () => {
  it("0 slides and 1 slide with nothing listed give the floor", () => {
    expect(quizSize([])).toBe(QUIZ_MIN);
    expect(quizSize([{ facts: [] }])).toBe(QUIZ_MIN);
  });
  it("whitespace, case and punctuation variants are one fact", () => {
    expect(quizSize([{ facts: ["Pulp  chamber.", "pulp chamber", "  PULP-CHAMBER!! "] }, { facts: ["x1", "x2", "x3", "x4", "x5"] }])).toBe(6);
  });
  it("facts that normalise to nothing count like a slide with no facts (1)", () => {
    expect(quizSize([{ facts: ["—", "  ", "!!!"] }, { facts: [] }, { facts: ["real fact"] }, { facts: ["a"] }, { facts: ["b"] }, { facts: ["c"] }])).toBe(6);
  });
  it("exactly 5 / 25 / 26 distinct facts", () => {
    const f = (n: number) => [{ facts: Array.from({ length: n }, (_, i) => `fact number ${i}`) }];
    expect(quizSize(f(5))).toBe(5);
    expect(quizSize(f(25))).toBe(25);
    expect(quizSize(f(26))).toBe(25);
    expect(quizSize(f(4))).toBe(5);
  });
  it("a slide that lists the same fact twice counts it once", () => {
    expect(quizSize([{ facts: ["a1", "a1", "a1"] }])).toBe(QUIZ_MIN);
    expect(quizSize([{ facts: Array.from({ length: 8 }, () => "same") }, { facts: ["b", "c", "d", "e", "f", "g"] }])).toBe(7);
  });
  it("unicode and numbers are facts (not stripped to empty)", () => {
    expect(quizSize([{ facts: ["١٢٣", "٤٥٦", "Ménière", "meniere", "12", "13", "14"] }])).toBeGreaterThanOrEqual(6);
  });
});

describe("B: planQuizByFacts", () => {
  const nonNullFacts = (slots: { fact: string | null }[]) => slots.map((s) => s.fact).filter((f): f is string => f != null);

  it("0 slides: the floor, all page null, angles cycle", () => {
    const s = planQuizByFacts([]);
    expect(s).toHaveLength(5);
    expect(s.every((x) => x.page === null && x.fact === null)).toBe(true);
    expect(new Set(s.map((x) => x.angle)).size).toBe(3);
  });

  it("1 slide with 1 fact reaches the floor and varies the angles", () => {
    const s = planQuizByFacts([slide(7, ["only fact"])]);
    expect(s).toHaveLength(5);
    expect(s.every((x) => x.page === 7)).toBe(true);
    expect(nonNullFacts(s)).toEqual(["only fact"]);
    expect(new Set(s.map((x) => x.angle)).size).toBeGreaterThanOrEqual(3);
  });

  it("BUG: a fact listed twice on the same slide gets two slots (no two slots may share a fact)", () => {
    const s = planQuizByFacts([slide(1, ["Alpha fact", "Alpha fact", "Beta fact"]), slide(2, ["c1", "c2", "c3", "c4"])]);
    const facts = nonNullFacts(s).map(normStem);
    expect(new Set(facts).size).toBe(facts.length);
  });

  it("BUG: a slide whose only 'fact' normalises to nothing pins junk ('—') as the fact to test", () => {
    const s = planQuizByFacts([slide(1, ["—"]), slide(2, ["a b c"]), slide(3, ["d e f"]), slide(4, ["g h i"]), slide(5, ["j k l"])]);
    for (const x of s) if (x.fact != null) expect(normStem(x.fact), `fact ${JSON.stringify(x.fact)}`).not.toBe("");
  });

  it("whitespace/case/punctuation duplicates across slides give one slot", () => {
    const s = planQuizByFacts([slide(1, ["Pulp chamber roof"]), slide(2, ["pulp   chamber roof!"]), slide(3, ["x y z", "q w e", "r t y", "u i o"])]);
    expect(nonNullFacts(s).map(normStem).filter((f) => f === "pulp chamber roof")).toHaveLength(1);
  });

  it("exactly 5 / 25 / 26 facts", () => {
    const mk = (n: number) => [slide(1, Array.from({ length: n }, (_, i) => `fact number ${i}`))];
    expect(planQuizByFacts(mk(5))).toHaveLength(5);
    expect(planQuizByFacts(mk(25))).toHaveLength(25);
    const s26 = planQuizByFacts(mk(26));
    expect(s26).toHaveLength(25);
    expect(nonNullFacts(s26)).toEqual(Array.from({ length: 25 }, (_, i) => `fact number ${i}`)); // first 25 in listed order
  });

  it("a stressed slide with 30 facts alone is cut to 25, in order, all from that slide", () => {
    const s = planQuizByFacts([slide(9, Array.from({ length: 30 }, (_, i) => `fact number ${i}`), { emphasized: true })]);
    expect(s).toHaveLength(25);
    expect(new Set(s.map((x) => x.page))).toEqual(new Set([9]));
    expect(nonNullFacts(s)[24]).toBe("fact number 24");
  });

  it("ceiling cut: stressed first, then case slides, then slide order; output stays in slide order", () => {
    const slides = [
      ...Array.from({ length: 10 }, (_, i) => slide(i + 1, [`p${i}a`, `p${i}b`, `p${i}c`])), // plain
      slide(11, ["case1", "case2", "case3"], { hasCase: true }),
      slide(12, ["star1", "star2", "star3"], { emphasized: true }),
    ]; // 36 facts → 25
    const s = planQuizByFacts(slides);
    expect(s).toHaveLength(25);
    const facts = nonNullFacts(s);
    for (const f of ["star1", "star2", "star3", "case1", "case2", "case3"]) expect(facts).toContain(f);
    const order = s.map((x) => x.page!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // the 19 plain facts that survive are the first ones in slide order
    expect(facts.filter((f) => f.startsWith("p"))).toEqual(Array.from({ length: 19 }, (_, i) => `p${Math.floor(i / 3)}${"abc"[i % 3]}`));
  });

  it("emphasized+case outranks emphasized-only and case-only when cutting", () => {
    const slides = [
      slide(1, Array.from({ length: 10 }, (_, i) => `a${i}`), { emphasized: true }),
      slide(2, Array.from({ length: 10 }, (_, i) => `b${i}`), { hasCase: true }),
      slide(3, Array.from({ length: 10 }, (_, i) => `c${i}`), { emphasized: true, hasCase: true }),
    ];
    const f = nonNullFacts(planQuizByFacts(slides));
    expect(f.filter((x) => x.startsWith("c"))).toHaveLength(10);
    expect(f.filter((x) => x.startsWith("a"))).toHaveLength(10);
    expect(f.filter((x) => x.startsWith("b"))).toHaveLength(5);
  });

  it("invariants over 4000 random section shapes: exact size, floor/ceiling, unique facts, 'not' only on 4+-fact slides", () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let t = 0; t < 4000; t++) {
      const n = rnd(7); // 0..6 slides
      const slides: FactSlide[] = Array.from({ length: n }, (_, i) =>
        slide(100 + i, Array.from({ length: rnd(10) }, (_, k) => `fact ${rnd(40)} of ${rnd(3)} k${k}`), { emphasized: rnd(4) === 0, hasCase: rnd(5) === 0 }),
      );
      const size = quizSize(slides);
      const s = planQuizByFacts(slides);
      expect(s.length, JSON.stringify(slides)).toBe(size);
      expect(size).toBeGreaterThanOrEqual(QUIZ_MIN);
      expect(size).toBeLessThanOrEqual(QUIZ_MAX);
      const facts = nonNullFacts(s).map(normStem);
      expect(new Set(facts).size, JSON.stringify(slides)).toBe(facts.length);
      for (const x of s) {
        if (n > 0) expect(slides.some((sl) => sl.id === x.page)).toBe(true);
        if (x.angle === "not") expect(slides.find((sl) => sl.id === x.page)!.facts.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("angles vary: a 6-slide plain section uses recall, apply and compare", () => {
    const s = planQuizByFacts(Array.from({ length: 6 }, (_, i) => slide(i + 1, [`f${i}a`, `f${i}b`])));
    expect(new Set(s.map((x) => x.angle))).toEqual(new Set(["recall", "apply", "compare"]));
  });

  it("floor: a 5-fact list slide gets a 'not' extra only when the slide is a list (4+ facts)", () => {
    const withList = planQuizByFacts([slide(1, ["a1", "a2", "a3", "a4"])]);
    expect(withList).toHaveLength(5);
    const noList = planQuizByFacts([slide(1, ["a1", "a2", "a3"])]);
    expect(noList.some((x) => x.angle === "not")).toBe(false);
  });

});

// ---------------------------------------------------------------------------------------------------------------
// B — generateSectionQuiz with a mocked writer
// ---------------------------------------------------------------------------------------------------------------
describe("B: generateSectionQuiz", () => {
  it("names each fact once in the prompts, writers use the quality tier, the checker does not", async () => {
    const w = world(5);
    await getSectionQuiz(w.topic());
    const writes = calls.filter((c) => c.purpose === "section quiz");
    expect(writes.length).toBe(2);
    expect(writes.every((c) => c.tier === "quality")).toBe(true);
    expect(calls.filter((c) => c.purpose === "section quiz check").every((c) => c.tier === undefined)).toBe(true);
    const f = writes.flatMap((c) => factsIn(c.content));
    expect(f.sort()).toEqual(Array.from({ length: 5 }, (_, i) => [`fact a${i}`, `fact b${i}`]).flat().sort());
  });

  it("a writer that reuses one question text for two slots: the duplicate is dropped and the repair writes the missing one", async () => {
    const w = world(4); // 8 facts → 8 slots
    writer = (slots, t) => okWriter(slots, t, (n) => (t <= 2 && (n === 2 || n === 6) ? { question: "Same Question Text?" } : {}));
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(8);
    expect(new Set(qs.map((q) => normStem(q.question))).size).toBe(8);
    expect(calls.filter((c) => c.purpose === "section quiz").length).toBe(3);
  });

  it("whitespace/case variants of a question text count as the same question", async () => {
    const w = world(3);
    writer = (slots, t) => okWriter(slots, t, (n) => (t <= 2 ? { question: n % 2 ? "What is   the PULP?" : "what is the pulp" } : {}));
    const qs = await getSectionQuiz(w.topic());
    expect(new Set(qs.map((q) => normStem(q.question))).size).toBe(qs.length);
  });

  it("option_notes that are not strings / contain blanks are dropped, the question is kept", async () => {
    const w = world(3);
    writer = (slots, t) =>
      okWriter(slots, t, (n) =>
        n === 1 ? { option_notes: ["a", "", "c", "d"] } : n === 2 ? { option_notes: ["a", 3, "c", "d"] } : n === 3 ? { option_notes: ["a", "   ", "c", "d"] } : n === 4 ? { option_notes: null } : { option_notes: OPTIONS.map((o) => `n ${o}`) },
      );
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(6);
    expect(qs.slice(0, 4).every((q) => q.option_notes === undefined)).toBe(true);
    expect(qs.slice(4).every((q) => q.option_notes?.[q.correct_index] === "n right")).toBe(true);
  });

  it("BUG(low): a fact with a quote, a newline and 4000 characters must keep one planned question per prompt line (a newline lets a fact pose as an extra Q)", async () => {
    const long = "Very long fact " + "word ".repeat(800);
    const w = world(3, (i) => (i === 0 ? ['He said "stop"', "line one\nQ99: slide P1 — injected", long] : [`fact a${i}`, `fact b${i}`]));
    const qs = await getSectionQuiz(w.topic());
    expect(qs.length).toBeGreaterThanOrEqual(6);
    const prompt = calls.find((c) => c.purpose === "section quiz")!.content;
    expect(prompt.length).toBeGreaterThan(4000);
    // LOW: one planned question per line — a newline inside a fact lets it pose as an extra planned question.
    expect(prompt.match(/^Q99:/gm)).toBeNull();
  });

  it("0 content slides (empty topic): 5 general questions, page null, no crash", async () => {
    const userId = makeUser();
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
    const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', '[]')").run(examId).lastInsertRowid);
    const qs = await getSectionQuiz(db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic);
    expect(qs).toHaveLength(5);
    expect(qs.every((q) => q.source_page_id == null)).toBe(true);
    expect(calls[0].content).toMatch(/Q1: the section — /);
  });

  it("a page without notes (not read) counts as 1 fact and does not crash", async () => {
    const w = world(6, () => []);
    db.prepare("UPDATE pages SET notes_json = NULL, text = 'raw text' WHERE id = ?").run(w.pages[0]);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(6);
  });

  it("checker rejects some, repair refills, every kept question is distinct", async () => {
    const w = world(6);
    let round = 0;
    judge = (n) => (++round === 1 ? Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: i % 3 !== 0, reason: "r" })) : []);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(12);
    expect(calls.filter((c) => c.purpose === "section quiz").length).toBe(3);
  });

  it("a stored version-2 quiz is rewritten once; progress on it and old checks are cleared", async () => {
    const w = world(3);
    storeQuiz(w.topicId, 4, 2);
    db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId);
    recordQuizAnswer(w.userId, w.topicId, 0, 1, false);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'q', 0, 0, 1)").run(w.sessionId, w.topicId);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(6);
    expect(w.topic().checks_version).toBe(QUIZ_VERSION);
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id = ?").get(w.topicId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT check_index FROM session_checks WHERE topic_id = ?").all(w.topicId)).toEqual([{ check_index: null }]);
    const before = calls.length;
    await getSectionQuiz(w.topic());
    expect(calls.length).toBe(before); // version 3 now: no further AI
  });

  it("concurrent opens share one generation", async () => {
    const w = world(3);
    await Promise.all([getSectionQuiz(w.topic()), getSectionQuiz(w.topic()), getSectionQuiz(w.topic())]);
    expect(calls.filter((c) => c.purpose === "section quiz").length).toBe(2);
  });

  it("a failed rewrite of an old quiz keeps the old quiz, its version and the student's answers", async () => {
    const w = world(3);
    storeQuiz(w.topicId, 4, 2);
    recordQuizAnswer(w.userId, w.topicId, 0, 1, false);
    writer = () => {
      throw new Error("writer down");
    };
    await expect(getSectionQuiz(w.topic())).rejects.toThrow();
    expect(w.topic().checks_version).toBe(2);
    expect(quizAnswers(w.userId, w.topicId)).toEqual({ 0: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C — quizProgress and routes
// ---------------------------------------------------------------------------------------------------------------
describe("C: saved progress", () => {
  it("answers resume in another session (and the order does not matter)", async () => {
    const w = world(2);
    storeQuiz(w.topicId, 4);
    currentUserId = w.userId;
    expect((await check(w.sessionId, { topicId: w.topicId, index: 0, chosen: 2 })).status).toBe(200);
    expect((await check(w.sessionId, { topicId: w.topicId, index: 2, chosen: 0 })).status).toBe(200);
    const s2 = newSession(w.examId);
    expect((await getQuiz(s2)).answered).toEqual({ 0: 2, 2: 0 });
  });

  it("another student's rows on the same topic never show", async () => {
    const w = world(2);
    storeQuiz(w.topicId, 4);
    const other = makeUser();
    recordQuizAnswer(other, w.topicId, 1, 3, false);
    currentUserId = w.userId;
    expect((await getQuiz(w.sessionId)).answered).toEqual({});
    recordQuizAnswer(w.userId, w.topicId, 0, 1, false);
    expect((await getQuiz(w.sessionId)).answered).toEqual({ 0: 1 });
    expect(quizAnswers(other, w.topicId)).toEqual({ 1: 3 });
  });

  it("a second answer to the same question is 200, changes nothing and writes no session_checks row (same or other session)", async () => {
    const w = world(2);
    storeQuiz(w.topicId, 4);
    currentUserId = w.userId;
    const first = await (await check(w.sessionId, { topicId: w.topicId, index: 0, chosen: 1 })).json();
    expect(first).toEqual({ ok: true, correct: false });
    const again = await check(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    const s2 = newSession(w.examId);
    expect((await check(s2, { topicId: w.topicId, index: 0, chosen: 0 })).status).toBe(200);
    expect(quizAnswers(w.userId, w.topicId)).toEqual({ 0: 1 });
    expect(db.prepare("SELECT session_id, correct FROM session_checks WHERE topic_id = ?").all(w.topicId)).toEqual([{ session_id: w.sessionId, correct: 0 }]);
    expect(db.prepare("SELECT attempts FROM concepts WHERE user_id = ? AND name = 'C'").get(w.userId)).toEqual({ attempts: 1 }); // mastery counted once
  });

  it("validation: unknown index, out-of-range / non-integer chosen, hidden question, strangers, other exams' topic", async () => {
    const w = world(2);
    storeQuiz(w.topicId, 4, QUIZ_VERSION, { hidden: [3] });
    const other = world(2);
    storeQuiz(other.topicId, 4);
    currentUserId = w.userId;
    for (const body of [
      { topicId: w.topicId, index: 9, chosen: 0 }, { topicId: w.topicId, index: -1, chosen: 0 }, { topicId: w.topicId, index: 0.5, chosen: 0 },
      { topicId: w.topicId, index: 0, chosen: 4 }, { topicId: w.topicId, index: 0, chosen: -1 }, { topicId: w.topicId, index: 0, chosen: 1.5 },
      { topicId: w.topicId, index: 0, chosen: "1" }, { topicId: w.topicId, index: 3, chosen: 0 }, { topicId: other.topicId, index: 0, chosen: 0 },
      { topicId: "x", index: 0, chosen: 0 }, {}, null,
    ]) expect((await check(w.sessionId, body)).status, JSON.stringify(body)).toBe(400);
    expect((await check(other.sessionId, { topicId: other.topicId, index: 0, chosen: 0 })).status).toBe(404); // not hers
    expect(quizAnswers(w.userId, w.topicId)).toEqual({});
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id IN (?, ?)").get(w.topicId, other.topicId)).toEqual({ n: 0 });
  });

  it("retake: ownership and input validation", async () => {
    const w = world(2);
    storeQuiz(w.topicId, 4);
    const other = world(2);
    storeQuiz(other.topicId, 4);
    recordQuizAnswer(w.userId, w.topicId, 0, 1, false);
    currentUserId = other.userId;
    expect((await retake(w.sessionId, { topicId: w.topicId })).status).toBe(404); // someone else's session
    currentUserId = w.userId;
    expect((await retake(w.sessionId, { topicId: other.topicId })).status).toBe(404); // a topic of another exam
    for (const body of [{ topicId: String(w.topicId) }, { topicId: 1.5 }, { topicId: null }, {}, null, { topicId: [w.topicId] }]) {
      expect((await retake(w.sessionId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await retakePOST(new Request("http://x/r", { method: "POST", body: "not json" }), ctx(w.sessionId))).status).toBe(400);
    expect((await retake(999999, { topicId: w.topicId })).status).toBe(404);
    currentUserId = 0;
    expect((await retake(w.sessionId, { topicId: w.topicId })).status).toBe(401);
    expect(quizAnswers(w.userId, w.topicId)).toEqual({ 0: 1 }); // nothing above cleared it
  });

  it("retake clears only her own rows for that topic, then the same questions can be answered again", async () => {
    const w = world(2);
    storeQuiz(w.topicId, 4);
    const t2 = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 1, 'T2', 's', '[]')").run(w.examId).lastInsertRowid);
    const other = makeUser();
    currentUserId = w.userId;
    await check(w.sessionId, { topicId: w.topicId, index: 0, chosen: 1 });
    recordQuizAnswer(w.userId, t2, 0, 0, true);
    recordQuizAnswer(other, w.topicId, 0, 2, false);
    const res = await retake(w.sessionId, { topicId: w.topicId });
    expect(await res.json()).toEqual({ ok: true, cleared: 1 });
    expect(quizAnswers(w.userId, w.topicId)).toEqual({});
    expect(quizAnswers(w.userId, t2)).toEqual({ 0: 0 });
    expect(quizAnswers(other, w.topicId)).toEqual({ 0: 2 });
    expect((await getQuiz(w.sessionId)).answered).toEqual({});
    // answer again: accepted (200, correct computed), progress back, no duplicate session_checks row in the same session
    expect(await (await check(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 })).json()).toEqual({ ok: true, correct: true });
    expect(quizAnswers(w.userId, w.topicId)).toEqual({ 0: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM session_checks WHERE session_id = ?").get(w.sessionId)).toEqual({ n: 1 });
    // retake twice in a row is fine
    expect((await retake(w.sessionId, { topicId: w.topicId })).status).toBe(200);
    expect(await (await retake(w.sessionId, { topicId: w.topicId })).json()).toEqual({ ok: true, cleared: 0 });
  });

  it("resetSectionQuiz clears everyone's rows and detaches session_checks; deleting the topic or the user cascades", () => {
    const w = world(2);
    storeQuiz(w.topicId, 4);
    const other = makeUser();
    recordQuizAnswer(w.userId, w.topicId, 0, 1, false);
    recordQuizAnswer(other, w.topicId, 0, 1, false);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'q', 0, 0, 1)").run(w.sessionId, w.topicId);
    resetSectionQuiz(w.topicId);
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id = ?").get(w.topicId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT check_index FROM session_checks WHERE topic_id = ?").get(w.topicId)).toEqual({ check_index: null });
    expect(w.topic().checks_json).toBeNull();
    recordQuizAnswer(w.userId, w.topicId, 1, 1, false);
    recordQuizAnswer(other, w.topicId, 1, 1, false);
    db.prepare("DELETE FROM users WHERE id = ?").run(other);
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE user_id = ?").get(other)).toEqual({ n: 0 });
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicId);
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id = ?").get(w.topicId)).toEqual({ n: 0 });
    expect(clearQuizAnswers(w.userId, w.topicId)).toBe(0);
  });

  it("recordQuizAnswer: first wins, returns false the second time", () => {
    const w = world(1);
    expect(recordQuizAnswer(w.userId, w.topicId, 0, 2, false)).toBe(true);
    expect(recordQuizAnswer(w.userId, w.topicId, 0, 0, true)).toBe(false);
    expect(quizAnswers(w.userId, w.topicId)).toEqual({ 0: 2 });
  });
});

describe("C: migrateSessionChecks", () => {
  const reset = () => {
    db.prepare("DELETE FROM meta WHERE key = 'quiz_answers_migrated'").run();
    db.prepare("DELETE FROM quiz_answers").run();
    db.prepare("DELETE FROM session_checks").run();
  };
  const sc = (session: number, topic: number, idx: number | null, chosen: number | null, at: string) =>
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen, created_at) VALUES (?, ?, 'q', 0, ?, ?, ?)").run(session, topic, idx, chosen, at);

  it("copies the latest answer per student/question, skips NULL index/chosen and ownerless exams, sets the flag, is idempotent", () => {
    reset();
    const w = world(2);
    const s2 = newSession(w.examId);
    sc(w.sessionId, w.topicId, 0, 1, "2026-01-01 10:00:00");
    sc(s2, w.topicId, 0, 2, "2026-01-02 10:00:00"); // later wins
    sc(s2, w.topicId, 1, 3, "2026-01-02 10:00:00");
    sc(w.sessionId, w.topicId, 1, 0, "2026-01-02 10:00:00"); // same time, higher id? (inserted later → id higher) — wait: inserted after, so higher id wins
    sc(w.sessionId, w.topicId, null, 1, "2026-01-01 10:00:00"); // detached
    sc(w.sessionId, w.topicId, 5, null, "2026-01-01 10:00:00"); // no chosen
    const ownerless = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (NULL, 'x')").run().lastInsertRowid);
    const ot = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 't', 's', '[]')").run(ownerless).lastInsertRowid);
    const os = newSession(ownerless);
    sc(os, ot, 0, 1, "2026-01-01 10:00:00");
    expect(migrateSessionChecks()).toBe(4); // rows written (two answers per question were replaced by later ones), not distinct answers
    expect(quizAnswers(w.userId, w.topicId)).toEqual({ 0: 2, 1: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id = ?").get(ot)).toEqual({ n: 0 });
    expect(getMeta("quiz_answers_migrated")).toBe("1");
    // student answers more afterwards, then the job runs again: nothing is overwritten
    db.prepare("UPDATE quiz_answers SET chosen = 3 WHERE topic_id = ? AND check_index = 0").run(w.topicId);
    expect(migrateSessionChecks()).toBe(0);
    expect(quizAnswers(w.userId, w.topicId)[0]).toBe(3);
  });

  it("sets the flag even when there is nothing to copy", () => {
    reset();
    db.prepare("DELETE FROM session_checks").run();
    expect(migrateSessionChecks()).toBe(0);
    expect(getMeta("quiz_answers_migrated")).toBe("1");
  });

  it("two students on a class copy keep separate rows; the same student's two sessions merge", () => {
    reset();
    const a = world(1);
    const b = world(1);
    sc(a.sessionId, a.topicId, 0, 1, "2026-02-01 00:00:00");
    sc(b.sessionId, b.topicId, 0, 2, "2026-02-01 00:00:00");
    migrateSessionChecks();
    expect(quizAnswers(a.userId, a.topicId)).toEqual({ 0: 1 });
    expect(quizAnswers(b.userId, b.topicId)).toEqual({ 0: 2 });
    expect(quizAnswers(a.userId, b.topicId)).toEqual({});
  });

  it("tie on created_at: the later row (higher id) wins", () => {
    reset();
    const w = world(1);
    sc(w.sessionId, w.topicId, 0, 1, "2026-03-01 00:00:00");
    sc(w.sessionId, w.topicId, 0, 3, "2026-03-01 00:00:00");
    migrateSessionChecks();
    expect(quizAnswers(w.userId, w.topicId)).toEqual({ 0: 3 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C — Continue card / Home in-progress line (real code extracted from the pages and transpiled)
// ---------------------------------------------------------------------------------------------------------------
describe("C: Continue card logic", () => {
  const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", f), "utf8").split("\r\n").join("\n");
  const extract = (src: string, startMarker: string) => {
    const i = src.indexOf(startMarker);
    if (i < 0) throw new Error("marker not found: " + startMarker);
    const end = src.indexOf("\n}\n", i) + 3;
    return src.slice(i, end);
  };
  const compile = (code: string, name: string, deps: Record<string, unknown> = {}) =>
    new Function(...Object.keys(deps), stripTypeScriptTypes(code) + `
return ${name};`)(...Object.values(deps));

  const home = read("src/app/page.tsx");
  // timeIsUp / sinceText now live in lib/format.ts (shared by the exam page and Home); the Home query is still extracted.
  const fmt = read("src/lib/format.ts");
  const timeIsUp = compile(extract(fmt, "export function timeIsUp").replace(/^export /, ""), "timeIsUp") as (a: { started_at: string; time_limit_sec: number | null }) => boolean;
  const sinceText = compile(extract(fmt, "export function sinceText").replace(/^export /, ""), "sinceText") as (s: string) => string;
  const openAttemptsByExam = compile(extract(home, "function openAttemptsByExam"), "openAttemptsByExam", { db, timeIsUp }) as (
    ids: number[],
  ) => Map<number, { id: number; answered: number; n: number; expired: boolean }>;
  // The exam page's own open-attempt query, copied verbatim (it is inline in the server component): no LIMIT, newest open one.
  const openOf = (id: number) =>
    db
      .prepare(
        `SELECT a.id, a.mode, a.started_at, a.time_limit_sec, COUNT(aq.question_id) n, COALESCE(SUM(aq.chosen_index IS NOT NULL), 0) answered
       FROM attempts a JOIN attempt_questions aq ON aq.attempt_id = a.id
       WHERE a.exam_id = ? AND a.status = 'ready' GROUP BY a.id HAVING answered < n ORDER BY a.id DESC LIMIT 1`,
      )
      .get(id) as { id: number; mode: string; started_at: string; time_limit_sec: number | null; n: number; answered: number } | undefined;

  function attempt(examId: number, o: { status?: string; n?: number; answered?: number; mode?: string; started?: string; limit?: number | null } = {}) {
    const id = Number(
      db
        .prepare("INSERT INTO attempts (exam_id, mode, status, time_limit_sec, started_at) VALUES (?, ?, ?, ?, ?)")
        .run(examId, o.mode ?? "tutor", o.status ?? "ready", o.limit ?? null, o.started ?? "2026-10-25 12:00:00").lastInsertRowid,
    );
    const n = o.n ?? 4;
    for (let i = 0; i < n; i++) {
      const q = Number(db.prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e')").run(examId).lastInsertRowid);
      db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index) VALUES (?, ?, ?, ?)").run(id, q, i, i < (o.answered ?? 0) ? 0 : null);
    }
    return id;
  }

  it("generating / error / finished attempts, n=0 attempts and fully answered ones never count", () => {
    const w = world(1);
    attempt(w.examId, { status: "generating", n: 0 });
    attempt(w.examId, { status: "error", n: 3 });
    attempt(w.examId, { status: "finished", n: 3, answered: 1 });
    attempt(w.examId, { status: "ready", n: 0 });
    attempt(w.examId, { status: "ready", n: 3, answered: 3 });
    expect(openOf(w.examId)).toBeUndefined();
    expect(openAttemptsByExam([w.examId]).size).toBe(0);
    expect(openAttemptsByExam([]).size).toBe(0);
  });

  it("the newest open one wins, per exam, on both pages; counts are right", () => {
    const w = world(1);
    const w2 = world(1);
    attempt(w.examId, { n: 5, answered: 1 });
    const newest = attempt(w.examId, { n: 6, answered: 2 });
    attempt(w.examId, { status: "finished", n: 9, answered: 9 }); // newer but finished
    const other = attempt(w2.examId, { n: 3, answered: 0 });
    expect(openOf(w.examId)).toMatchObject({ id: newest, n: 6, answered: 2 });
    const m = openAttemptsByExam([w.examId, w2.examId]);
    expect(m.get(w.examId)).toEqual({ id: newest, n: 6, answered: 2, expired: false });
    expect(m.get(w2.examId)).toEqual({ id: other, n: 3, answered: 0, expired: false });
  });

  it("BUG(low): an open attempt older than the 8 newest attempts disappears from the exam page but not from Home", () => {
    const w = world(1);
    const old = attempt(w.examId, { n: 4, answered: 1 });
    for (let i = 0; i < 8; i++) attempt(w.examId, { status: "finished", n: 2, answered: 2 });
    expect(openAttemptsByExam([w.examId]).get(w.examId)?.id).toBe(old);
    expect(openOf(w.examId)?.id).toBe(old);
  });

  it("timed expiry: not up at the exact deadline, up one ms later; null/0 limit never expires; UTC parsing", () => {
    vi.useFakeTimers();
    const a = { started_at: "2026-10-25 12:00:00", time_limit_sec: 600 };
    vi.setSystemTime(new Date("2026-10-25T12:10:00.000Z"));
    expect(timeIsUp(a)).toBe(false);
    vi.setSystemTime(new Date("2026-10-25T12:10:00.001Z"));
    expect(timeIsUp(a)).toBe(true);
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(timeIsUp({ ...a, time_limit_sec: null })).toBe(false);
    expect(timeIsUp({ ...a, time_limit_sec: 0 })).toBe(false);
    // local-time parsing bug check: 11:59 UTC is before the 12:00 start → not up regardless of the machine's zone
    vi.setSystemTime(new Date("2026-10-25T12:09:59.000Z"));
    expect(timeIsUp(a)).toBe(false);
  });

  it("sinceText buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const at = (ms: number) => new Date(Date.parse("2026-10-25T12:00:00Z") - ms).toISOString().slice(0, 19).replace("T", " ");
    const H = 3600000;
    expect(sinceText(at(0))).toBe("just now");
    expect(sinceText(at(59 * 60000))).toBe("just now");
    expect(sinceText(at(H))).toBe("1 hour ago");
    expect(sinceText(at(2 * H))).toBe("2 hours ago");
    expect(sinceText(at(23 * H + 59 * 60000))).toBe("23 hours ago");
    expect(sinceText(at(24 * H))).toBe("yesterday");
    expect(sinceText(at(47 * H))).toBe("yesterday");
    expect(sinceText(at(48 * H))).toBe("2 days ago");
    expect(sinceText(at(-5 * H))).toBe("just now"); // clock skew: started in the future
  });

});

// ---------------------------------------------------------------------------------------------------------------
// D — option notes
// ---------------------------------------------------------------------------------------------------------------
describe("D: option notes", () => {
  it("optionNotesJson: rejects non-arrays, wrong length, blanks, non-strings; trims; reorders with the shuffle", () => {
    const opts = ["a", "b", "c", "d"];
    const id = [0, 1, 2, 3];
    for (const bad of [null, undefined, "x", {}, 4, ["1", "2", "3"], ["1", "2", "3", "4", "5"], ["1", "", "3", "4"], ["1", "  ", "3", "4"], ["1", 2, "3", "4"], ["1", null, "3", "4"]]) {
      expect(optionNotesJson(opts, bad, id), JSON.stringify(bad)).toBeNull();
    }
    expect(optionNotesJson(opts, [" n0 ", "n1", "n2", "n3\n"], id)).toBe(JSON.stringify(["n0", "n1", "n2", "n3"]));
    // order [2,0,3,1]: displayed option k is original order[k]; its note must follow it
    expect(optionNotesJson(opts, ["n0", "n1", "n2", "n3"], [2, 0, 3, 1])).toBe(JSON.stringify(["n2", "n0", "n3", "n1"]));
  });

  it("attemptView.optionNotes: null / malformed / wrong-length / non-string → null; retry order reorders", () => {
    const id = [0, 1, 2];
    expect(optionNotes(null, id)).toBeNull();
    expect(optionNotes(undefined, id)).toBeNull();
    expect(optionNotes("", id)).toBeNull();
    expect(optionNotes("{not json", id)).toBeNull();
    expect(optionNotes('"str"', id)).toBeNull();
    expect(optionNotes('{"a":1}', id)).toBeNull();
    expect(optionNotes('["a","b"]', id)).toBeNull();
    expect(optionNotes('["a","b",3]', id)).toBeNull();
    expect(optionNotes('["a","b","c"]', id)).toEqual(["a", "b", "c"]);
    expect(optionNotes('["a","b","c"]', [2, 0, 1])).toEqual(["c", "a", "b"]);
    expect(optionNotes('["a","b","c"]', [0, 1])).toBeNull(); // order shorter than notes
  });

  it("a retry question: notes shown in the same shuffled order as its options, and the note of the correct option follows it", async () => {
    const { attemptView } = await import("@/lib/attemptView");
    const w = world(1);
    const q = Number(
      db
        .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, option_notes) VALUES (?, ?, 'recall', 's', ?, 1, 'e', ?)")
        .run(w.examId, w.topicId, JSON.stringify(["wrong0", "RIGHT", "wrong2", "wrong3"]), JSON.stringify(["n0", "nRIGHT", "n2", "n3"])).lastInsertRowid,
    );
    const a = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(w.examId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct, option_order) VALUES (?, ?, 0, 0, 0, ?)").run(a, q, JSON.stringify([3, 1, 0, 2]));
    const v = attemptView(a)!.questions[0] as { options: string[]; correct_index: number; option_notes: string[] | null };
    expect(v.options).toEqual(["wrong3", "RIGHT", "wrong0", "wrong2"]);
    expect(v.option_notes).toEqual(["n3", "nRIGHT", "n0", "n2"]);
    expect(v.option_notes![v.correct_index]).toBe("nRIGHT");
  });

  it("notes are not revealed before the answer in tutor mode / while the exam is live", async () => {
    const { attemptView } = await import("@/lib/attemptView");
    const w = world(1);
    const q = Number(
      db.prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation, option_notes) VALUES (?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e', '[\"x\",\"y\"]')").run(w.examId).lastInsertRowid,
    );
    for (const mode of ["tutor", "timed"]) {
      const a = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, ?, 'ready')").run(w.examId, mode).lastInsertRowid);
      db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 0)").run(a, q);
      expect(JSON.stringify(attemptView(a)!.questions[0])).not.toMatch(/option_notes|"x"|"y"/);
      db.prepare("UPDATE attempt_questions SET chosen_index = 1 WHERE attempt_id = ?").run(a);
      const shown = JSON.stringify(attemptView(a)!.questions[0]);
      expect(shown.includes("option_notes"), mode).toBe(mode === "tutor"); // timed: only after finish
    }
  });

  it("the daily-review route returns notes for a question that has them and null for one that does not", async () => {
    const w = world(1);
    currentUserId = w.userId;
    const mk = (notes: string | null) => {
      const q = Number(db.prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation, option_notes) VALUES (?, 'recall', ?, '[\"a\",\"b\"]', 0, 'e', ?)").run(w.examId, `S${Math.random()}`, notes).lastInsertRowid);
      db.prepare("INSERT INTO review_cards (question_id, card_json, due) VALUES (?, '{}', '2000-01-01T00:00:00.000Z')").run(q);
      return q;
    };
    const withNotes = mk('["why a","why b"]');
    const without = mk(null);
    const bad = mk("{oops");
    // dueCards needs valid card_json for nextReviewDates; build real ones through the scheduler
    const { createEmptyCard } = await import("ts-fsrs");
    for (const q of [withNotes, without, bad]) db.prepare("UPDATE review_cards SET card_json = ? WHERE question_id = ?").run(JSON.stringify(createEmptyCard(new Date("2000-01-01"))), q);
    const res = await reviewGET(new Request("http://x/api/review?limit=50"));
    const body = (await res.json()) as { cards: { id: number; option_notes: string[] | null }[] };
    const by = new Map(body.cards.map((c) => [c.id, c.option_notes]));
    expect(by.get(withNotes)).toEqual(["why a", "why b"]);
    expect(by.get(without)).toBeNull();
    expect(by.get(bad)).toBeNull();
  });

  it("BUG: copying a shared exam into a classmate's account drops questions.option_notes (classes.ts copyExam INSERT omits it)", () => {
    const a = makeUser();
    const b = makeUser();
    const w = world(1, undefined, { userId: a });
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, option_notes) VALUES (?, ?, 'recall', 'stem', '[\"a\",\"b\"]', 0, 'e', '[\"why a\",\"why b\"]')").run(w.examId, w.topicId);
    const cls = createClass(a, "C");
    joinClass(b, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(cls) as { invite_code: string }).invite_code);
    expect(shareExam(a, cls, w.examId)).toBeNull();
    const res = addSharedExam(b, (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(w.examId) as { id: number }).id) as { examId: number };
    expect(db.prepare("SELECT option_notes FROM questions WHERE exam_id = ?").get(res.examId)).toEqual({ option_notes: '["why a","why b"]' });
  });

  it("copying a shared exam carries a v3 quiz's option_notes and a v3 lesson's version", () => {
    const a = makeUser();
    const b = makeUser();
    const w = world(1, undefined, { userId: a });
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    storeQuiz(w.topicId, 2);
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify({ intro: "x", key_points: [], slides: [{ page_id: w.pages[0], explanation: "e" }], connections: null, version: LESSON_VERSION }), w.topicId);
    const cls = createClass(a, "C2");
    joinClass(b, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(cls) as { invite_code: string }).invite_code);
    shareExam(a, cls, w.examId);
    const res = addSharedExam(b, (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ? AND class_id = ?").get(w.examId, cls) as { id: number }).id) as { examId: number };
    const t = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(res.examId) as Topic;
    expect(t.checks_version).toBe(QUIZ_VERSION);
    expect((JSON.parse(t.checks_json!) as QuizQuestion[])[0].option_notes).toEqual(["na", "nb", "nc", "nd"]);
    expect(lessonIsCurrent(t)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// E — lessons
// ---------------------------------------------------------------------------------------------------------------
describe("E: lessonCoverage", () => {
  it("empty facts: ratio 1", () => {
    expect(coveredFacts("anything", [])).toEqual({ covered: [], missing: [], ratio: 1 });
    expect(coveredFacts("", [])).toEqual({ covered: [], missing: [], ratio: 1 });
  });
  it("a fact with only stopwords / short words counts as covered", () => {
    expect(coveredFacts("x", ["the and of to", "it is an"]).ratio).toBe(1);
    expect(keyWords("the and of")).toEqual([]);
  });
  it("numbers are significant, even short ones", () => {
    expect(keyWords("2 mm of 15-30 degrees")).toEqual(expect.arrayContaining(["2", "15-30", "degrees"]));
    expect(coveredFacts("remove pulp", ["Remove 2 mm of pulp"]).covered).toHaveLength(1); // 2 of 3 words
    expect(coveredFacts("clean", ["42"]).missing).toEqual(["42"]);
    expect(coveredFacts("it is 42 here", ["42"]).covered).toEqual(["42"]);
  });
  it("loose stems: pulpal/pulp, extraction/extract, either direction", () => {
    expect(coveredFacts("the pulpal tissue", ["pulp tissue"]).ratio).toBe(1);
    expect(coveredFacts("the pulp tissue", ["pulpal tissue"]).ratio).toBe(1);
    expect(coveredFacts("extractions happen", ["extraction"]).ratio).toBe(1);
  });
  it("BUG(low): plural of a word ending -e or -al is not matched to its singular (canal/canals, fracture/fractures), so a covered fact looks missing and can cost a needless repair call", () => {
    expect(coveredFacts("two canals", ["canal"]).ratio).toBe(1);
    expect(coveredFacts("several fractures", ["fracture"]).ratio).toBe(1);
    expect(coveredFacts("the nerves", ["nerve"]).ratio).toBe(1);
  });
  it("60% threshold: 3 of 5 words covers, 2 of 5 does not", () => {
    expect(coveredFacts("alpha bravo charlie", ["alpha bravo charlie delta echo"]).ratio).toBe(1);
    expect(coveredFacts("alpha bravo", ["alpha bravo charlie delta echo"]).ratio).toBe(0);
  });
  it("case-insensitive, unicode and non-Latin text do not crash and match", () => {
    expect(coveredFacts("DENTINOGÉNESIS imperfecta", ["Dentinogénesis imperfecta"]).ratio).toBe(1);
    expect(coveredFacts("العصب السني", ["العصب السني"]).ratio).toBe(1);
    expect(coveredFacts("日本語のテキスト", ["日本語のテキスト"]).ratio).toBe(1);
  });

});

describe("E: lessons", () => {
  /** A lesson in the writer's shape: `text` as the explanation of every one of the world's slides (so none is left out). */
  const goodLesson = (w: { pages: number[] }, text = "lesson text", extra: object = {}) => ({
    intro: "",
    slides: w.pages.map((page_id) => ({ page_id, explanation: text })),
    key_points: ["k"],
    connections: null,
    ...extra,
  });

  it("lessonIsCurrent: null / malformed / unversioned / v1 / v2 / v3 / v4", () => {
    const t = (j: string | null) => lessonIsCurrent({ lesson_json: j });
    expect(t(null)).toBe(false);
    expect(t("")).toBe(false);
    expect(t("{bad")).toBe(false);
    expect(t("null")).toBe(false);
    expect(t("[]")).toBe(false);
    expect(t("{}")).toBe(false);
    expect(t('{"version":1}')).toBe(false);
    expect(t('{"version":null}')).toBe(false);
    expect(t('{"version":2}')).toBe(false);
    expect(t('{"version":3}')).toBe(true);
    expect(t('{"version":4}')).toBe(true);
    expect(LESSON_VERSION).toBe(3);
  });

  it("an older stored lesson (one continuous text, v2) is rewritten once; the stored lesson has version 3; a second open costs nothing", async () => {
    const w = world(2);
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify({ explanation: "OLD", key_points: [], slides: [], connections: null, version: 2 }), w.topicId);
    lessonWriter = () => goodLesson(w, "NEW fact a0 fact b0 fact a1 fact b1");
    const l = await getLesson(w.topic());
    expect(lessonText(l)).toMatch(/NEW/);
    expect(l.slides.map((x) => x.page_id)).toEqual(w.pages);
    expect(JSON.parse(w.topic().lesson_json!).version).toBe(3);
    expect(lessonCalls).toBe(1);
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
  });

  it("the repair call fires only below 80% and only when facts exist", async () => {
    // 10 facts: unique single words so coverage is easy to steer
    const facts = Array.from({ length: 10 }, (_, i) => `zebra${i}word`);
    const w = world(1, () => facts);
    lessonWriter = () => goodLesson(w, facts.slice(0, 8).join(" ")); // exactly 80%
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
    expect(calls.filter((c) => c.purpose === "lesson repair")).toHaveLength(0);

    const w2 = world(1, () => facts);
    lessonCalls = 0;
    lessonWriter = (n) => goodLesson(w2, facts.slice(0, n === 1 ? 7 : 10).join(" ")); // 70% → repair → 100%
    const l = await getLesson(w2.topic());
    expect(lessonCalls).toBe(2);
    expect(lessonText(l)).toContain("zebra9word");
    const rep = calls.find((c) => c.purpose === "lesson repair")!;
    expect(rep.content).toMatch(/- zebra7word/);
    expect(rep.content).toMatch(/- zebra9word/);
    expect(rep.content.slice(rep.content.indexOf("Your previous lesson"))).not.toMatch(/- zebra0word/);
    expect(rep.tier).toBeUndefined(); // standard tier

    // no facts at all: never a repair
    const w3 = world(2, () => []);
    lessonCalls = 0;
    lessonWriter = () => goodLesson(w3, "nothing relevant");
    await getLesson(w3.topic());
    expect(lessonCalls).toBe(1);
  });

  it("a repair that lowers coverage is discarded; equal coverage is accepted; a throwing repair keeps the first lesson", async () => {
    const facts = Array.from({ length: 10 }, (_, i) => `quokka${i}word`);
    const w = world(1, () => facts);
    lessonWriter = (n) => goodLesson(w, n === 1 ? "FIRST " + facts.slice(0, 5).join(" ") : "SECOND " + facts.slice(0, 3).join(" "));
    expect(lessonText(await getLesson(w.topic()))).toMatch(/^FIRST/);

    const w2 = world(1, () => facts);
    lessonWriter = (n) => goodLesson(w2, (n === 1 ? "FIRST " : "SECOND ") + facts.slice(0, 5).join(" "));
    expect(lessonText(await getLesson(w2.topic()))).toMatch(/^SECOND/);

    const w3 = world(1, () => facts);
    lessonCalls = 0;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    lessonWriter = (n) => {
      if (n === 2) throw new Error("repair down");
      return goodLesson(w3, "FIRST " + facts.slice(0, 2).join(" "));
    };
    const l = await getLesson(w3.topic());
    err.mockRestore();
    expect(lessonText(l)).toMatch(/^FIRST/);
    expect(JSON.parse(w3.topic().lesson_json!).version).toBe(3);
  });

  it("a failing FIRST call stores nothing and leaves an old lesson in place", async () => {
    const w = world(1);
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify({ explanation: "OLD", key_points: [], slides: [], connections: null, version: 2 }), w.topicId);
    lessonWriter = () => {
      throw new Error("down");
    };
    await expect(getLesson(w.topic())).rejects.toThrow();
    expect(JSON.parse(w.topic().lesson_json!).explanation).toBe("OLD");
  });

  it("slides: only the topic's own slides, in slide order, one entry each (a slide given twice has its texts joined), no cap", async () => {
    const w = world(9, (i) => [`f${i}x`]);
    const foreign = world(1).pages[0];
    const given = [foreign, ...[...w.pages].reverse(), foreign, 999999, w.pages[0]];
    const sl = given.map((p, i) => ({ page_id: p, explanation: i === given.length - 1 ? "again f0x" : `f${w.pages.indexOf(p)}x text ${i}` }));
    lessonWriter = () => goodLesson(w, "", { slides: sl });
    const l = await getLesson(w.topic());
    expect(l.slides.map((s) => s.page_id)).toEqual(w.pages);
    expect(l.slides[0].explanation).toBe("f0x text 9\n\nagain f0x");
    expect(JSON.parse(w.topic().lesson_json!).slides).toHaveLength(9);
    expect(lessonCalls).toBe(1); // nothing missing, no repair
  });

  it("a slide with facts that got no entry triggers the one repair call, which names the slide; a slide without facts may be skipped", async () => {
    const w = world(3, (i) => (i === 1 ? [] : [`g${i}x`]));
    lessonWriter = (n) =>
      n === 1
        ? goodLesson(w, "", { slides: [{ page_id: w.pages[0], explanation: "g0x" }] }) // slide 3 (facts) left out, slide 2 (no facts) skipped
        : goodLesson(w, "", { slides: [{ page_id: w.pages[0], explanation: "g0x" }, { page_id: w.pages[2], explanation: "g2x" }] });
    const l = await getLesson(w.topic());
    expect(lessonCalls).toBe(2);
    const rep = calls.find((c) => c.purpose === "lesson repair")!;
    const asked = rep.content.slice(rep.content.indexOf("Your previous lesson"));
    expect(asked).toContain(`- [P${w.pages[2]}] L1.pdf slide 3`);
    expect(asked).not.toContain(`[P${w.pages[1]}]`); // the fact-less slide isn't demanded
    expect(l.slides.map((s) => s.page_id)).toEqual([w.pages[0], w.pages[2]]);
  });

  it("a repair that brings back fewer slides than the first lesson is discarded even if its fact coverage is equal", async () => {
    const w = world(2, (i) => [`h${i}x`]);
    lessonWriter = (n) =>
      n === 1
        ? goodLesson(w, "", { slides: [{ page_id: w.pages[0], explanation: "h0x h1x" }] }) // all facts, slide 2 missing → repair
        : goodLesson(w, "", { slides: [] }); // the repair drops everything
    const l = await getLesson(w.topic());
    expect(lessonCalls).toBe(2);
    expect(l.slides.map((s) => s.page_id)).toEqual([w.pages[0]]);
  });

  it("concurrent opens share one generation", async () => {
    const w = world(1);
    lessonWriter = () => goodLesson(w, "fact a0 fact b0");
    await Promise.all([getLesson(w.topic()), getLesson(w.topic()), getLesson(w.topic())]);
    expect(lessonCalls).toBe(1);
  });

  it("BUG(low): a fact repeated on two slides is listed twice in the repair prompt and counted twice in the coverage", async () => {
    const facts = ["unique fact one", "shared sentinel fact", "unique fact two", "unique fact three", "unique fact four"];
    const w = world(2, (i) => (i === 0 ? facts : ["shared sentinel fact"]));
    lessonWriter = (n) => goodLesson(w, n === 1 ? "nothing" : facts.join(" "));
    await getLesson(w.topic());
    const rep = calls.find((c) => c.purpose === "lesson repair")!;
    expect(rep.content.slice(rep.content.indexOf("Your previous lesson")).match(/- shared sentinel fact/g)).toHaveLength(1);
  });
});
