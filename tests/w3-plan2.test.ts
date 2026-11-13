// Wave 3 follow-ups to the exam planner: facts already planned in another exam that is still open rank last (so two
// exams started back to back don't repeat), keysInOpenExams, the case-set "smaller than asked" flag in attemptView,
// and how long attemptView takes on a long exam (it computes coverage on every view, poll and answer).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async () => {
    throw new Error("no AI in planner tests");
  }),
}));

import { db } from "@/lib/db";
import { factKey, keysInOpenExams, planExam, type ExamPlan, type PlanInput, type PlanSlide, type Slot } from "@/lib/examPlan";
import { attemptView } from "@/lib/attemptView";
import { smallerPlanLine } from "@/components/examProgressText";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { apiReadyUser, slideNotes, world } from "./helpers";

const identity = <T>(xs: readonly T[]) => [...xs];
const slide = (id: number, facts: number, o: Partial<PlanSlide> = {}): PlanSlide => ({
  id,
  facts: Array.from({ length: facts }, (_, i) => `fact ${id} number ${i}`),
  starred: false,
  hasCase: false,
  hasPicture: false,
  ...o,
});
const plan = (o: Partial<PlanInput>) =>
  planExam({
    sections: [],
    size: 10,
    style: "recall",
    adaptive: true,
    history: new Map(),
    shuffle: identity,
    ...o,
  });
const busy = (keys: string[], n = 1) => new Map(keys.map((k) => [k, n]));
const keysOf = (p: ExamPlan) => p.slots.map((s) => s.key);

describe("planExam: facts already planned in another open exam", () => {
  // 2 sections × 3 slides × 2 facts = 12 facts.
  const sections = [
    { id: 1, slides: [slide(10, 2), slide(11, 2), slide(12, 2)] },
    { id: 2, slides: [slide(20, 2), slide(21, 2), slide(22, 2)] },
  ];
  const all = sections.flatMap((s) => s.slides.flatMap((sl) => sl.facts.map(factKey)));

  it("rank after every other fact, so a second exam plans the other facts", () => {
    const a = plan({ sections, size: 6 });
    const b = plan({ sections, size: 6, inOpenExams: busy(keysOf(a)) });
    expect(new Set([...keysOf(a), ...keysOf(b)]).size).toBe(12);
  });

  it("are taken only when the material runs out, those in fewer open exams first, and keep their own why", () => {
    const a = plan({ sections, size: 6 });
    const open = new Map(all.map((k) => [k, keysOf(a).includes(k) ? 2 : 1]));
    const c = plan({ sections, size: 8, inOpenExams: open });
    expect(c.slots).toHaveLength(8);
    // The six keys in only one open exam first, then two of exam a's.
    expect(c.slots.filter((s) => open.get(s.key) === 1)).toHaveLength(6);
    expect(c.slots.every((s) => s.why === "new")).toBe(true);
  });

  it("a section whose every fact is in an open exam doesn't take its 'one per section' slot while free facts remain", () => {
    const first = sections[0].slides.flatMap((s) => s.facts.map(factKey));
    const p = plan({ sections, size: 6, inOpenExams: busy(first) });
    expect(p.slots.every((s) => s.topic_id === 2)).toBe(true);
    // Not enough free facts: the busy section gets its slot (and only what is needed).
    const q = plan({ sections, size: 8, inOpenExams: busy(first) });
    expect(q.slots.filter((s) => s.topic_id === 1)).toHaveLength(2);
  });

  it("with focus on, a missed fact in an open exam still yields to unplanned facts of any rank", () => {
    const missed = factKey("fact 10 number 0");
    const p = plan({
      sections,
      size: 11,
      adaptive: true,
      history: new Map([[missed, { result: "wrong", at: 3 }]]),
      inOpenExams: busy([missed]),
    });
    expect(keysOf(p)).not.toContain(missed);
    const q = plan({
      sections,
      size: 12,
      adaptive: true,
      history: new Map([[missed, { result: "wrong", at: 3 }]]),
      inOpenExams: busy([missed]),
    });
    expect(q.slots.find((s) => s.key === missed)?.why).toBe("missed");
    // Without the open exam it leads.
    const r = plan({
      sections,
      size: 1,
      adaptive: true,
      history: new Map([[missed, { result: "wrong", at: 3 }]]),
    });
    expect(keysOf(r)).toEqual([missed]);
  });

  it("case sets: cases are grown from free facts first, even further from the seed", () => {
    const one = [
      {
        id: 1,
        slides: [slide(10, 2), slide(11, 2), slide(12, 2), slide(13, 2), slide(14, 2), slide(15, 2)],
      },
    ];
    const a = plan({ sections: one, size: 4, style: "caseset" });
    expect(a.slots).toHaveLength(4);
    const b = plan({
      sections: one,
      size: 8,
      style: "caseset",
      inOpenExams: busy(keysOf(a)),
    });
    expect(b.slots.filter((s) => keysOf(a).includes(s.key))).toHaveLength(0);
    expect(b.cases).toHaveLength(2);
    // A third with everything taken still gets its case (least bad).
    const c = plan({
      sections: one,
      size: 4,
      style: "caseset",
      inOpenExams: busy([...keysOf(a), ...keysOf(b)]),
    });
    expect(c.slots).toHaveLength(4);
  });

  it("case sets: a section whose facts are all in an open exam waits while another section has free ones", () => {
    const two = [
      { id: 1, slides: [slide(10, 2), slide(11, 2)] },
      { id: 2, slides: [slide(20, 2), slide(21, 2)] },
    ];
    const p = plan({
      sections: two,
      size: 4,
      style: "caseset",
      inOpenExams: busy(two[0].slides.flatMap((s) => s.facts.map(factKey))),
    });
    expect(p.cases.map((c) => c.topic_id)).toEqual([2]);
  });
});

