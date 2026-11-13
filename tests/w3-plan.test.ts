// Wave 3, the exam planner (docs/EXAM-PLAN.md "The planner" and "Data"): planExam's rules on hand-made input first,
// then the database readers, buildExamPlan, examCoverage and the new schema columns.
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async () => {
    throw new Error("no AI in planner tests");
  }),
}));

import { db } from "@/lib/db";
import {
  answerHistory,
  buildExamPlan,
  examCoverage,
  factKey,
  planExam,
  planSections,
  slideKey,
  type ExamPlan,
  type FactHistory,
  type PlanInput,
  type PlanSlide,
  type ReturningQuestion,
} from "@/lib/examPlan";
import { RETRY_SHARE } from "@/lib/practicePlan";
import { apiReadyUser, slideNotes, world } from "./helpers";

const identity = <T,>(xs: readonly T[]) => [...xs];
const slide = (id: number, facts: string[] | number, o: Partial<PlanSlide> = {}): PlanSlide => ({
  id,
  facts: typeof facts === "number" ? Array.from({ length: facts }, (_, i) => `fact ${id} number ${i}`) : facts,
  starred: false,
  hasCase: false,
  hasPicture: false,
  ...o,
});
const plan = (o: Partial<PlanInput>) => planExam({ sections: [], size: 10, style: "recall", adaptive: true, history: new Map(), shuffle: identity, ...o });
const hist = (entries: Record<string, FactHistory["result"]>, at = 5) => new Map(Object.entries(entries).map(([f, result]) => [factKey(f), { result, at }]));
const rq = (questionId: number, topicId: number | null, o: Partial<ReturningQuestion> = {}): ReturningQuestion => ({
  questionId,
  topicId,
  pageId: null,
  factKey: null,
  type: "recall",
  ...o,
});
const keysOf = (p: ExamPlan) => p.slots.map((s) => s.key);
const facts = (p: ExamPlan) => p.slots.map((s) => s.fact);
const numbered = (p: ExamPlan) => expect(p.slots.map((s) => s.n)).toEqual(p.slots.map((_, i) => i + 1));
const noRepeat = (p: ExamPlan) => expect(new Set(p.slots.map((s) => `${s.key}|${s.kind}`)).size).toBe(p.slots.length);

