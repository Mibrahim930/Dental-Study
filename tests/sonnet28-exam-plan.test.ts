// QA attack tests for exams written to a plan (docs/EXAM-PLAN.md): a hostile or sloppy writer, the money a plan costs,
// persistence and races, resume rules, old data, the plan through startAttempt, timed exams and copyExam.
// "BUG:" tests fail on purpose (a real defect, described above them); "(documented)" tests pin odd but accepted behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; ref?: string; maxTokens?: number };
type SlotLine = { n: number; page: number; kind: string; caseN: number | null };
type Answer = (slots: SlotLine[], call: number, opts: Call) => unknown;
const gen = vi.hoisted(() => ({
  calls: [] as Call[],
  answer: null as Answer | null,
  fail: null as null | ((call: number, opts: Call) => string | null),
  gate: null as Promise<void> | null,
  counter: 0,
  noKey: false,
}));

/** The planned questions a prompt lists: "Q4: slide P12 — fact: "…" — recall" (and "case 2" in case sets). */
const slotsOf = (content: string): SlotLine[] =>
  [...content.matchAll(/^Q(\d+): slide P(\d+)(.*) — (recall|case|image)$/gm)].map((m: RegExpMatchArray) => ({
    n: Number(m[1]),
    page: Number(m[2]),
    kind: m[4],
    caseN: /— case (\d+)/.exec(m[3]) ? Number(/— case (\d+)/.exec(m[3])![1]) : null,
  }));

const box = { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" };
const question = (slot: number | undefined, page: number, kind = "recall") => ({
  ...(slot != null ? { slot } : {}),
  type: kind,
  image_page_id: kind === "image" ? page : null,
  patient_box: kind === "case" ? box : null,
  stem: `written stem ${++gen.counter}`,
  options: ["A1", "B2", "C3", "D4", "E5"],
  correct_index: 0,
  correct_answer: "A1",
  explanation: "e",
  option_notes: ["n1", "n2", "n3", "n4", "n5"],
  source_page_id: page,
  concept: "Gen concept",
});
/** Every slot answered: one question each, or one case per case number. */
const answerAll: Answer = (slots, _n, opts) => {
  if (opts.purpose === "case sets") {
    const byCase = new Map<number, SlotLine[]>();
    for (const s of slots) byCase.set(s.caseN!, [...(byCase.get(s.caseN!) ?? []), s]);
    return {
      cases: [...byCase.values()].map((g: SlotLine[]) => ({ scenario: `scenario ${++gen.counter}`, patient_box: box, image_page_id: null, questions: g.map((s: SlotLine) => question(s.n, s.page)) })),
    };
  }
  return { questions: slots.map((s: SlotLine) => question(s.n, s.page, s.kind)) };
};

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: Call) => {
    gen.calls.push(opts);
    const n = gen.calls.length;
    if (gen.gate) await gen.gate;
    const err = gen.fail?.(n, opts);
    if (err) throw new Error(err);
    return (gen.answer ?? answerAll)(slotsOf(opts.content), n, opts);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => {
    if (gen.noKey) throw new Error("No API key set up. Add one in Settings.");
    return { userId, provider: "anthropic", apiKey: "k" };
  },
}));
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});

import { db } from "@/lib/db";
import { answerQuestion, finishAttempt, isResuming, KEY_RETRY_SEC, QUESTIONS_PER_CALL, RESUME_SPACING_SEC, recoverStaleAttempts, reportAttemptQuestion, resumeAttempt, SECONDS_PER_QUESTION, SECTION_CONCURRENCY, startAttempt } from "@/lib/practice";
import { attemptView, type AttemptProgress } from "@/lib/attemptView";
import { answerHistory, examCoverage, factKey, type ExamPlan } from "@/lib/examPlan";
import { removeDocument } from "@/lib/processing";
import { inflightCount } from "@/lib/inflight";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as attemptGET } from "@/app/api/attempts/[id]/route";
import { apiReadyUser, ctx, getReq, sessionCookie, slideNotes, world } from "./helpers";