// ---- keysInOpenExams ----

const slotsJson = (keys: string[], state: Slot["state"] = "todo") =>
  JSON.stringify({
    style: "recall",
    requested: keys.length,
    cases: [],
    slots: keys.map((key, i) => ({
      n: i + 1,
      topic_id: null,
      page_id: null,
      fact: key,
      key,
      kind: "recall",
      why: "new",
      state,
      question_id: null,
    })),
  });
const attempt = (examId: number, status: string, keys: string[], o: { started?: string; state?: Slot["state"] } = {}) =>
  Number(
    db
      .prepare(`INSERT INTO attempts (exam_id, mode, status, slots_json, started_at) VALUES (?, 'tutor', ?, ?, ${o.started ? "datetime('now', ?)" : "datetime('now')"})`)
      .run(examId, status, slotsJson(keys, o.state), ...(o.started ? [o.started] : [])).lastInsertRowid,
  );

describe("keysInOpenExams", () => {
  it("counts every slot key of her open exams of the family, any state; not finished, failed, old or planless ones", () => {
    const w = world({ sections: 1 });
    attempt(w.examId, "ready", ["k1", "k2"]);
    attempt(w.examId, "generating", ["k2", "k3"], { state: "failed" });
    attempt(w.examId, "ready", ["k3", "k3"], { state: "done" }); // a key twice in one plan counts once
    attempt(w.examId, "finished", ["f1"]);
    attempt(w.examId, "error", ["e1"]);
    attempt(w.examId, "ready", ["old"], { started: "-25 hours" });
    db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'generating')").run(w.examId);
    db.prepare("INSERT INTO attempts (exam_id, mode, status, slots_json) VALUES (?, 'tutor', 'ready', 'not json')").run(w.examId);
    expect(Object.fromEntries(keysInOpenExams(w.examId))).toEqual({
      k1: 1,
      k2: 2,
      k3: 2,
    });
  });

  it("reads her own copies of the exam family, never a classmate's", () => {
    const owner = apiReadyUser();
    const w = world({
      sections: 1,
      userId: owner,
      ready: true,
      notes: () => slideNotes(),
    });
    const classmate = apiReadyUser();
    const classId = createClass(owner, "C");
    joinClass(classmate, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code);
    expect(shareExam(owner, classId, w.examId)).toBeNull();
    const shared = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(w.examId) as { id: number }).id;
    const copy = (addSharedExam(classmate, shared) as { examId: number }).examId;
    attempt(copy, "ready", ["theirs"]);
    attempt(w.examId, "ready", ["mine"]);
    expect([...keysInOpenExams(w.examId).keys()]).toEqual(["mine"]);
    expect([...keysInOpenExams(copy).keys()]).toEqual(["theirs"]);
  });
});

// ---- attemptView: smaller than asked ----

function viewWith(plan: Partial<ExamPlan> & { slots: unknown[] }, requested: number) {
  const w = world({ sections: 1 });
  const id = Number(
    db
      .prepare("INSERT INTO attempts (exam_id, mode, status, requested, slots_json, options_json) VALUES (?, 'tutor', 'ready', ?, ?, ?)")
      .run(w.examId, requested, JSON.stringify({ cases: [], ...plan }), JSON.stringify({ scope: { kind: "all" } })).lastInsertRowid,
  );
  return attemptView(id)!;
}
const slots = (n: number, caseSize = 0) =>
  Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    topic_id: null,
    page_id: null,
    fact: null,
    key: `k${i}`,
    kind: "case" as const,
    why: "new" as const,
    state: "done" as const,
    question_id: null,
    ...(caseSize ? { case_n: Math.floor(i / caseSize) + 1 } : {}),
  }));