describe("planExam: what goes in first", () => {
  const sections = [{ id: 1, slides: [slide(10, ["a", "b", "c"]), slide(11, ["d"], { starred: true }), slide(12, ["e"])] }];
  const history = new Map([...hist({ a: "wrong", b: "unsure" }), ...hist({ d: "right", e: "right" }, 3)]);

  it("missed > unsure > new > starred > rotation", () => {
    const p = plan({ sections, size: 5, history });
    expect(facts(p)).toEqual(["a", "b", "c", "d", "e"]);
    expect(p.slots.map((s) => s.why)).toEqual(["missed", "unsure", "new", "starred", "rotation"]);
    expect(facts(plan({ sections, size: 3, history }))).toEqual(["a", "b", "c"]);
    expect(p.slots.every((s) => s.state === "todo" && s.question_id === null && s.topic_id === 1)).toBe(true);
  });

  it("with focus on my weak spots off, missed and unsure rank with new (slide order), still ahead of starred and rotation", () => {
    const s = [{ id: 1, slides: [slide(10, ["n1", "n2"]), slide(11, ["m"]), slide(12, ["u"]), slide(13, ["r"], { starred: true })] }];
    const h = new Map([...hist({ m: "wrong", u: "unsure" }), ...hist({ r: "right" })]);
    expect(facts(plan({ sections: s, size: 2, history: h, adaptive: true }))).toEqual(["m", "u"]);
    expect(facts(plan({ sections: s, size: 2, history: h, adaptive: false }))).toEqual(["n1", "n2"]);
    const off = plan({ sections: s, size: 5, history: h, adaptive: false });
    expect(facts(off)).toEqual(["n1", "n2", "m", "u", "r"]);
    expect(off.slots.map((x) => x.why)).toEqual(["new", "new", "missed", "unsure", "starred"]);
  });

  it("rotation: least recently tested first", () => {
    const s = [{ id: 1, slides: [slide(10, ["x", "y", "z"])] }];
    const h = new Map([
      [factKey("x"), { result: "right" as const, at: 9 }],
      [factKey("y"), { result: "right" as const, at: 2 }],
      [factKey("z"), { result: "right" as const, at: 5 }],
    ]);
    expect(facts(plan({ sections: s, size: 3, history: h }))).toEqual(["y", "z", "x"]);
  });

  it("within a rank, facts are taken round-robin across sections", () => {
    const s = [
      { id: 1, slides: [slide(10, 6)] },
      { id: 2, slides: [slide(20, 2)] },
      { id: 3, slides: [slide(30, 1)] },
    ];
    const p = plan({ sections: s, size: 6 });
    expect(p.slots.map((x) => x.topic_id)).toEqual([1, 2, 3, 1, 2, 1]);
  });

  it("every section gets a slot when the size allows; when not, least recently practised first", () => {
    const s = [1, 2, 3, 4].map((id) => ({ id, slides: [slide(id * 10, 3)] }));
    const last = new Map([
      [1, 10],
      [2, 5],
      [4, 20],
    ]);
    // Section 1 has a missed fact, but sections come first.
    const h = hist({ "fact 10 number 0": "wrong" });
    expect(plan({ sections: s, size: 2, lastPracticed: last, history: h }).slots.map((x) => x.topic_id)).toEqual([3, 2]);
    expect(new Set(plan({ sections: s, size: 4, lastPracticed: last, history: h }).slots.map((x) => x.topic_id))).toEqual(new Set([1, 2, 3, 4]));
    // With room, the missed fact is the first extra slot.
    const p = plan({ sections: s, size: 5, lastPracticed: last, history: h });
    expect(p.slots[4].why).toBe("new");
    expect(p.slots.find((x) => x.why === "missed")?.topic_id).toBe(1);
  });
});