type Notes = (n: number) => string;
const factNotes: Notes = (n) => slideNotes({ title: `slide ${n}`, key_facts: [`fact ${n}a`, `fact ${n}b`] });
/** An exam whose slides each list two facts of their own ("fact 3a", "fact 3b"). */
const exam = (sections = 2, slidesEach = 3, notes: Notes = factNotes) => world({ sections, slidesEach, ready: true, notes });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function settled(attemptId: number) {
  for (let i = 0; i < 2000; i++) {
    const a = db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId) as { status: string } | undefined;
    if (!a) throw new Error("attempt is gone");
    if (a.status !== "generating" && !isResuming(attemptId) && inflightCount() === 0) return attemptRow(attemptId);
    await sleep(5);
  }
  throw new Error("stuck");
}
/** Everything tracked has settled (also for an attempt whose row is gone). */
async function drain() {
  for (let i = 0; i < 2000 && inflightCount() > 0; i++) await sleep(5);
  await sleep(5);
}
async function waitCalls(n: number) {
  for (let i = 0; i < 400 && gen.calls.length < n; i++) await sleep(5);
}
type AttemptRow = {
  status: string;
  error: string | null;
  short_reason: string | null;
  time_limit_sec: number | null;
  requested: number | null;
  resumed_at: string | null;
  started_at: string;
  options_json: string | null;
  score: number | null;
};
const attemptRow = (id: number) => db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as AttemptRow;
const planOf = (id: number) => JSON.parse((db.prepare("SELECT slots_json FROM attempts WHERE id = ?").get(id) as { slots_json: string }).slots_json) as ExamPlan;
const latestPlan = () => JSON.parse((db.prepare("SELECT slots_json FROM attempts WHERE slots_json IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { slots_json: string }).slots_json) as ExamPlan;
type InExam = { question_id: number; position: number; option_order: string | null; fact_key: string | null; case_id: number | null; stem: string; chosen_index: number | null; reported: number };
const inExam = (id: number) =>
  db
    .prepare(
      `SELECT aq.question_id, aq.position, aq.option_order, aq.chosen_index, aq.reported, q.fact_key, q.case_id, q.stem
       FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ? ORDER BY aq.position`,
    )
    .all(id) as InExam[];
const progress = (id: number): Omit<AttemptProgress, "smaller"> => {
  const v = attemptView(id)!;
  return { requested: v.requested, planned: v.planned, written: v.written, pending: v.pending, short: v.short, coverage: v.coverage };
};
const KEY_ERROR = "401 authentication_error: invalid x-api-key";
const BUSY_ERROR = "overloaded_error 529";
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const ago = (id: number, seconds: number) => db.prepare("UPDATE attempts SET resumed_at = datetime('now', ?) WHERE id = ?").run(`-${seconds} seconds`, id);
/** Her answer to every question of an exam: right or wrong (stored the way the app stores it), then finished. */
const answerAll_ = (attemptId: number, right: boolean, confidence = "sure") => {
  for (const r of inExam(attemptId)) {
    const q = db.prepare("SELECT correct_index FROM questions WHERE id = ?").get(r.question_id) as { correct_index: number };
    db.prepare("UPDATE attempt_questions SET chosen_index = ?, correct = ?, confidence = ? WHERE attempt_id = ? AND question_id = ?").run(
      right ? q.correct_index : (q.correct_index + 1) % 5,
      right ? 1 : 0,
      confidence,
      attemptId,
      r.question_id,
    );
  }
  db.prepare("UPDATE attempts SET status = 'finished', finished_at = datetime('now') WHERE id = ?").run(attemptId);
};

let release: (() => void) | null = null;
beforeEach(() => {
  gen.calls = [];
  gen.answer = null;
  gen.fail = null;
  gen.gate = null;
  gen.noKey = false;
  release = null;
});
afterEach(async () => {
  release?.();
  gen.gate = null;
  await drain();
});
const hold = () => {
  gen.gate = new Promise<void>((r) => (release = () => ((gen.gate = null), r())));
};

/** A short exam: topic 2's calls fail (busy), topic 1's is written. Three questions in, three open. */
async function shortExam(mode: "tutor" | "timed" = "tutor") {
  const w = exam(2, 3);
  gen.fail = (_n, opts) => (opts.content.includes("Topic: Topic 2\n") ? BUSY_ERROR : null);
  const id = startAttempt(w.examId, { size: 6, mode, style: "recall", adaptive: false });
  await settled(id);
  gen.fail = null;
  gen.calls = [];
  return { w, id };
}
/** The slot numbers of the plan that still need writing. */
const openNs = (id: number) => planOf(id).slots.filter((s) => s.state !== "done").map((s) => s.n);

describe("a hostile or sloppy writer: which questions are accepted for a slot", () => {
  it("a question naming another section's slot is never stored; its own slots go to the one follow-up", async () => {
    const w = exam(2, 2);
    gen.answer = (slots, call, opts) => {
      if (call === 1) {
        const stray = latestPlan().slots.map((s) => s.n).filter((n: number) => !slots.some((s: SlotLine) => s.n === n))[0];
        return { questions: [question(stray, slots[0].page)] };
      }
      return answerAll(slots, call, opts);
    };
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    expect(gen.calls).toHaveLength(3); // two sections, plus one follow-up for the section whose call only strayed
    const plan = planOf(id);
    expect(plan.slots.every((s) => s.state === "done")).toBe(true);
    expect(count("SELECT COUNT(*) n FROM questions WHERE exam_id = ?", w.examId)).toBe(8);
    for (const s of plan.slots) expect(db.prepare("SELECT fact_key FROM questions WHERE id = ?").get(s.question_id)).toEqual({ fact_key: s.key });
  });

  it("a slot given as a string, a float, negative, huge, null, NaN, true, an array or an object is refused; only the whole number counts", async () => {
    const w = exam(1, 2);
    const weird: unknown[] = ["1", "2", 1.5, 2.0000001, -1, 0, 1e15, Number.MAX_SAFE_INTEGER, null, NaN, Infinity, true, [1], { n: 1 }];
    gen.answer = (slots, call, opts) => {
      if (call !== 1) return answerAll(slots, call, opts);
      return {
        questions: [...weird.map((v: unknown) => ({ ...question(undefined, slots[0].page), slot: v as number })), question(slots[0].n, slots[0].page)],
      };
    };
    const id = startAttempt(w.examId, { size: 4, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    expect(gen.calls).toHaveLength(2);
    expect(slotsOf(gen.calls[1].content).map((s: SlotLine) => s.n)).toEqual(slotsOf(gen.calls[0].content).slice(1).map((s: SlotLine) => s.n));
    expect(count("SELECT COUNT(*) n FROM questions WHERE exam_id = ?", w.examId)).toBe(4);
    expect(planOf(id).slots.every((s) => s.state === "done")).toBe(true);
  });

  it("more questions than slots (repeats, unknown numbers) store exactly one per slot; fewer or none leave the rest to one follow-up, then failed", async () => {
    const w = exam(1, 3);
    gen.answer = (slots) => ({
      questions: [...slots, ...slots, ...slots].map((s: SlotLine) => question(s.n, s.page)).concat([question(500, slots[0].page), question(0, slots[0].page)]),
    });
    const a = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(a);
    expect(gen.calls).toHaveLength(1);
    expect(count("SELECT COUNT(*) n FROM questions WHERE exam_id = ?", w.examId)).toBe(6);
    expect(inExam(a)).toHaveLength(6);

    // Fewer: only the first slot answered, every time. One follow-up for the five left, then they fail.
    const w2 = exam(1, 3);
    gen.calls = [];
    gen.answer = (slots, call) => ({ questions: call === 1 ? slots.slice(0, 1).map((s: SlotLine) => question(s.n, s.page)) : [] });
    const b = startAttempt(w2.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    const row = await settled(b);
    expect(gen.calls).toHaveLength(2);
    expect(slotsOf(gen.calls[1].content)).toHaveLength(5);
    expect(row).toMatchObject({ status: "ready", short_reason: "busy" });
    expect(progress(b)).toMatchObject({ planned: 6, written: 1, pending: 5 });
  });

  it("an empty, missing or null answer writes nothing: two calls per section (no more), an error, and no stray rows", async () => {
    const w = exam(2, 2);
    for (const answer of [() => ({ questions: [] }), () => ({}), () => null, () => ({ questions: "x" })]) {
      gen.calls = [];
      gen.answer = answer as Answer;
      const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "recall", adaptive: false });
      const row = await settled(id);
      expect(gen.calls).toHaveLength(4);
      expect(row).toMatchObject({ status: "error" });
      expect(row.error).toContain("No questions could be generated");
    }
    expect(count("SELECT COUNT(*) n FROM questions WHERE exam_id = ?", w.examId)).toBe(0);
  });

  // By design the writer is only checked against the slot NUMBER, not against what the question is about: a stem about
  // another slide's fact that names this slot is stored under this slot's fact_key (coverage then claims a fact the
  // exam never asks). The writer's own source slide wins over the slot's slide.
  it("(documented) a question about another slide's fact is accepted for the slot it names, under that slot's fact key", async () => {
    const w = exam(1, 3);
    gen.answer = (slots) => ({
      questions: slots.map((s: SlotLine, i: number) => ({ ...question(s.n, slots[(i + 1) % slots.length].page), stem: `About the other slide's fact ${i}` })),
    });
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    const plan = planOf(id);
    expect(plan.slots.every((s) => s.state === "done")).toBe(true);
    let elsewhere = 0;
    for (const s of plan.slots) {
      const q = db.prepare("SELECT fact_key, source_page_id FROM questions WHERE id = ?").get(s.question_id) as { fact_key: string; source_page_id: number };
      expect(q.fact_key).toBe(s.key);
      if (q.source_page_id !== s.page_id) elsewhere++;
    }
    expect(elsewhere).toBeGreaterThan(0);
    expect(progress(id).coverage).toMatchObject({ facts: 6, inThisExam: 6 });
  });

  it("4 or 6 options, an answer text matching no option, a wrong index, a blank stem and repeated options are refused; one follow-up, then failed and short", async () => {
    const w = exam(1, 5);
    const bad: ((q: ReturnType<typeof question>) => unknown)[] = [
      (q) => ({ ...q, options: ["A", "B", "C", "D"], option_notes: ["1", "2", "3", "4"], correct_answer: "A" }),
      (q) => ({ ...q, options: ["A", "B", "C", "D", "E", "F"], option_notes: ["1", "2", "3", "4", "5", "6"], correct_answer: "A" }),
      (q) => ({ ...q, correct_answer: "none of these" }),
      (q) => ({ ...q, correct_index: 5 }),
      (q) => ({ ...q, correct_index: -1 }),
      (q) => ({ ...q, correct_index: 1.5 }),
      (q) => ({ ...q, stem: "   " }),
      (q) => ({ ...q, options: ["A", "a ", "C", "D", "E"], correct_answer: "C" }),
      (q) => ({ ...q, options: ["A", "B", 3, "D", "E"] }),
    ];
    gen.answer = (slots, call) => ({
      questions: slots.map((s: SlotLine, i: number) => (call === 1 && i === 0 ? question(s.n, s.page) : bad[(i + call) % bad.length](question(s.n, s.page)))),
    });
    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "recall", adaptive: false });
    const row = await settled(id);
    expect(gen.calls).toHaveLength(2);
    expect(slotsOf(gen.calls[1].content)).toHaveLength(9);
    expect(row).toMatchObject({ status: "ready", short_reason: "busy" });
    expect(progress(id)).toMatchObject({ planned: 10, written: 1, pending: 9, short: { reason: "busy", writing: false } });
    expect(planOf(id).slots.filter((s) => s.state === "failed")).toHaveLength(9);
  });

  it("no slot is planned as a picture question when no slide has a picture", async () => {
    const w = exam(2, 3);
    for (const style of ["case", "mixed"] as const) {
      const id = startAttempt(w.examId, { size: 12, mode: "tutor", style, adaptive: false });
      await settled(id);
      expect(planOf(id).slots.some((s) => s.kind === "image")).toBe(false);
    }
  });

  // BUG: style "case": a planned case slot answered with type "case" and patient_box null (the schema allows null).
  // The question is stored as type 'case' with patient_box NULL: the student gets an INBDE "case" question with no
  // patient to read. src/lib/practice.ts:462 builds `box` as null when raw.patient_box is empty and never refuses it
  // (the single-question path has no "case needs a patient_box" check, unlike the case-set path which has a schema).
  it("BUG: a case slot answered with no patient box is refused (it would show a case question without a patient)", async () => {
    const w = exam(1, 3);
    gen.answer = (slots) => ({ questions: slots.map((s: SlotLine) => ({ ...question(s.n, s.page, "case"), patient_box: null })) });
    const id = startAttempt(w.examId, { size: 3, mode: "tutor", style: "case", adaptive: false });
    await settled(id);
    const rows = db.prepare("SELECT type, patient_box FROM questions WHERE exam_id = ?").all(w.examId) as { type: string; patient_box: string | null }[];
    expect(rows.filter((r) => r.type === "case" && r.patient_box == null)).toHaveLength(0);
  });
});

describe("case sets: a writer that mixes groups", () => {
  it("a case naming slots from two groups is kept for the first group only; the other group is written by the follow-up; nothing is stored twice", async () => {
    const w = exam(1, 6);
    gen.answer = (slots, call, opts) => {
      if (call !== 1) return answerAll(slots, call, opts);
      const groups = [...new Set(slots.map((s: SlotLine) => s.caseN))];
      const g1 = slots.filter((s: SlotLine) => s.caseN === groups[0]);
      const g2 = slots.filter((s: SlotLine) => s.caseN === groups[1]);
      return { cases: [{ scenario: "mixed", patient_box: box, image_page_id: null, questions: [g1[0], g1[1], g1[2], g2[0]].map((s: SlotLine) => question(s.n, s.page)) }] };
    };
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset", adaptive: false });
    const row = await settled(id);
    expect(gen.calls).toHaveLength(2);
    const plan = planOf(id);
    expect(plan.cases).toHaveLength(2);
    expect(plan.slots).toHaveLength(7); // the first case keeps the three it has; its fourth planned question left the plan
    expect(plan.slots.every((s) => s.state === "done")).toBe(true);
    expect(row.short_reason).toBeNull();
    for (const c of plan.cases) {
      const caseIds = new Set(c.slots.map((n: number) => (db.prepare("SELECT case_id FROM questions WHERE id = ?").get(plan.slots.find((s) => s.n === n)!.question_id) as { case_id: number }).case_id));
      expect(caseIds.size).toBe(1);
    }
    expect(new Set(inExam(id).map((r: InExam) => r.question_id)).size).toBe(7);
    expect(count("SELECT COUNT(*) n FROM questions WHERE exam_id = ?", w.examId)).toBe(7);
  });
});

describe("money: AI calls", () => {
  const chunks = (id: number) => {
    const per = new Map<number | null, number>();
    for (const s of planOf(id).slots) per.set(s.topic_id, (per.get(s.topic_id) ?? 0) + 1);
    return [...per.values()].reduce((sum: number, n: number) => sum + Math.ceil(n / QUESTIONS_PER_CALL), 0);
  };
  for (const sections of [1, 3]) {
    it(`a perfect writer over ample material (${sections} section${sections > 1 ? "s" : ""}): sizes 10, 12, 13, 40 and 100 cost ceil(slots / 12) calls a section and no follow-up`, async () => {
      for (const size of [10, 12, 13, 40, 100]) {
        const w = exam(sections, Math.ceil(120 / sections / 2));
        gen.calls = [];
        const id = startAttempt(w.examId, { size, mode: "tutor", style: "recall", adaptive: false });
        const row = await settled(id);
        expect(row).toMatchObject({ status: "ready", short_reason: null });
        expect(planOf(id).slots).toHaveLength(size);
        expect(gen.calls).toHaveLength(chunks(id));
        const lines = gen.calls.map((c: Call) => slotsOf(c.content).length);
        for (const n of lines) expect(n).toBeLessThanOrEqual(QUESTIONS_PER_CALL);
        const asked = gen.calls.flatMap((c: Call) => slotsOf(c.content).map((s: SlotLine) => s.n));
        expect(asked.sort((a: number, b: number) => a - b)).toEqual(planOf(id).slots.map((s) => s.n)); // every slot asked exactly once
        expect(inExam(id)).toHaveLength(size);
      }
    });
  }

  it("one slot refused in every call costs exactly one follow-up per call, never a third", async () => {
    const w = exam(3, 10);
    gen.answer = (slots) => ({ questions: slots.slice(1).map((s: SlotLine) => question(s.n, s.page)) }); // the first slot is always refused
    const id = startAttempt(w.examId, { size: 40, mode: "tutor", style: "recall", adaptive: false });
    const row = await settled(id);
    const initial = chunks(id);
    expect(gen.calls).toHaveLength(2 * initial);
    // The follow-ups are the single refused slots; each slot was asked at most twice.
    const seen = new Map<number, number>();
    for (const c of gen.calls) for (const s of slotsOf(c.content)) seen.set(s.n, (seen.get(s.n) ?? 0) + 1);
    expect(Math.max(...seen.values())).toBe(2);
    expect([...seen.values()].filter((n: number) => n === 2)).toHaveLength(initial);
    expect(row.short_reason).toBe("busy");
    expect(progress(id)).toMatchObject({ planned: 40, pending: initial });
  });

  it("a key problem on the first call: no call after the ones already running, no follow-up, and the exam is short for 'key'", async () => {
    const w = exam(1, 50);
    gen.fail = (n: number) => (n === 1 ? KEY_ERROR : null);
    const id = startAttempt(w.examId, { size: 100, mode: "tutor", style: "recall", adaptive: false });
    const row = await settled(id);
    expect(gen.calls).toHaveLength(SECTION_CONCURRENCY); // nine calls were planned; the other five are never made
    expect(row).toMatchObject({ status: "ready", short_reason: "key" });
    expect(progress(id)).toMatchObject({ pending: 100 - inExam(id).length, short: { reason: "key", writing: false } });
  });

  it("a key problem on the only call: one call, an error, no follow-up", async () => {
    const w = exam(1, 3);
    gen.fail = () => KEY_ERROR;
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "recall", adaptive: false });
    const row = await settled(id);
    expect(gen.calls).toHaveLength(1);
    expect(row.status).toBe("error");
    expect(row.error).toContain("x-api-key");
  });

  it("no key at all: no AI call, an error that says so, never a throw", async () => {
    const w = exam(2, 3);
    gen.noKey = true;
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    const row = await settled(id);
    expect(gen.calls).toHaveLength(0);
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/No API key/);
  });
});