const cases = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => ({
    case_n: i + 1,
    topic_id: null,
    why: "new" as const,
    slots: Array.from({ length: size }, (_, j) => i * size + j + 1),
  }));

describe("attemptView: smaller", () => {
  it("case sets: the cases the planner aims for (one per four asked) are not 'smaller', whatever the question count", () => {
    // 25 asked → 6 cases aimed for; 6 cases of 4 = 24 questions: no sentence.
    const full = viewWith({ style: "caseset", slots: slots(24, 4), cases: cases(6, 4) }, 25);
    expect(full.smaller).toBe(false);
    expect(smallerPlanLine(full)).toBeNull();
    // 3 cases where 6 were aimed for: the material ran out.
    const short = viewWith({ style: "caseset", slots: slots(12, 4), cases: cases(3, 4) }, 25);
    expect(short.smaller).toBe(true);
    expect(smallerPlanLine(short)).toBe("These lectures have material for 12 questions, so this exam has 12 (you asked for 25).");
    // A single case asked for (size 2 → max(1, round(0.5)) = 1) and planned: complete.
    expect(viewWith({ style: "caseset", slots: slots(3, 3), cases: cases(1, 3) }, 2).smaller).toBe(false);
  });

  it("other styles: fewer questions than asked", () => {
    const short = viewWith({ style: "recall", slots: slots(30) }, 100);
    expect(short.smaller).toBe(true);
    expect(smallerPlanLine(short)).toBe("These lectures have material for 30 questions, so this exam has 30 (you asked for 100).");
    const full = viewWith({ style: "mixed", slots: slots(10) }, 10);
    expect(full.smaller).toBe(false);
    expect(smallerPlanLine(full)).toBeNull();
  });

  it("an exam from before plans is never smaller", () => {
    const w = world({ sections: 1 });
    const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, requested) VALUES (?, 'tutor', 'ready', 20)").run(w.examId).lastInsertRowid);
    expect(attemptView(id)!.smaller).toBe(false);
  });
});

// ---- How long a view takes ----

describe("attemptView on a long exam", () => {
  it("a 100-question attempt over a 300-slide exam is viewed in well under a second", () => {
    const w = world({
      sections: 15,
      slidesEach: 20,
      ready: true,
      notes: (n) =>
        // Notes about the size of real ones (a few kilobytes each): they are parsed on every view.
        slideNotes({
          title: `slide ${n}`,
          summary: "s".repeat(1500),
          image_description: "d".repeat(800),
          key_facts: [`fact ${n}a`, `fact ${n}b`, `fact ${n}c`],
        }),
    });
    const pages = w.pageIds.flat();
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id, fact_key) VALUES (?, ?, 'recall', ?, ?, 0, 'e', ?, ?)");
    const planned: Slot[] = [];
    const attemptId = Number(
      db.prepare("INSERT INTO attempts (exam_id, mode, status, requested, options_json) VALUES (?, 'tutor', 'ready', 100, ?)").run(w.examId, JSON.stringify({ scope: { kind: "all" } }))
        .lastInsertRowid,
    );
    for (let i = 0; i < 100; i++) {
      const page = pages[i * 3];
      const key = factKey(`fact ${i * 3 + 1}a`);
      const topic = w.topicIds[Math.floor((i * 3) / 20)];
      const qid = Number(ins.run(w.examId, topic, `stem ${i}`, JSON.stringify(["a", "b", "c", "d", "e"]), page, key).lastInsertRowid);
      db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, ?, ?, ?)").run(attemptId, qid, i, i < 50 ? 0 : null, i < 50 ? 1 : null);
      planned.push({
        n: i + 1,
        topic_id: topic,
        page_id: page,
        fact: `fact ${i * 3 + 1}a`,
        key,
        kind: "recall",
        why: "new",
        state: "done",
        question_id: qid,
      });
    }
    db.prepare("UPDATE attempts SET slots_json = ? WHERE id = ?").run(
      JSON.stringify({
        style: "recall",
        requested: 100,
        slots: planned,
        cases: [],
      }),
      attemptId,
    );
    attemptView(attemptId); // warm up
    const runs = 10;
    const t = performance.now();
    for (let i = 0; i < runs; i++) attemptView(attemptId);
    const ms = (performance.now() - t) / runs;
    console.log(`attemptView, 100 questions over 300 slides: ${ms.toFixed(1)} ms`);
    const v = attemptView(attemptId)!;
    expect(v.coverage).toEqual({ facts: 900, inThisExam: 100, tested: 50 });
    expect(ms).toBeLessThan(1000);
  });
});