describe("planExam: facts, kinds and sizes", () => {
  it("a fact is in the plan once; past the facts a second question has another kind; never the same kind twice", () => {
    const s = [{ id: 1, slides: [slide(10, 3)] }];
    const three = plan({ sections: s, size: 3, style: "mixed" });
    expect(new Set(keysOf(three)).size).toBe(3);
    const six = plan({ sections: s, size: 6, style: "mixed" });
    expect(six.slots).toHaveLength(6);
    for (const k of new Set(keysOf(six))) expect(new Set(six.slots.filter((x) => x.key === k).map((x) => x.kind))).toEqual(new Set(["recall", "case"]));
    // No pictures: two kinds a fact at most, so ten asked gives six.
    expect(plan({ sections: s, size: 10, style: "mixed" }).slots).toHaveLength(6);
    // Recall only: one question a fact.
    expect(plan({ sections: s, size: 10, style: "recall" }).slots).toHaveLength(3);
    noRepeat(plan({ sections: s, size: 10, style: "mixed" }));
  });

  it("the same fact text on two slides (or sections) is one fact, the first slide wins", () => {
    const s = [
      { id: 1, slides: [slide(10, ["Enamel is hard"]), slide(11, ["enamel  is HARD."])] },
      { id: 2, slides: [slide(20, ["Enamel is hard!", "Dentin is softer"])] },
    ];
    const p = plan({ sections: s, size: 10 });
    expect(p.slots.map((x) => [x.page_id, x.fact])).toEqual([
      [10, "Enamel is hard"],
      [20, "Dentin is softer"],
    ]);
  });

  it("a slide with no facts listed gets a slide slot; a recap slide whose facts repeat earlier ones gets none", () => {
    const s = [{ id: 1, slides: [slide(10, ["a"]), slide(11, [], { hasPicture: true }), slide(12, ["a"]), slide(13, ["  ", "—"])] }];
    const p = plan({ sections: s, size: 10 });
    expect(p.slots.map((x) => [x.key, x.fact, x.page_id])).toEqual([
      [factKey("a"), "a", 10],
      [slideKey(11), null, 11],
      [slideKey(13), null, 13],
    ]);
  });

  it("kinds by style: recall, case (image where there is a picture), mixed about 60/25/15", () => {
    const slides = Array.from({ length: 20 }, (_, i) => slide(100 + i, 1, { hasPicture: i % 4 === 0, hasCase: i % 5 === 1 }));
    const s = [{ id: 1, slides }];
    expect(new Set(plan({ sections: s, size: 20, style: "recall" }).slots.map((x) => x.kind))).toEqual(new Set(["recall"]));
    const cs = plan({ sections: s, size: 20, style: "case" });
    for (const x of cs.slots) expect(x.kind).toBe(slides.find((sl) => sl.id === x.page_id)!.hasPicture ? "image" : "case");
    const mixed = plan({ sections: s, size: 20, style: "mixed" });
    const count = (k: string) => mixed.slots.filter((x) => x.kind === k).length;
    expect([count("recall"), count("case"), count("image")]).toEqual([12, 5, 3]);
    for (const x of mixed.slots.filter((y) => y.kind === "image")) expect(slides.find((sl) => sl.id === x.page_id)!.hasPicture).toBe(true);
    // Case kinds go to the case slides first (there are four).
    const caseSlides = new Set(slides.filter((sl) => sl.hasCase).map((sl) => sl.id));
    expect(mixed.slots.filter((x) => x.kind === "case" && caseSlides.has(x.page_id!))).toHaveLength(4);
  });

  it("an image kind with no picture to show becomes recall", () => {
    const s = [{ id: 1, slides: Array.from({ length: 20 }, (_, i) => slide(100 + i, 1)) }];
    const p = plan({ sections: s, size: 20, style: "mixed" });
    expect(p.slots.filter((x) => x.kind === "image")).toHaveLength(0);
    expect(p.slots.filter((x) => x.kind === "recall")).toHaveLength(15);
    expect(p.slots.filter((x) => x.kind === "case")).toHaveLength(5);
  });

  it("old questions without a fact_key lower their slide's priority (rule 6)", () => {
    const s = [{ id: 1, slides: [slide(10, ["p1", "p2"]), slide(11, ["q1", "q2"])] }];
    expect(facts(plan({ sections: s, size: 2, oldQuestions: new Map([[10, 1]]) }))).toEqual(["q1", "q2"]);
    const partly = plan({ sections: s, size: 4, oldQuestions: new Map([[10, 1]]) });
    expect(facts(partly)).toEqual(["q1", "q2", "p1", "p2"]);
    expect(partly.slots.every((x) => x.why === "new")).toBe(true);
    // As many old questions as facts: the slide counts as tested, longest ago.
    const full = plan({ sections: s, size: 4, oldQuestions: new Map([[10, 2]]) });
    expect(full.slots.map((x) => [x.fact, x.why])).toEqual([
      ["q1", "new"],
      ["q2", "new"],
      ["p1", "rotation"],
      ["p2", "rotation"],
    ]);
  });

  it("sizes 1, 5, 40, 100 and more than the material: numbered 1..n, no repeats", () => {
    const s = [1, 2, 3].map((id) => ({ id, slides: Array.from({ length: 5 }, (_, i) => slide(id * 100 + i, 2, { hasPicture: true, hasCase: i === 0 })) }));
    for (const size of [1, 5, 40, 100, 1000]) {
      const p = plan({ sections: s, size, style: "mixed" });
      expect(p.slots).toHaveLength(Math.min(size, 90)); // 30 facts x 3 kinds
      expect(p.requested).toBe(size);
      numbered(p);
      noRepeat(p);
      if (size >= 3) expect(new Set(p.slots.map((x) => x.topic_id))).toEqual(new Set([1, 2, 3]));
      if (size <= 30) expect(new Set(keysOf(p)).size).toBe(size);
    }
    expect(plan({ sections: s, size: 0 }).slots).toEqual([]);
    expect(plan({ sections: [], size: 5 }).slots).toEqual([]);
  });

  it("is deterministic with the identity shuffle; the default shuffle only reorders", () => {
    const s = [1, 2].map((id) => ({ id, slides: Array.from({ length: 4 }, (_, i) => slide(id * 100 + i, 3, { hasPicture: i === 1 })) }));
    const input = { sections: s, size: 17, style: "mixed" as const, history: hist({ "fact 100 number 1": "wrong" }) };
    expect(plan(input)).toEqual(plan(input));
    const shuffled = planExam({ adaptive: true, ...input });
    numbered(shuffled);
    const strip = (p: ExamPlan) => p.slots.map((x) => JSON.stringify({ ...x, n: 0 })).sort();
    expect(strip(shuffled)).toEqual(strip(plan(input)));
  });
});

