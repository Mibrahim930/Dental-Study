import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Verdict = { n: number; ok: boolean; reason: string };
const calls: { purpose: string; content: string; tier?: string }[] = [];
let judge: (questions: number) => Verdict[] = () => [];
let pageFor: (planned: number, slot: number) => number = (planned) => planned;
/** Per-option notes the writer returns for a slot (undefined = none), in the order of OPTIONS. */
let notesFor: (slot: number) => string[] | undefined = () => undefined;
const OPTIONS = ["right", "w1", "w2", "w3"];
let tryNo = 0;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string; tier?: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content, tier: opts.tier });
    if (opts.purpose === "section quiz") {
      tryNo++;
      const slots = [...opts.content.matchAll(/^Q(\d+): slides? P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          question: `Q${s.n} on P${s.page} (try ${tryNo})`,
          options: [...OPTIONS],
          correct_index: 0,
          correct_answer: "right",
          explanation: "because (L1, slide 1)",
          ...(notesFor(s.n) ? { option_notes: notesFor(s.n) } : {}),
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
import { getSectionQuiz, quizIsCurrent, QUIZ_VERSION, type QuizQuestion } from "@/lib/study";
import { quizSize } from "@/lib/quizPlan";
import { removeDocument } from "@/lib/processing";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as reportPOST } from "@/app/api/sessions/[id]/quiz/report/route";
import { makeUser } from "./helpers";

/** Two facts of its own per slide by default, so every slide has something distinct to test. */
const factsOf = (i: number) => [`fact a${i}`, `fact b${i}`];
const notes = (i: number, emphasized = false, facts = factsOf(i)) =>
  JSON.stringify({
    title: `slide ${i}`,
    summary: "s",
    image_description: null,
    key_facts: facts,
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
function world(n: number, o: { starred?: number[]; split?: number; facts?: (i: number) => string[] } = {}) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc1 = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const doc2 = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L2.pdf', 'done')").run(examId).lastInsertRowid);
  const facts = o.facts ?? factsOf;
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized) VALUES (?, ?, '', 'done', ?, ?)")
        .run(o.split != null && i >= o.split ? doc2 : doc1, i + 1, notes(i, o.starred?.includes(i), facts(i)), o.starred?.includes(i) ? 1 : 0).lastInsertRowid,
    ),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  /** The quiz size the planner gives this topic: one per distinct fact, no floor, no cap. */
  const size = quizSize(Array.from({ length: n }, (_, i) => ({ facts: facts(i) })));
  return { userId, examId, pages, topicId, sessionId, topic, doc1, doc2, size };
}
const count = (purpose: string) => calls.filter((c) => c.purpose === purpose).length;
/** A stored three-question quiz stamped with an older version (null = before versions existed). */
const storeOldQuiz = (topicId: number, version: number | null) =>
  db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(
    JSON.stringify(
      [0, 1, 2].map((i) => ({ id: `old${i}`, question: `Old ${i}?`, options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", option_notes: ["r", "w", "w", "w"], kind: "recall" })),
    ),
    version,
    topicId,
  );
const writes = () => calls.filter((c) => c.purpose === "section quiz");
const slotCount = (content: string) => [...content.matchAll(/^Q\d+:/gm)].length;
const factsIn = (content: string) => [...content.matchAll(/^Q\d+: .* — fact: "(.*)" — /gm)].map((m) => m[1]);
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  calls.length = 0;
  judge = () => [];
  pageFor = (planned) => planned;
  notesFor = () => undefined;
  tryNo = 0;
});
afterEach(() => {
  delete process.env.QUIZ_JUDGE;
});

describe("coverage-first section quiz (one question per distinct fact)", () => {
  it("12 slides × 2 facts: 24 questions in two halves, every slide tested and tagged with its slide, quality tier", async () => {
    const w = world(12);
    expect(w.size).toBe(24);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(w.size);
    expect(count("section quiz")).toBe(2);
    const sizes = writes().map((c) => slotCount(c.content));
    expect(sizes).toEqual([12, 12]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(w.size);
    expect(writes().every((c) => c.tier === "quality")).toBe(true);
    const tested = new Set(qs.map((q) => q.source_page_id));
    for (const p of w.pages) expect(tested.has(p), `slide ${p}`).toBe(true);
    expect(qs.every((q) => q.kind)).toBe(true);
    expect(w.topic().checks_version).toBe(QUIZ_VERSION);
    expect(QUIZ_VERSION).toBe(5);
  });

  it("a version-3 quiz is kept when its section has 5-25 facts (written the same way), rewritten once when it was padded (<5) or cut (>25)", async () => {
    for (const [n, kept] of [
      [2, false], // 4 facts: padded to 5 → repeats → rewrite
      [3, true], // 6 facts
      [12, true], // 24 facts
      [13, false], // 26 facts: cut at 25 → rewrite
    ] as const) {
      const w = world(n);
      storeOldQuiz(w.topicId, 3);
      expect(quizIsCurrent(w.topic()), `${n} slides`).toBe(kept);
      calls.length = 0;
      const qs = await getSectionQuiz(w.topic());
      expect(count("section quiz") > 0, `${n} slides`).toBe(!kept);
      expect(qs.length).toBe(kept ? 3 : w.size);
      expect(w.topic().checks_version).toBe(kept ? 3 : QUIZ_VERSION);
    }
    // version 2 and unversioned quizzes are always rewritten, whatever the fact count
    const w = world(5);
    storeOldQuiz(w.topicId, 2);
    expect(quizIsCurrent(w.topic())).toBe(false);
    storeOldQuiz(w.topicId, null);
    expect(quizIsCurrent(w.topic())).toBe(false);
  });

  it("an odd size splits into halves that differ by one", async () => {
    const w = world(4, { facts: (i) => (i === 0 ? ["x0", "x1", "x2"] : [`f${i}`, `g${i}`]) });
    expect(w.size).toBe(9);
    expect(await getSectionQuiz(w.topic())).toHaveLength(9);
    expect(writes().map((c) => slotCount(c.content))).toEqual([5, 4]);
  });

  it("6 slides: one question per fact (2 per slide), each fact pinned in the prompt once, no duplicate questions", async () => {
    const w = world(6, { starred: [1, 4] });
    expect(w.size).toBe(12);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(12);
    for (const p of w.pages) expect(qs.filter((q) => q.source_page_id === p), `slide ${p}`).toHaveLength(2);
    expect(new Set(qs.map((q) => q.question)).size).toBe(12);
    const facts = writes().flatMap((c) => factsIn(c.content));
    expect(facts.sort()).toEqual(Array.from({ length: 6 }, (_, i) => factsOf(i)).flat().sort());
  });

  it("slides that repeat a fact: the prompt never names the same fact twice, and the size counts it once", async () => {
    // Slide i lists f_i and f_{i+1}, so neighbours share a fact: 8 slides → 9 distinct facts.
    const w = world(8, { facts: (i) => [`shared fact ${i}`, `Shared fact ${i + 1}!`] });
    expect(w.size).toBe(9);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(9);
    const facts = writes().flatMap((c) => factsIn(c.content));
    expect(facts).toHaveLength(9);
    const norm = (f: string) => f.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    expect(new Set(facts.map(norm)).size).toBe(facts.length);
  });

  it("25 slides × 2 facts: condensed to 25 questions that still name all 50 facts (two per question), the starred slide's included", async () => {
    const w = world(25, { starred: [24] });
    expect(w.size).toBe(25);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(25);
    expect(qs.filter((q) => q.source_page_id === w.pages[24])).toHaveLength(1);
    const prompts = writes().map((c) => c.content).join("\n");
    for (let i = 0; i < 25; i++) for (const f of [`fact a${i}`, `fact b${i}`]) expect(prompts.match(new RegExp(`"${f}"`, "g"))).toHaveLength(1);
    expect(prompts).toMatch(/facts: "fact a24"; "fact b24" \(one question that needs all of them\)/);
  });

  it("one question per fact up to 25, then condensed: 2 × slides here, capped at 25", async () => {
    for (const n of [1, 2, 3, 13, 40]) {
      const w = world(n);
      const qs = await getSectionQuiz(w.topic());
      expect(qs.length, `${n} slides`).toBe(Math.min(25, 2 * n));
    }
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
    expect(qs).toHaveLength(w.size);
    expect(slotCount(writes()[2].content)).toBe(w.size / 2);
    expect(qs.filter((q) => q.question.includes("try 3"))).toHaveLength(w.size / 2);
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
    expect(await getSectionQuiz(w.topic())).toHaveLength(w.size);
    err.mockRestore();
  });

  it("QUIZ_JUDGE=0 turns the check off", async () => {
    process.env.QUIZ_JUDGE = "0";
    const w = world(5);
    expect(await getSectionQuiz(w.topic())).toHaveLength(w.size);
    expect(count("section quiz check")).toBe(0);
  });

  it("a question citing a slide outside the topic is dropped and repaired", async () => {
    const w = world(12);
    pageFor = (planned, slot) => (tryNo <= 2 && slot === 3 ? 999999 : planned);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(w.size);
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

describe("per-option notes", () => {
  it("follow the options through the shuffle: the note for the correct option sits at the new correct_index", async () => {
    const w = world(6);
    notesFor = () => OPTIONS.map((o) => `why ${o}`);
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(w.size);
    for (const q of qs) {
      expect(q.option_notes).toHaveLength(4);
      expect(q.options[q.correct_index]).toBe("right");
      expect(q.option_notes![q.correct_index]).toBe("why right");
      q.options.forEach((o, k) => expect(q.option_notes![k]).toBe(`why ${o}`));
    }
    // Shuffles differ between questions, so at least one correct answer moved off position 0.
    expect(qs.some((q) => q.correct_index !== 0)).toBe(true);
  });

  it("a draft whose option_notes has the wrong length is kept, without notes", async () => {
    const w = world(3);
    notesFor = (slot) => (slot === 1 ? ["only", "three", "notes"] : slot === 2 ? ["a", "b", "c", "d", "e"] : OPTIONS.map((o) => ` why ${o} `));
    const qs = await getSectionQuiz(w.topic());
    expect(qs).toHaveLength(w.size);
    expect(qs[0].option_notes).toBeUndefined();
    expect("option_notes" in qs[0]).toBe(false);
    expect(qs[1].option_notes).toBeUndefined();
    expect(qs.slice(2).every((q) => q.option_notes?.[q.correct_index] === "why right")).toBe(true); // trimmed
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
    expect(w.qs).toHaveLength(w.size);
    expect((await report(w.sessionId, { topicId: w.topicId, questionId: w.qs[2].id, note: " key is wrong " })).status).toBe(200);
    const after = JSON.parse(w.topic().checks_json!) as QuizQuestion[];
    expect(after).toHaveLength(w.size);
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
  it("check_index becomes NULL (the row stays), the quiz and the student's progress on it are cleared", async () => {
    const w = world(4, { split: 2 });
    currentUserId = w.userId;
    await quizGET(new Request(`http://x/q?position=0`), ctx(w.sessionId));
    await checkPOST(new Request("http://x/c", json({ topicId: w.topicId, index: 1, chosen: 0 })), ctx(w.sessionId));
    expect(db.prepare("SELECT check_index FROM quiz_answers WHERE topic_id = ?").all(w.topicId)).toEqual([{ check_index: 1 }]);
    await removeDocument(w.doc2);
    expect(w.topic().checks_json).toBeNull();
    expect(w.topic().checks_version).toBeNull();
    expect(db.prepare("SELECT check_index FROM session_checks WHERE session_id = ?").all(w.sessionId)).toEqual([{ check_index: null }]);
    expect(db.prepare("SELECT * FROM quiz_answers WHERE topic_id = ?").all(w.topicId)).toEqual([]);
    const again = await (await quizGET(new Request(`http://x/q?position=0`), ctx(w.sessionId))).json();
    expect(again.answered).toEqual({});
  });
});