describe("persistence and races", () => {
  it("calls finishing at the same instant all save their slots: no update lost", async () => {
    const w = exam(4, 3); // four sections, four calls at once
    hold();
    const id = startAttempt(w.examId, { size: 24, mode: "tutor", style: "recall", adaptive: false });
    await waitCalls(4);
    expect(gen.calls).toHaveLength(4);
    release!();
    await settled(id);
    const plan = planOf(id);
    expect(plan.slots.every((s) => s.state === "done" && s.question_id != null)).toBe(true);
    expect(new Set(plan.slots.map((s) => s.question_id)).size).toBe(24);
    expect(inExam(id)).toHaveLength(24);
  });

  it("two exams started at once: the second is planned after the first is written, shares no question and no position collides", async () => {
    const w = exam(2, 3);
    const a = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    const b = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(a);
    await settled(b);
    const refs = gen.calls.map((c: Call) => c.ref);
    expect(refs.lastIndexOf(`attempt:${a}`)).toBeLessThan(refs.indexOf(`attempt:${b}`));
    const inA = new Set(inExam(a).map((r: InExam) => r.question_id));
    expect(inExam(b).some((r: InExam) => inA.has(r.question_id))).toBe(false);
    expect(count("SELECT COUNT(*) n FROM questions WHERE exam_id = ?", w.examId)).toBe(12); // nothing reused from an open exam
    for (const id of [a, b]) expect(inExam(id).map((r: InExam) => r.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("answering while a resume appends: positions never collide, no question twice, answers untouched", async () => {
    const { id } = await shortExam();
    ago(id, 180);
    hold();
    expect(resumeAttempt(id)).toBe(true);
    await waitCalls(1);
    const before = inExam(id);
    for (const r of before) {
      const q = db.prepare("SELECT correct_index FROM questions WHERE id = ?").get(r.question_id) as { correct_index: number };
      answerQuestion(id, r.question_id, q.correct_index, "sure");
    }
    release!();
    await settled(id);
    const after = inExam(id);
    expect(after.map((r: InExam) => r.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(after.map((r: InExam) => r.question_id)).size).toBe(6);
    expect(after.slice(0, 3).every((r: InExam) => r.chosen_index != null)).toBe(true);
    expect(after.slice(3).every((r: InExam) => r.chosen_index == null)).toBe(true);
  });

  it("finishing while a resume is in flight: nothing is appended after the finish, the score covers only what was in the exam", async () => {
    const { id } = await shortExam();
    const opened = openNs(id);
    ago(id, 180);
    hold();
    expect(resumeAttempt(id)).toBe(true);
    await waitCalls(1);
    const rows = inExam(id);
    for (const r of rows.slice(0, 2)) {
      const q = db.prepare("SELECT correct_index FROM questions WHERE id = ?").get(r.question_id) as { correct_index: number };
      answerQuestion(id, r.question_id, q.correct_index, "sure");
    }
    finishAttempt(id);
    expect(attemptRow(id).score).toBeCloseTo(2 / 3);
    release!();
    await settled(id);
    expect(inExam(id)).toHaveLength(3);
    expect(attemptRow(id)).toMatchObject({ status: "finished" });
    expect(attemptRow(id).score).toBeCloseTo(2 / 3);
    // The questions the resume paid for sit in the bank, in no exam: the next exam takes them before writing new ones.
    const written = planOf(id).slots.filter((s) => opened.includes(s.n) && s.state === "done").map((s) => s.question_id);
    expect(written).toHaveLength(3);
    const w2 = db.prepare("SELECT exam_id FROM attempts WHERE id = ?").get(id) as { exam_id: number };
    gen.calls = [];
    const again = startAttempt(w2.exam_id, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(again);
    const reused = planOf(again).slots.filter((s) => s.why === "unused").map((s) => s.question_id);
    for (const q of written) expect(reused).toContain(q);
  });

  // (documented) A finished exam that was short keeps pending > 0 and short = busy: the slots were written later but
  // never reached the exam. The screens show the "rest will be written" line only while the exam is in progress.
  it("(documented) a finished short exam still reports its missing questions as pending", async () => {
    const { id } = await shortExam();
    finishAttempt(id);
    expect(progress(id)).toMatchObject({ planned: 6, written: 3, pending: 3, short: { reason: "busy", writing: false } });
    ago(id, 600);
    expect(resumeAttempt(id)).toBe(false);
  });

  it("a reported question never comes back and its slot is not rewritten; the rest is appended after it", async () => {
    const { w, id } = await shortExam();
    const first = inExam(id)[0];
    const slotOfReported = planOf(id).slots.find((s) => s.question_id === first.question_id)!;
    expect(reportAttemptQuestion(w.userId, id, first.question_id, "wrong")).toBe(true);
    const open = openNs(id);
    ago(id, 180);
    expect(resumeAttempt(id)).toBe(true);
    await settled(id);
    expect(gen.calls.flatMap((c: Call) => slotsOf(c.content).map((s: SlotLine) => s.n)).sort()).toEqual([...open].sort()); // not the reported slot
    const rows = inExam(id);
    expect(rows).toHaveLength(6);
    expect(rows.map((r: InExam) => r.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.filter((r: InExam) => r.reported === 1).map((r: InExam) => r.question_id)).toEqual([first.question_id]);
    expect(planOf(id).slots.find((s) => s.n === slotOfReported.n)).toMatchObject({ state: "done", question_id: first.question_id });
    expect(progress(id)).toMatchObject({ written: 5, pending: 0, short: null });
    expect(attemptView(id)!.questions.some((q: { id: number }) => q.id === first.question_id)).toBe(false);
  });

  // Deleting a lecture: its section goes with it, but the plan's slots for that section stay "todo"/"failed".
  // Input: 2 lectures, one section each; section 2's writing failed (busy) so the exam is short; lecture 2 is removed
  // (removeDocument deletes topic 2); the exam is opened again. Output: pending stays 3 and short stays "busy"
  // forever ("The rest will be written shortly"), resume re-runs every two minutes and fails each slot again.
  // Responsible: src/lib/practice.ts:397 (writeSlots marks a slot failed when its section is gone, never drops it),
  // src/lib/practice.ts:746 (openSlots counts it forever) and :790 (short_reason kept while `left` > 0).
  it("BUG: slots of a lecture she deleted do not stay pending forever", async () => {
    const w = world({ lectures: ["a.pdf", "b.pdf"], sections: 2, slidesEach: 3, ready: true, notes: factNotes });
    gen.fail = (_n: number, opts: Call) => (opts.content.includes("Topic: Topic 2\n") ? BUSY_ERROR : null);
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    gen.fail = null;
    await removeDocument(w.docIds[1]);
    ago(id, 180);
    expect(() => resumeAttempt(id)).not.toThrow();
    await settled(id);
    const v = attemptView(id)!;
    expect(v.pending).toBe(0);
    expect(v.short).toBeNull();
  });

  // Input: one section holds slides of two lectures (a topic may); the exam is short; the second lecture is removed;
  // the exam is opened. The writer (perfect, as the prompt told it) answers every slot citing the slot's slide; for the
  // removed slides validateMcq clears the citation and practice.ts falls back on slot.page_id, a page that no longer
  // exists: INSERT hits the FOREIGN KEY. The transaction rolls back the WHOLE call, so questions for the slides that
  // still exist (already paid for) are lost too, the slots stay open, and every later resume pays for the same call again.
  // Responsible: src/lib/practice.ts:452 (`source = q.source_page_id ?? slot.page_id`), :442 (one transaction per call).
  it("BUG: after a lecture of a section is removed, the slots whose slides still exist are still written and appended", async () => {
    const w = world({
      lectures: ["a.pdf", "b.pdf"],
      sections: [
        { lecture: 0, slides: 2 },
        { lecture: 0, slides: 2 },
        { lecture: 1, slides: 2 },
      ],
      ready: true,
      notes: factNotes,
    });
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([...w.pageIds[1], ...w.pageIds[2]]), w.topicIds[1]);
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicIds[2]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    gen.fail = (_n: number, opts: Call) => (opts.content.includes("Topic: Topic 2\n") ? BUSY_ERROR : null);
    const id = startAttempt(w.examId, { size: 12, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    gen.fail = null;
    const before = inExam(id).length;
    expect(before).toBeGreaterThan(0);
    await removeDocument(w.docIds[1]);
    ago(id, 180);
    expect(() => resumeAttempt(id)).not.toThrow();
    await settled(id);
    log.mockRestore();
    const slotsLeft = planOf(id).slots.filter((s) => s.topic_id === w.topicIds[1] && s.page_id != null && w.pageIds[1].includes(s.page_id));
    expect(slotsLeft.length).toBeGreaterThan(0);
    expect(slotsLeft.every((s) => s.state === "done")).toBe(true);
    expect(inExam(id).length).toBe(before + slotsLeft.length);
  });

  // Input: two lectures; while the first exam is being written (calls in flight) lecture 2 is removed. Output: the
  // exam ends "error" (raw "FOREIGN KEY constraint failed" shown to her) although section 1's questions were
  // written and paid for; they sit in the plan as done and never reach an exam. Responsible: src/lib/practice.ts:463
  // (insert with the deleted topic_id), :133-136 (any throw turns the whole attempt into an error).
  it("BUG: removing a lecture while the exam is first written leaves a ready exam with the other section's questions", async () => {
    const w = world({ lectures: ["a.pdf", "b.pdf"], sections: 2, slidesEach: 3, ready: true, notes: factNotes });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    hold();
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await waitCalls(2);
    await removeDocument(w.docIds[1]);
    release!();
    const row = await settled(id);
    log.mockRestore();
    expect(row.status).toBe("ready");
    expect(inExam(id).length).toBeGreaterThan(0);
  });

  it("deleting the exam while it is being written, or while a resume writes, throws nothing and leaves no rows", async () => {
    const w = exam(2, 3);
    hold();
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await waitCalls(2);
    db.prepare("DELETE FROM exams WHERE id = ?").run(w.examId);
    release!();
    await drain();
    expect(count("SELECT COUNT(*) n FROM attempts WHERE id = ?", id)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM questions WHERE exam_id = ?", w.examId)).toBe(0);

    const { w: w2, id: id2 } = await shortExam();
    ago(id2, 180);
    hold();
    expect(resumeAttempt(id2)).toBe(true);
    await waitCalls(1);
    db.prepare("DELETE FROM exams WHERE id = ?").run(w2.examId);
    release!();
    await drain();
    expect(isResuming(id2)).toBe(false);
    expect(count("SELECT COUNT(*) n FROM attempt_questions WHERE attempt_id = ?", id2)).toBe(0);
  });
});

describe("resume rules", () => {
  it("two minutes: 118 seconds waits, 121 writes (SQLite time has whole seconds; 118 leaves room for the clock ticking)", async () => {
    const { id } = await shortExam();
    expect(RESUME_SPACING_SEC).toBe(120);
    ago(id, 118);
    expect(resumeAttempt(id)).toBe(false);
    expect(gen.calls).toHaveLength(0);
    ago(id, 121);
    expect(resumeAttempt(id)).toBe(true);
    await settled(id);
    expect(inExam(id)).toHaveLength(6);
  });

  it("thirty minutes after a key problem: 29 minutes waits, 31 tries again; a changed key goes at once", async () => {
    const w = exam(2, 3);
    gen.fail = (_n: number, opts: Call) => (opts.content.includes("Topic: Topic 2\n") ? KEY_ERROR : null);
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    expect(attemptRow(id).short_reason).toBe("key");
    expect(KEY_RETRY_SEC).toBe(1800);
    gen.calls = [];
    ago(id, 29 * 60);
    expect(resumeAttempt(id)).toBe(false);
    ago(id, 31 * 60);
    expect(resumeAttempt(id)).toBe(true);
    await settled(id);
    expect(gen.calls.length).toBeGreaterThan(0);
    expect(attemptRow(id).short_reason).toBe("key");
    gen.fail = null;
    ago(id, 5);
    expect(resumeAttempt(id)).toBe(false);
    db.prepare("UPDATE users SET provider = 'openai' WHERE id = ?").run(w.userId); // provider switched
    expect(resumeAttempt(id)).toBe(true);
    await settled(id);
    expect(attemptRow(id).short_reason).toBeNull();
    expect(inExam(id)).toHaveLength(6);
  });

  it("her key removed entirely: no throw, no AI call, short for 'key', no loop; a new key finishes the exam at once", async () => {
    const { w, id } = await shortExam();
    gen.noKey = true;
    db.prepare("UPDATE users SET api_key_enc = NULL, provider = NULL WHERE id = ?").run(w.userId);
    ago(id, 180);
    expect(resumeAttempt(id)).toBe(true);
    await settled(id);
    expect(gen.calls).toHaveLength(0);
    expect(attemptRow(id).short_reason).toBe("key");
    expect(resumeAttempt(id)).toBe(false);
    ago(id, 600);
    expect(resumeAttempt(id)).toBe(false); // still no key, ten minutes: not yet
    db.prepare("UPDATE users SET api_key_enc = 'new', provider = 'anthropic' WHERE id = ?").run(w.userId);
    gen.noKey = false;
    expect(resumeAttempt(id)).toBe(true);
    await settled(id);
    expect(attemptRow(id).short_reason).toBeNull();
    expect(inExam(id)).toHaveLength(6);
  });

  it("a resume whose every call fails again: slots stay open, resumed_at moves, one try only, no tight loop", async () => {
    const { id } = await shortExam();
    ago(id, 300);
    gen.fail = () => BUSY_ERROR;
    expect(resumeAttempt(id)).toBe(true);
    const row = await settled(id);
    expect(gen.calls).toHaveLength(2); // the call and its follow-up
    expect(row.short_reason).toBe("busy");
    expect(progress(id)).toMatchObject({ pending: 3, written: 3 });
    expect(count("SELECT COUNT(*) n FROM attempts WHERE id = ? AND resumed_at >= datetime('now', '-20 seconds')", id)).toBe(1);
    await sleep(60);
    expect(gen.calls).toHaveLength(2);
    expect(resumeAttempt(id)).toBe(false);
    jar.cookie = sessionCookie((db.prepare("SELECT user_id FROM exams WHERE id = (SELECT exam_id FROM attempts WHERE id = ?)").get(id) as { user_id: number }).user_id);
    await attemptGET(getReq(), ctx(id));
    await attemptGET(getReq(), ctx(id));
    expect(gen.calls).toHaveLength(2);
  });

  it("twenty resumes at once (direct and through the route) are one flight", async () => {
    const { w, id } = await shortExam();
    ago(id, 300);
    hold();
    const results = Array.from({ length: 20 }, () => resumeAttempt(id));
    expect(results.filter(Boolean)).toHaveLength(1);
    jar.cookie = sessionCookie(w.userId);
    const res = await Promise.all(Array.from({ length: 20 }, () => attemptGET(getReq(), ctx(id))));
    expect(res.every((r: Response) => r.status === 200)).toBe(true);
    await waitCalls(1);
    release!();
    await settled(id);
    expect(gen.calls).toHaveLength(1);
    expect(inExam(id)).toHaveLength(6);
  });

  it("an exam that is generating, errored, finished, or another student's is never resumed through the route; a stranger gets 404", async () => {
    const { w, id } = await shortExam();
    ago(id, 600);
    jar.cookie = sessionCookie(w.userId);
    for (const status of ["generating", "error", "finished"]) {
      db.prepare("UPDATE attempts SET status = ? WHERE id = ?").run(status, id);
      const res = await attemptGET(getReq(), ctx(id));
      expect(res.status).toBe(200);
      expect(isResuming(id)).toBe(false);
    }
    expect(gen.calls).toHaveLength(0);
    db.prepare("UPDATE attempts SET status = 'ready' WHERE id = ?").run(id);
    jar.cookie = sessionCookie(apiReadyUser());
    expect((await attemptGET(getReq(), ctx(id))).status).toBe(404);
    jar.cookie = undefined;
    expect((await attemptGET(getReq(), ctx(id))).status).toBe(401);
    expect(isResuming(id)).toBe(false);
    expect(gen.calls).toHaveLength(0);
  });

  // (documented) Nothing counts how often one slot has been refused: a slot the writer keeps getting wrong costs two
  // calls (the call and its follow-up) at every resume, which the page triggers every two minutes while it is open.
  it("(documented) a slot the writer always refuses is tried again at every resume, two calls each time", async () => {
    const { id } = await shortExam();
    gen.answer = () => ({ questions: [] });
    for (let i = 0; i < 3; i++) {
      ago(id, 300);
      expect(resumeAttempt(id)).toBe(true);
      await settled(id);
    }
    expect(gen.calls).toHaveLength(6);
    expect(progress(id).pending).toBe(3);
  });
});

describe("old data", () => {
  const OPTIONS = JSON.stringify({ style: "recall", size: 2, topicIds: [], documentIds: [], adaptive: false, scope: { kind: "all" } });
  const oldAttempt = (slots: string | null, options: string | null = OPTIONS) => {
    const w = exam(1, 1);
    const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, slots_json, options_json) VALUES (?, 'tutor', 'ready', ?, ?)").run(w.examId, slots, options).lastInsertRowid);
    const q = Number(
      db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e')").run(w.examId, w.topicIds[0]).lastInsertRowid,
    );
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 0)").run(id, q);
    return { w, id };
  };
  const old = { requested: null, planned: null, written: 1, pending: 0, short: null, coverage: null };

  it("no plan, a broken plan or a plan of the wrong shape looks like an old exam and never throws", () => {
    for (const slots of [null, "", "not json{", "[]", "null", '"x"', "7", '{"slots":"x"}', '{"cases":[]}']) {
      const { id } = oldAttempt(slots);
      expect(progress(id)).toEqual(old);
      expect(resumeAttempt(id)).toBe(false);
    }
  });

  it("(documented) an empty plan shows planned 0 and a coverage line of its own; nothing pending", () => {
    const { id } = oldAttempt('{"style":"recall","requested":4,"slots":[],"cases":[]}');
    const p = progress(id);
    expect(p).toMatchObject({ planned: 0, written: 1, pending: 0, short: null });
    expect(p.coverage).toMatchObject({ inThisExam: 0 });
    expect(resumeAttempt(id)).toBe(false);
  });

  it("slots whose question was since deleted: no throw; the slot stays done, nothing pending, never rewritten", async () => {
    const w = exam(2, 3);
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    const victims = planOf(id).slots.slice(0, 2).map((s) => s.question_id);
    db.prepare(`DELETE FROM questions WHERE id IN (${victims.map(() => "?").join(",")})`).run(...victims);
    expect(progress(id)).toMatchObject({ planned: 6, written: 4, pending: 0, short: null });
    ago(id, 600);
    expect(resumeAttempt(id)).toBe(false);
  });

  it("an exam from before plans gets the same fields whether or not it has options", () => {
    const { id } = oldAttempt(null, null);
    expect(progress(id)).toEqual(old);
  });

  // Input: slots_json {"slots":[null]}. Output: attemptView throws "Cannot read properties of null (reading 'state')",
  // and with it GET /api/attempts/[id] answers 500 for ever. Responsible: src/lib/attemptView.ts:200 (openSlots over
  // unchecked entries; practice.ts:293 has the same shape). Needs a hand-damaged row: low.
  it("BUG: a plan whose slots hold a null entry does not make attemptView throw", () => {
    const { id } = oldAttempt('{"style":"recall","requested":2,"slots":[null],"cases":[]}');
    expect(() => attemptView(id)).not.toThrow();
  });

  // Input: a plan with open slots and options_json that is not JSON. Output: resumeAttempt throws a SyntaxError, so
  // GET /api/attempts/[id] answers 500 every time she opens the exam. Responsible: src/lib/practice.ts:751
  // (JSON.parse of options_json without try/catch). Needs a damaged row: low.
  it("BUG: damaged options_json with open slots does not make resumeAttempt throw", () => {
    const slots = JSON.stringify({
      style: "recall",
      requested: 2,
      cases: [],
      slots: [{ n: 1, topic_id: 1, page_id: 1, fact: "f", key: "f", kind: "recall", why: "new", state: "todo", question_id: null }],
    });
    const { id } = oldAttempt(slots, "{broken");
    expect(() => resumeAttempt(id)).not.toThrow();
  });

  it("the boot sweep turns a damaged plan, or one whose done questions are gone, into an error instead of a ready exam with nothing in it", async () => {
    const w = exam(1, 3);
    const stale = (slots: string | null) =>
      Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, started_at, slots_json) VALUES (?, 'tutor', 'generating', datetime('now', '-6 minutes'), ?)").run(w.examId, slots).lastInsertRowid);
    const ghost = JSON.stringify({
      style: "recall",
      requested: 1,
      cases: [],
      slots: [{ n: 1, topic_id: w.topicIds[0], page_id: w.pageIds[0][0], fact: "f", key: "f", kind: "recall", why: "new", state: "done", question_id: 987654 }],
    });
    const ids = [stale("{{{"), stale('{"slots":"x"}'), stale(ghost), stale(null)];
    expect(() => recoverStaleAttempts()).not.toThrow();
    for (const id of ids) expect(attemptRow(id).status).toBe("error");
    expect(recoverStaleAttempts()).toEqual({ recovered: 0, failed: 0 });
  });
});

describe("the plan through startAttempt", () => {
  it("size 5 over one fact: a plan of one, complete, one call", async () => {
    const w = world({ sections: 1, slidesEach: 1, ready: true, notes: () => slideNotes({ key_facts: ["only fact"] }) });
    const id = startAttempt(w.examId, { size: 5, mode: "tutor", style: "recall", adaptive: false });
    const row = await settled(id);
    expect(row).toMatchObject({ status: "ready", short_reason: null, requested: 5 });
    expect(progress(id)).toEqual({ requested: 5, planned: 1, written: 1, pending: 0, short: null, coverage: { facts: 1, inThisExam: 1, tested: 0 } });
    expect(gen.calls).toHaveLength(1);
  });

  it("size 100 over 30 facts, recall only: planned 30, nothing pending, not short, no follow-up, and a second exam still has 30", async () => {
    const w = exam(1, 15);
    const id = startAttempt(w.examId, { size: 100, mode: "timed", style: "recall", adaptive: false });
    const row = await settled(id);
    expect(progress(id)).toEqual({ requested: 100, planned: 30, written: 30, pending: 0, short: null, coverage: { facts: 30, inThisExam: 30, tested: 0 } });
    expect(row.short_reason).toBeNull();
    expect(row.time_limit_sec).toBe(30 * SECONDS_PER_QUESTION);
    expect(gen.calls).toHaveLength(Math.ceil(30 / QUESTIONS_PER_CALL));
    ago(id, 600);
    expect(resumeAttempt(id)).toBe(false);
  });

  it("every section gets a question when the size is at least the number of sections", async () => {
    const w = exam(7, 1);
    for (const size of [7, 9]) {
      const id = startAttempt(w.examId, { size, mode: "tutor", style: "recall", adaptive: false });
      await settled(id);
      expect(new Set(planOf(id).slots.map((s) => s.topic_id))).toEqual(new Set(w.topicIds));
      answerAll_(id, true);
    }
  });

  it("with 'focus on my weak spots' on, facts she missed or was unsure of come first, whether returning as they were or written anew", async () => {
    const w = exam(1, 6); // twelve facts
    const first = startAttempt(w.examId, { size: 12, mode: "tutor", style: "recall", adaptive: true });
    await settled(first);
    answerAll_(first, true);
    const rows = inExam(first);
    const wrong = rows.slice(0, 3);
    const unsure = rows.slice(3, 5);
    for (const r of wrong) db.prepare("UPDATE attempt_questions SET correct = 0 WHERE attempt_id = ? AND question_id = ?").run(first, r.question_id);
    for (const r of unsure) db.prepare("UPDATE attempt_questions SET confidence = 'unsure' WHERE attempt_id = ? AND question_id = ?").run(first, r.question_id);
    const second = startAttempt(w.examId, { size: 5, mode: "tutor", style: "recall", adaptive: true });
    await settled(second);
    const keys = new Set(planOf(second).slots.map((s) => s.key));
    expect(keys).toEqual(new Set([...wrong, ...unsure].map((r: InExam) => r.fact_key)));
    expect(planOf(second).slots.filter((s) => s.why === "retry").length).toBeLessThanOrEqual(2);
  });

  it("retries are capped at 40% and keep a shuffled option order that scores by what she saw", async () => {
    const w = exam(1, 5);
    const first = startAttempt(w.examId, { size: 10, mode: "tutor", style: "recall", adaptive: true });
    await settled(first);
    answerAll_(first, false);
    gen.calls = [];
    const second = startAttempt(w.examId, { size: 10, mode: "tutor", style: "recall", adaptive: true });
    await settled(second);
    const plan = planOf(second);
    const retries = plan.slots.filter((s) => s.why === "retry");
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.length).toBeLessThanOrEqual(4);
    expect(gen.calls.flatMap((c: Call) => slotsOf(c.content))).toHaveLength(10 - retries.length); // only the new ones were paid for
    const rows = inExam(second);
    expect(rows).toHaveLength(10);
    const shuffled = rows.filter((r: InExam) => r.option_order != null);
    expect(shuffled.map((r: InExam) => r.question_id).sort()).toEqual(retries.map((s) => s.question_id!).sort());
    let moved = 0;
    for (const r of shuffled) {
      const order = JSON.parse(r.option_order!) as number[];
      expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
      if (order.some((v: number, i: number) => v !== i)) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    // She picks the option that SHOWS the right text: it is scored right.
    const view = attemptView(second)!;
    for (const vq of view.questions.filter((q: { retry: boolean }) => q.retry)) {
      const raw = db.prepare("SELECT options, correct_index FROM questions WHERE id = ?").get(vq.id) as { options: string; correct_index: number };
      const text = (JSON.parse(raw.options) as string[])[raw.correct_index];
      answerQuestion(second, vq.id, vq.options.indexOf(text), "sure");
      expect(db.prepare("SELECT correct FROM attempt_questions WHERE attempt_id = ? AND question_id = ?").get(second, vq.id)).toEqual({ correct: 1 });
    }
  });

  it("questions written but never answered are reused before paying for new ones; an exam still open is left alone", async () => {
    const w = exam(2, 3);
    const a = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(a);
    expect(gen.calls).toHaveLength(2);
    // Still open and recent: the next exam cannot share them.
    gen.calls = [];
    const open = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(open);
    expect(gen.calls).toHaveLength(2);
    // Abandoned (finished with nothing answered): the next exam is mostly free.
    db.prepare("UPDATE attempts SET status = 'finished' WHERE id IN (?, ?)").run(a, open);
    gen.calls = [];
    const b = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(b);
    expect(gen.calls).toHaveLength(0);
    expect(planOf(b).slots.every((s) => s.why === "unused")).toBe(true);
    expect(inExam(b)).toHaveLength(6);
    // Or ready but older than a day.
    db.prepare("UPDATE attempts SET started_at = datetime('now', '-2 days') WHERE id = ?").run(b);
    gen.calls = [];
    const c = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(c);
    expect(gen.calls).toHaveLength(0);
  });
});

describe("timed exams", () => {
  it("the limit is 72 s a question at ready, grows 72 s per appended question, never shrinks, and the clock is not reset", async () => {
    const { w, id } = await shortExam("timed");
    const limits: number[] = [attemptRow(id).time_limit_sec!];
    expect(limits[0]).toBe(3 * SECONDS_PER_QUESTION);
    db.prepare("UPDATE attempts SET started_at = datetime('now', '-10 minutes') WHERE id = ?").run(id);
    const started = attemptRow(id).started_at;
    // A failing resume changes nothing.
    ago(id, 300);
    gen.fail = () => BUSY_ERROR;
    resumeAttempt(id);
    await settled(id);
    limits.push(attemptRow(id).time_limit_sec!);
    gen.fail = null;
    // A report does not move it.
    reportAttemptQuestion(w.userId, id, inExam(id)[0].question_id, null);
    limits.push(attemptRow(id).time_limit_sec!);
    ago(id, 300);
    expect(resumeAttempt(id)).toBe(true);
    await settled(id);
    limits.push(attemptRow(id).time_limit_sec!);
    expect(limits).toEqual([216, 216, 216, 432]);
    for (let i = 1; i < limits.length; i++) expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1]);
    expect(attemptRow(id).started_at).toBe(started);
    expect(attemptView(id)!.attempt.time_limit_sec).toBe(432);
  });

  it("a timed exam with returning questions: the limit is 72 s times every question in it", async () => {
    const w = exam(1, 4);
    const first = startAttempt(w.examId, { size: 8, mode: "tutor", style: "recall", adaptive: true });
    await settled(first);
    answerAll_(first, false);
    const second = startAttempt(w.examId, { size: 8, mode: "timed", style: "recall", adaptive: true });
    await settled(second);
    expect(inExam(second)).toHaveLength(8);
    expect(attemptRow(second).time_limit_sec).toBe(8 * SECONDS_PER_QUESTION);
  });
});

describe("copyExam and the classmate's history", () => {
  it("a classmate's copy carries the fact keys (slide keys remapped); the owner's answers are not hers, and hers are not the owner's", async () => {
    const owner = apiReadyUser();
    // Slides list no fact: the plan's keys are "slide:<page id>".
    const w = world({ userId: owner, sections: 1, slidesEach: 3, ready: true, notes: (n: number) => slideNotes({ title: `s${n}`, key_facts: n === 1 ? ["a real fact"] : [] }) });
    const id = startAttempt(w.examId, { size: 3, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    answerAll_(id, false);
    expect(answerHistory(w.examId).facts.size).toBe(3);
    const classId = createClass(owner, "C");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    const mate = apiReadyUser();
    joinClass(mate, code);
    expect(shareExam(owner, classId, w.examId)).toBeNull();
    const shared = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(w.examId) as { id: number }).id;
    const copy = (addSharedExam(mate, shared) as { examId: number }).examId;

    const rows = db.prepare("SELECT fact_key, source_page_id FROM questions WHERE exam_id = ?").all(copy) as { fact_key: string | null; source_page_id: number }[];
    expect(rows).toHaveLength(3);
    const copyPages = new Set((db.prepare("SELECT p.id FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ?").all(copy) as { id: number }[]).map((p) => p.id));
    for (const r of rows) {
      expect(r.fact_key).not.toBeNull();
      if (r.fact_key!.startsWith("slide:")) expect(copyPages.has(Number(r.fact_key!.slice(6)))).toBe(true);
      else expect(r.fact_key).toBe(factKey("a real fact"));
    }
    // Her history is empty; the owner's is untouched; her coverage says she has been tested on nothing.
    expect(answerHistory(copy).facts.size).toBe(0);
    expect(answerHistory(w.examId).facts.size).toBe(3);
    expect(examCoverage(copy, { kind: "all" })).toMatchObject({ facts: 3, tested: 0, right: 0 });
    expect(examCoverage(w.examId, { kind: "all" })).toMatchObject({ facts: 3, tested: 3, right: 0 });
    // Her own answer on the copy counts for her only.
    const mine = startAttempt(copy, { size: 3, mode: "tutor", style: "recall", adaptive: true });
    await settled(mine);
    expect(planOf(mine).slots.every((s) => s.why !== "missed" && s.why !== "unsure" && s.why !== "retry")).toBe(true);
    answerAll_(mine, true);
    expect(answerHistory(copy).facts.size).toBe(3);
    expect([...answerHistory(w.examId).facts.values()].every((h: { result: string }) => h.result === "wrong")).toBe(true);
  });
});