describe("planExam: questions that come back", () => {
  const s = [1, 2, 3].map((id) => ({ id, slides: [slide(id * 10, 6)] }));

  it("retries take slots first, as they are, covering their fact; capped at RETRY_SHARE", () => {
    const retries = Array.from({ length: 10 }, (_, i) => rq(500 + i, 1, { factKey: factKey(`fact 10 number ${i % 6}`), type: i < 6 ? "recall" : "case" }));
    const p = plan({ sections: s, size: 10, style: "mixed", retries });
    const back = p.slots.filter((x) => x.why === "retry");
    expect(back).toHaveLength(Math.floor(10 * RETRY_SHARE));
    expect(back.every((x) => x.state === "done" && x.question_id != null && x.fact != null)).toBe(true);
    // A retried fact isn't planned again as a new slot.
    const retriedKeys = new Set(back.map((x) => x.key));
    expect(p.slots.filter((x) => x.why !== "retry" && retriedKeys.has(x.key))).toEqual([]);
    expect(p.slots.slice(0, 4).map((x) => x.question_id)).toEqual([500, 501, 502, 503]);
  });

  it("retries never leave a section without a slot", () => {
    const five = [1, 2, 3, 4, 5].map((id) => ({ id, slides: [slide(id * 10, 2)] }));
    const retries = Array.from({ length: 5 }, (_, i) => rq(500 + i, 1, { factKey: factKey(`fact 10 number ${i % 2}`), type: "recall" }));
    const p = plan({ sections: five, size: 5, retries });
    expect(p.slots.filter((x) => x.why === "retry")).toHaveLength(1);
    expect(new Set(p.slots.map((x) => x.topic_id))).toEqual(new Set([1, 2, 3, 4, 5]));
    // Spread: one per section first.
    const spread = plan({ sections: s, size: 10, retries: [rq(1, 1, { factKey: "x" }), rq(2, 1, { factKey: "y" }), rq(3, 2, { factKey: "z" })] });
    expect(spread.slots.filter((x) => x.why === "retry").map((x) => x.question_id)).toEqual([1, 3, 2]);
    // A retry of a type the style doesn't hold stays out.
    expect(plan({ sections: s, size: 10, style: "recall", retries: [rq(9, 1, { type: "case" })] }).slots.some((x) => x.why === "retry")).toBe(false);
  });

  it("unused questions fill the slots for their fact; an old one with no key fills a slot on its slide", () => {
    const one = [{ id: 1, slides: [slide(10, ["a", "b"]), slide(11, ["c"])] }];
    const unused = [
      rq(700, 1, { factKey: factKey("b"), pageId: 10 }),
      rq(701, 1, { factKey: factKey("not in scope"), pageId: 10 }),
      rq(702, 1, { factKey: null, pageId: 11 }),
    ];
    const p = plan({ sections: one, size: 3, unused });
    expect(p.slots.map((x) => [x.key, x.why, x.state, x.question_id])).toEqual([
      [factKey("a"), "new", "todo", null],
      [factKey("b"), "unused", "done", 700],
      [slideKey(11), "unused", "done", 702],
    ]);
    // A missed fact keeps a question of its own: an old unkeyed question doesn't take its place.
    const missed = plan({ sections: one, size: 3, unused: [rq(702, 1, { pageId: 11 })], history: hist({ c: "wrong" }) });
    expect(missed.slots.find((x) => x.fact === "c")).toMatchObject({ why: "missed", state: "todo" });
  });
});

describe("planExam: case sets", () => {
  it("3-5 slots a case from neighbouring slides of one section, every section first", () => {
    const s = [1, 2, 3].map((id) => ({ id, slides: Array.from({ length: 8 }, (_, i) => slide(id * 100 + i, 1)) }));
    const p = plan({ sections: s, size: 12, style: "caseset" });
    expect(p.cases).toHaveLength(3);
    expect(new Set(p.cases.map((c) => c.topic_id))).toEqual(new Set([1, 2, 3]));
    numbered(p);
    for (const c of p.cases) {
      const slots = c.slots.map((n) => p.slots[n - 1]);
      expect(slots.length).toBeGreaterThanOrEqual(3);
      expect(slots.length).toBeLessThanOrEqual(5);
      expect(slots.every((x) => x.case_n === c.case_n && x.topic_id === c.topic_id && x.kind === "case")).toBe(true);
      const pages = slots.map((x) => x.page_id!);
      expect(Math.max(...pages) - Math.min(...pages)).toBe(pages.length - 1); // consecutive slides
    }
    // Slots of one case are next to each other.
    expect(p.slots.map((x) => x.case_n)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it("a case grows around its best fact; retried cases come back whole; unused cases are reused", () => {
    const s = [{ id: 1, slides: Array.from({ length: 10 }, (_, i) => slide(100 + i, 1)) }];
    const p = plan({ sections: s, size: 4, style: "caseset", history: hist({ "fact 106 number 0": "wrong" }) });
    expect(p.cases).toHaveLength(1);
    expect(p.slots.map((x) => x.page_id)).toEqual([105, 106, 107, 108]);
    expect(p.cases[0].why).toBe("missed");

    const retriedCases = [[rq(1, 1, { type: "case", pageId: 100 }), rq(2, 1, { type: "case", pageId: 101 })]];
    const unusedCases = [[rq(3, 1, { type: "case" }), rq(4, 1, { type: "case" }), rq(5, 1, { type: "case" })]];
    const r = plan({ sections: s, size: 12, style: "caseset", retriedCases, unusedCases });
    expect(r.cases.map((c) => c.why)).toEqual(["retry", "unused", "new"]);
    expect(r.cases[0].slots.map((n) => r.slots[n - 1].question_id)).toEqual([1, 2]);
    expect(r.cases[1].slots.map((n) => r.slots[n - 1].question_id)).toEqual([3, 4, 5]);
    expect(r.slots.filter((x) => x.state === "done")).toHaveLength(5);
    numbered(r);
    // Size 1 still makes one case of three.
    expect(plan({ sections: s, size: 1, style: "caseset" }).slots).toHaveLength(3);
    // The default shuffle keeps each case together.
    const sh = planExam({ sections: s, size: 20, style: "caseset", adaptive: true, history: new Map(), retriedCases });
    for (const c of sh.cases) expect(c.slots).toEqual(c.slots.map((_, i) => c.slots[0] + i));
  });
});

// ---- With the database ----

const notesWith = (facts: string[], o: Record<string, unknown> = {}) => slideNotes({ key_facts: facts, ...o });

function attempt(examId: number, answers: { q: number; correct: 0 | 1; confidence?: string | null }[]): number {
  const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(examId).lastInsertRowid);
  answers.forEach((a, i) =>
    db
      .prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct, confidence) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, a.q, i, a.correct ? 0 : 1, a.correct, a.confidence ?? null),
  );
  return id;
}

function question(examId: number, topicId: number | null, pageId: number | null, factKeyValue: string | null, type = "recall"): number {
  return Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id, fact_key) VALUES (?, ?, ?, ?, '[\"a\",\"b\"]', 0, 'e', ?, ?)")
      .run(examId, topicId, type, `stem ${Math.random()}`, pageId, factKeyValue).lastInsertRowid,
  );
}

describe("readers and buildExamPlan", () => {
  it("planSections: facts, stars, cases and pictures from the notes; unread and filler slides left out; the lecture filter", () => {
    const w = world({
      lectures: ["a.pdf", "b.pdf"],
      sections: 2,
      slidesEach: 3,
      notes: (n) =>
        n === 1
          ? notesWith([], { is_filler: true })
          : n === 2
            ? notesWith(["f2"], { emphasized: true, image_description: "a radiograph" })
            : n === 3
              ? null
              : notesWith([`f${n}`], { case_prompt: n === 4 ? "what is it?" : null }),
    });
    const all = planSections(w.examId);
    expect(all.map((s) => s.id)).toEqual(w.topicIds);
    expect(all[0].slides).toEqual([{ id: w.pageIds[0][1], facts: ["f2"], starred: true, hasCase: false, hasPicture: true }]);
    expect(all[1].slides.map((s) => [s.facts, s.hasCase])).toEqual([
      [["f4"], true],
      [["f5"], false],
      [["f6"], false],
    ]);
    // Section 1 also holds a slide of lecture b: choosing lecture a leaves it out.
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([...w.pageIds[0], w.pageIds[1][0]]), w.topicIds[0]);
    const a = planSections(w.examId, [], [w.docIds[0]]);
    expect(a.map((s) => s.id)).toEqual([w.topicIds[0]]);
    expect(a[0].slides.map((s) => s.id)).toEqual([w.pageIds[0][1]]);
    expect(planSections(w.examId, [w.topicIds[1]]).map((s) => s.id)).toEqual([w.topicIds[1]]);
    const p = buildExamPlan(w.examId, { size: 10, style: "recall", adaptive: true, documentIds: [w.docIds[0]], shuffle: identity });
    expect(p.slots.map((x) => x.fact)).toEqual(["f2"]);
  });

  it("history: latest answer per fact key, unsure as practicePlan defines it; old questions counted per slide", () => {
    const w = world({ sections: 1, slidesEach: 3, notes: (n) => notesWith([`f${n}a`, `f${n}b`]) });
    const [p1, p2, p3] = w.pageIds[0];
    const t = w.topicIds[0];
    const qa = question(w.examId, t, p1, factKey("f1a"));
    const qb = question(w.examId, t, p1, factKey("f1b"));
    const qb2 = question(w.examId, t, p1, factKey("f1b"), "case");
    const old1 = question(w.examId, t, p2, null);
    const old2 = question(w.examId, t, p2, null);
    question(w.examId, t, p3, null); // written, never answered
    attempt(w.examId, [
      { q: qa, correct: 0 },
      { q: qb, correct: 1, confidence: "sure" },
      { q: old1, correct: 0 },
    ]);
    attempt(w.examId, [
      { q: qa, correct: 1, confidence: "guess" },
      { q: qb2, correct: 0 },
      { q: old1, correct: 1 },
      { q: old2, correct: 0 },
    ]);
    const h = answerHistory(w.examId);
    expect(h.facts.get(factKey("f1a"))?.result).toBe("unsure");
    expect(h.facts.get(factKey("f1b"))?.result).toBe("wrong");
    expect(h.oldBySlide.get(p2)).toEqual({ answered: 2, right: 1 });

    // Coverage: 6 facts; f1a, f1b tested (f1a right-but-unsure counts right); slide 2: two old answered, one right.
    expect(examCoverage(w.examId, { kind: "all" })).toEqual({ facts: 6, tested: 4, right: 2 });
    const slots = [
      { n: 1, topic_id: t, page_id: p1, fact: "f1a", key: factKey("f1a"), kind: "recall", why: "unsure", state: "done", question_id: 1 },
      { n: 2, topic_id: t, page_id: p1, fact: "f1a", key: factKey("f1a"), kind: "case", why: "unsure", state: "done", question_id: 2 },
      { n: 3, topic_id: t, page_id: p3, fact: "f3a", key: factKey("f3a"), kind: "recall", why: "new", state: "todo", question_id: null },
      { n: 4, topic_id: t, page_id: null, fact: null, key: "question:9", kind: "recall", why: "retry", state: "done", question_id: 9 },
    ] as const;
    expect(examCoverage(w.examId, { kind: "topics", topicIds: [t] }, [...slots]).inThisExam).toBe(2); // planned counts too: f1a and the still-unwritten f3a

    // buildExamPlan: the missed f1b comes back as it was (via retryQuestions), unsure f1a leads the new slots,
    // slide 2's facts (two old questions, two facts) go last; slide 3 (one old unanswered question) before them.
    const p = buildExamPlan(w.examId, { size: 6, style: "mixed", adaptive: true, shuffle: identity });
    // The old unkeyed miss comes back too (two of six is the RETRY_SHARE cap), covering its slide.
    expect(p.slots[0]).toMatchObject({ why: "retry", question_id: qb2, state: "done", fact: "f1b", kind: "case" });
    expect(p.slots[1]).toMatchObject({ why: "retry", question_id: old2, state: "done", fact: null, key: slideKey(p2) });
    expect(p.slots.slice(2).map((x) => [x.fact, x.why])).toEqual([
      ["f1a", "unsure"],
      ["f3a", "new"],
      ["f3b", "new"],
      ["f2a", "rotation"],
    ]);
    // Unused questions passed in fill their slots.
    const fresh = question(w.examId, t, p3, factKey("f3b"));
    const u = buildExamPlan(w.examId, { size: 6, style: "mixed", adaptive: true, shuffle: identity, unused: [fresh] });
    expect(u.slots.find((x) => x.fact === "f3b")).toMatchObject({ why: "unused", question_id: fresh, state: "done" });
  });

  it("another student's history never counts, even on a shared copy of the exam", () => {
    const w = world({ sections: 1, slidesEach: 1, notes: () => notesWith(["shared fact"]) });
    const mate = apiReadyUser();
    const copy = world({ userId: mate, sections: 1, slidesEach: 1, notes: () => notesWith(["shared fact"]) });
    db.prepare("UPDATE exams SET source_exam_id = ? WHERE id = ?").run(w.examId, copy.examId);
    const q = question(copy.examId, copy.topicIds[0], copy.pageIds[0][0], factKey("shared fact"));
    attempt(copy.examId, [{ q, correct: 0 }]);
    expect(answerHistory(w.examId).facts.size).toBe(0);
    expect(examCoverage(w.examId, { kind: "all" })).toEqual({ facts: 1, tested: 0, right: 0 });
    expect(examCoverage(copy.examId, { kind: "all" })).toEqual({ facts: 1, tested: 1, right: 0 });
    // Her own second copy in the same family does count for her.
    const mine = world({ userId: w.userId, sections: 1, slidesEach: 1, notes: () => notesWith(["shared fact"]) });
    db.prepare("UPDATE exams SET source_exam_id = ? WHERE id = ?").run(w.examId, mine.examId);
    const q2 = question(mine.examId, mine.topicIds[0], mine.pageIds[0][0], factKey("shared fact"));
    attempt(mine.examId, [{ q: q2, correct: 1, confidence: "sure" }]);
    expect(examCoverage(w.examId, { kind: "all" })).toEqual({ facts: 1, tested: 1, right: 1 });
  });

  it("examCoverage is cheap: 300 slides x 6 facts with history", () => {
    const w = world({ sections: 20, slidesEach: 15, notes: (n) => notesWith(Array.from({ length: 6 }, (_, k) => `slide ${n} fact ${k}`)) });
    const qs = w.pageIds.flat().slice(0, 150).map((p, i) => question(w.examId, w.topicIds[Math.floor(i / 15)], p, factKey(`slide ${i + 1} fact 0`)));
    for (let a = 0; a < 5; a++) attempt(w.examId, qs.slice(a * 30, a * 30 + 30).map((q, i) => ({ q, correct: (i % 3 ? 1 : 0) as 0 | 1 })));
    examCoverage(w.examId, { kind: "all" }); // warm the statements
    const t0 = performance.now();
    const runs = 5;
    let c = examCoverage(w.examId, { kind: "all" });
    for (let i = 1; i < runs; i++) c = examCoverage(w.examId, { kind: "all" });
    const ms = (performance.now() - t0) / runs;
    console.log(`examCoverage on 300 slides x 6 facts: ${ms.toFixed(1)} ms`);
    expect(c).toEqual({ facts: 1800, tested: 150, right: 100 });
    expect(ms).toBeLessThan(250);
    const t1 = performance.now();
    const p = buildExamPlan(w.examId, { size: 100, style: "mixed", adaptive: true });
    console.log(`buildExamPlan (100 questions) on 300 slides x 6 facts: ${(performance.now() - t1).toFixed(1)} ms`);
    expect(p.slots).toHaveLength(100);
    numbered(p);
    expect(new Set(p.slots.map((x) => x.topic_id)).size).toBe(20);
  });
});

describe("schema", () => {
  const cols = (d: Database.Database, t: string) => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string; dflt_value: string | null; notnull: number }[]);
  const NEW = { questions: ["fact_key"], attempts: ["requested", "slots_json", "short_reason", "resumed_at", "options_json"], ai_usage: ["ok", "error", "ref"] };

  it("a new database has the exam-plan columns and the (topic_id, fact_key) index", () => {
    for (const [t, names] of Object.entries(NEW)) expect(cols(db, t).map((c) => c.name)).toEqual(expect.arrayContaining(names));
    expect(cols(db, "ai_usage").find((c) => c.name === "ok")).toMatchObject({ notnull: 1, dflt_value: "1" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'questions_topic_fact'").get()).toBeTruthy();
  });

  it("an old database gains them, keeping its rows (old ai_usage rows read as ok)", async () => {
    const src = execSync("git show 356de6f:src/lib/db.ts", { encoding: "utf8", cwd: path.join(import.meta.dirname, "..") });
    const OLD = src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w3plan-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(OLD);
    expect(cols(old, "questions").map((c) => c.name)).not.toContain("fact_key");
    old.exec(`
      INSERT INTO users (email, password_hash) VALUES ('a@x.dev', 'x');
      INSERT INTO exams (user_id, name) VALUES (1, 'E');
      INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (1, 'recall', 's', '["a","b"]', 0, 'e');
      INSERT INTO attempts (exam_id, mode) VALUES (1, 'tutor');
      INSERT INTO ai_usage (user_id, provider, model, purpose) VALUES (1, 'anthropic', 'm', 'p');`);
    old.close();
    vi.resetModules();
    const before = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    const saved = (globalThis as { __db?: unknown }).__db;
    delete (globalThis as { __db?: unknown }).__db;
    try {
      const { db: up } = await import("@/lib/db");
      for (const [t, names] of Object.entries(NEW)) expect(cols(up, t).map((c) => c.name)).toEqual(expect.arrayContaining(names));
      expect(up.prepare("SELECT fact_key FROM questions").get()).toEqual({ fact_key: null });
      expect(up.prepare("SELECT requested, slots_json, short_reason, resumed_at, options_json FROM attempts").get()).toEqual({
        requested: null,
        slots_json: null,
        short_reason: null,
        resumed_at: null,
        options_json: null,
      });
      expect(up.prepare("SELECT ok, error, ref FROM ai_usage").get()).toEqual({ ok: 1, error: null, ref: null });
      expect(up.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'questions_topic_fact'").get()).toBeTruthy();
      up.close();
    } finally {
      (globalThis as { __db?: unknown }).__db = saved;
      process.env.DATA_DIR = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
