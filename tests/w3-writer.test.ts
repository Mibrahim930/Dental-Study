// Wave 3, practice exams written to a plan (docs/EXAM-PLAN.md "Writing to the plan", "Finishing itself", "What she
// sees"): numbered slot lines, questions accepted only for their slot, one follow-up call, fact keys, plan order, case
// sets, failure classes, resumeAttempt, the boot sweep, the attemptView fields and copyExam's fact keys.
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
}));

/** The planned questions a prompt lists: "Q4: slide P12 — fact: "…" — recall" (and "case 2" in case sets). */
const slotsOf = (content: string): SlotLine[] =>
  [...content.matchAll(/^Q(\d+): slide P(\d+)(.*) — (recall|case|image)$/gm)].map((m) => ({
    n: Number(m[1]),
    page: Number(m[2]),
    kind: m[4],
    caseN: /— case (\d+)/.exec(m[3]) ? Number(/— case (\d+)/.exec(m[3])![1]) : null,
  }));

const question = (slot: number | undefined, page: number, kind = "recall") => ({
  ...(slot != null ? { slot } : {}),
  type: kind,
  image_page_id: kind === "image" ? page : null,
  patient_box: kind === "case" ? { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" } : null,
  stem: `written stem ${++gen.counter}`,
  options: ["A1", "B2", "C3", "D4", "E5"],
  correct_index: 0,
  correct_answer: "A1",
  explanation: "e",
  option_notes: ["n1", "n2", "n3", "n4", "n5"],
  source_page_id: page,
  concept: "Gen concept",
});
const box = { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" };
/** Every slot answered: one question each, or one case per case number. */
const answerAll: Answer = (slots, _n, opts) => {
  if (opts.purpose === "case sets") {
    const byCase = new Map<number, SlotLine[]>();
    for (const s of slots) byCase.set(s.caseN!, [...(byCase.get(s.caseN!) ?? []), s]);
    return {
      cases: [...byCase.values()].map((g) => ({ scenario: `scenario ${++gen.counter}`, patient_box: box, image_page_id: null, questions: g.map((s) => question(s.n, s.page)) })),
    };
  }
  return { questions: slots.map((s) => question(s.n, s.page, s.kind)) };
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
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});

import { db } from "@/lib/db";
import { INTERRUPTED_ATTEMPT, isResuming, recoverStaleAttempts, resumeAttempt, SECONDS_PER_QUESTION, startAttempt } from "@/lib/practice";
import { attemptView, type AttemptProgress } from "@/lib/attemptView";
import { smallerPlanLine } from "@/components/examProgressText";
import { factKey, type ExamPlan } from "@/lib/examPlan";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as attemptGET } from "@/app/api/attempts/[id]/route";
import { apiReadyUser, ctx, getReq, sessionCookie, slideNotes, world } from "./helpers";

/** An exam whose slides each list two facts of their own ("fact 3a", "fact 3b"). */
function exam(sections = 2, slidesEach = 3, notes?: (n: number) => string) {
  return world({ sections, slidesEach, ready: true, notes: notes ?? ((n) => slideNotes({ title: `slide ${n}`, key_facts: [`fact ${n}a`, `fact ${n}b`] })) });
}

async function settled(attemptId: number) {
  for (let i = 0; i < 2000; i++) {
    const a = db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId) as { status: string };
    if (a.status !== "generating" && !isResuming(attemptId)) return attemptRow(attemptId);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("stuck");
}
const attemptRow = (id: number) =>
  db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as {
    status: string;
    error: string | null;
    short_reason: string | null;
    time_limit_sec: number | null;
    requested: number | null;
    resumed_at: string | null;
    options_json: string | null;
  };
const planOf = (id: number) => JSON.parse((db.prepare("SELECT slots_json FROM attempts WHERE id = ?").get(id) as { slots_json: string }).slots_json) as ExamPlan;
const inExam = (id: number) =>
  db
    .prepare("SELECT aq.question_id, aq.position, aq.option_order, q.fact_key, q.case_id, q.stem FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ? ORDER BY aq.position")
    .all(id) as { question_id: number; position: number; option_order: string | null; fact_key: string | null; case_id: number | null; stem: string }[];
const progress = (id: number): AttemptProgress => {
  const v = attemptView(id)!;
  return { requested: v.requested, planned: v.planned, smaller: v.smaller, written: v.written, pending: v.pending, short: v.short, coverage: v.coverage };
};
const answerAllRight = (attemptId: number) => {
  for (const r of inExam(attemptId)) {
    const q = db.prepare("SELECT correct_index FROM questions WHERE id = ?").get(r.question_id) as { correct_index: number };
    db.prepare("UPDATE attempt_questions SET chosen_index = ?, correct = 1, confidence = 'sure' WHERE attempt_id = ? AND question_id = ?").run(q.correct_index, attemptId, r.question_id);
  }
  db.prepare("UPDATE attempts SET status = 'finished', finished_at = datetime('now') WHERE id = ?").run(attemptId);
};
const KEY_ERROR = "401 authentication_error: invalid x-api-key";
const BUSY_ERROR = "overloaded_error 529";

let release: (() => void) | null = null;
beforeEach(() => {
  gen.calls = [];
  gen.answer = null;
  gen.fail = null;
  gen.gate = null;
  release = null;
});
afterEach(async () => {
  release?.();
  // Let background writing finish before the next test resets the mock.
  for (let i = 0; i < 400 && gen.gate; i++) await new Promise((r) => setTimeout(r, 1));
});
const hold = () => {
  gen.gate = new Promise<void>((r) => (release = () => ((gen.gate = null), r())));
};

describe("the prompt", () => {
  it("lists one numbered line per planned question, names the attempt, and has no old-stem list", async () => {
    const w = exam();
    // Old questions on the topic: the writer is no longer shown them.
    db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 'An old stem about something', '[]', 0, 'e')").run(
      w.examId,
      w.topicIds[0],
    );
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    const plan = planOf(id);
    expect(plan.slots).toHaveLength(6);
    expect(gen.calls).toHaveLength(2); // one call per section, nothing left for a follow-up
    const lines = gen.calls.flatMap((c) => slotsOf(c.content));
    expect(lines.map((l) => l.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const c of gen.calls) {
      expect(c.ref).toBe(`attempt:${id}`);
      expect(c.content).not.toMatch(/already had|already written|An old stem/);
      expect(c.content).not.toMatch(/missed or wasn't sure/); // no focus list: one fact per slot replaces it
      expect(c.content).toMatch(/^Write \d+ questions, one for each of these planned questions:$/m);
      // Each line is exactly the fake AI's format, with the fact quoted.
      for (const line of c.content.split("\n").filter((l) => l.startsWith("Q"))) expect(line).toMatch(/^Q\d+: slide P\d+ — fact: "fact \d+[ab]" — recall$/);
    }
    // Every slot's fact sits on the slide its line names.
    for (const s of plan.slots) expect(gen.calls.some((c) => c.content.includes(`Q${s.n}: slide P${s.page_id} — fact: "${s.fact}" — recall`))).toBe(true);
  });

  it("marks facts she missed last time (beyond those coming back as they were), so the question takes a new angle", async () => {
    const w = exam(1, 3);
    const first = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: true });
    await settled(first);
    answerAllRight(first);
    const missed = inExam(first).slice(0, 4);
    for (const m of missed) db.prepare("UPDATE attempt_questions SET correct = 0 WHERE attempt_id = ? AND question_id = ?").run(first, m.question_id);
    gen.calls = [];
    const second = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: true });
    await settled(second);
    const plan = planOf(second);
    // Two of the four come back as they were (the 40% cap); the other two missed facts are written anew, marked.
    expect(plan.slots.filter((s) => s.why === "retry")).toHaveLength(2);
    const marked = gen.calls.flatMap((c) => c.content.split("\n").filter((l) => / — missed last time — recall$/.test(l)));
    expect(marked).toHaveLength(2);
    expect(plan.slots.filter((s) => s.why === "missed").map((s) => s.n).sort()).toEqual(marked.map((l) => Number(/^Q(\d+)/.exec(l)![1])).sort());
    // Retried questions show their options in a new order.
    expect(inExam(second).filter((r) => r.option_order != null)).toHaveLength(2);
  });
});

describe("questions are accepted only for their slot", () => {
  it("refuses an unknown slot, a slot of another call, a missing slot and a second question for a filled slot; the follow-up asks only for the empty ones, once", async () => {
    const w = exam(2, 3);
    let otherCall: number[] = [];
    gen.answer = (slots, call, opts) => {
      if (call === 1) {
        const others = (JSON.parse((db.prepare("SELECT slots_json FROM attempts ORDER BY id DESC LIMIT 1").get() as { slots_json: string }).slots_json) as ExamPlan).slots
          .map((s) => s.n)
          .filter((n) => !slots.some((s) => s.n === n));
        otherCall = others;
        const [a, b] = slots;
        return {
          questions: [
            question(999, a.page), // unknown slot
            question(others[0], a.page), // a slot of the other call
            question(undefined, a.page), // no slot at all
            question(a.n, a.page), // fills a
            question(a.n, a.page), // a second question for the filled slot
            question(a.n + 0.5, b.page), // not a whole number
          ],
        };
      }
      return answerAll(slots, call, opts);
    };
    hold();
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await new Promise((r) => setTimeout(r, 20));
    release!();
    await settled(id);
    const plan = planOf(id);
    const firstCall = slotsOf(gen.calls[0].content).map((s) => s.n);
    const followUps = gen.calls.slice(2);
    expect(followUps).toHaveLength(1); // only the first call left slots empty
    expect(slotsOf(followUps[0].content).map((s) => s.n)).toEqual(firstCall.slice(1));
    expect(plan.slots.every((s) => s.state === "done")).toBe(true);
    // The other call's slot was filled by its own call: the stray answer for it was never stored.
    expect(otherCall.length).toBe(3);
    expect(inExam(id)).toHaveLength(6);
    expect(db.prepare("SELECT COUNT(*) n FROM questions WHERE exam_id = ?").get(w.examId)).toEqual({ n: 6 }); // nothing refused was stored
  });

  it("a slot still empty after the follow-up is 'failed'; the exam is ready, short and busy", async () => {
    const w = exam(1, 3);
    let skip: number | null = null;
    gen.answer = (slots) => {
      skip ??= slots[0].n;
      return { questions: slots.filter((s) => s.n !== skip).map((s) => question(s.n, s.page)) };
    };
    const id = startAttempt(w.examId, { size: 4, mode: "tutor", style: "recall", adaptive: false });
    const a = await settled(id);
    expect(gen.calls).toHaveLength(2);
    expect(slotsOf(gen.calls[1].content).map((s) => s.n)).toEqual([skip]);
    expect(planOf(id).slots.find((s) => s.n === skip)!.state).toBe("failed");
    expect(a.status).toBe("ready");
    expect(a.short_reason).toBe("busy");
    expect(progress(id)).toMatchObject({ requested: 4, planned: 4, written: 3, pending: 1, short: { reason: "busy", writing: false } });
  });

  it("stores the slot's key on each question; an image slot ends with a picture (the slide it names, else its own)", async () => {
    const pic = JSON.stringify({ ...JSON.parse(slideNotes({ key_facts: ["the radiolucency at the apex"] })), image_description: "a radiograph" });
    const w = exam(1, 2, (n) => (n === 1 ? pic : slideNotes({ key_facts: ["a plain fact"] })));
    gen.answer = (slots) => ({
      // The image question comes back named as a recall question with no picture: it still gets its slide's picture.
      questions: slots.map((s) => (s.kind === "image" ? { ...question(s.n, s.page, "recall"), image_page_id: null } : question(s.n, s.page, s.kind))),
    });
    const id = startAttempt(w.examId, { size: 3, mode: "tutor", style: "case", adaptive: false });
    await settled(id);
    const plan = planOf(id);
    expect(gen.calls).toHaveLength(1);
    expect(plan.slots.some((s) => s.kind === "image")).toBe(true);
    for (const s of plan.slots) {
      expect(s.state).toBe("done");
      const q = db.prepare("SELECT fact_key, type, image_page_id FROM questions WHERE id = ?").get(s.question_id) as { fact_key: string; type: string; image_page_id: number | null };
      expect(q.fact_key).toBe(s.key);
      if (s.kind === "image") expect(q).toMatchObject({ type: "image", image_page_id: w.pageIds[0][0] });
      else expect(q.type).toBe(s.kind);
    }
    expect(plan.slots.find((s) => s.kind === "image")!.key).toBe(factKey("the radiolucency at the apex"));
  });

  it("a question that mentions a picture it cannot show is refused for its slot", async () => {
    const w = exam(1, 2);
    gen.answer = (slots, call) => ({
      // The first answer points at a picture on a slide outside the section and cites no slide of it.
      questions: slots.map((s, i) => (call === 1 && i === 0 ? { ...question(s.n, 999999), stem: "In the radiograph shown, what is seen?", image_page_id: 999999 } : question(s.n, s.page))),
    });
    const id = startAttempt(w.examId, { size: 2, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    expect(gen.calls).toHaveLength(2);
    const first = slotsOf(gen.calls[0].content)[0].n;
    expect(slotsOf(gen.calls[1].content).map((s) => s.n)).toEqual([first]);
    expect(planOf(id).slots.every((s) => s.state === "done")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM questions WHERE stem LIKE 'In the radiograph%'").get()).toEqual({ n: 0 });
  });
});

describe("the exam follows the plan", () => {
  it("questions sit in plan order", async () => {
    const w = exam(3, 3);
    const id = startAttempt(w.examId, { size: 12, mode: "tutor", style: "mixed", adaptive: false });
    await settled(id);
    const plan = planOf(id);
    expect(inExam(id).map((r) => r.question_id)).toEqual([...plan.slots].sort((a, b) => a.n - b.n).map((s) => s.question_id));
    expect(inExam(id).map((r) => r.position)).toEqual(plan.slots.map((_, i) => i));
  });

  it("two exams in a row over the same material share no fact until the facts run out", async () => {
    const w = exam(2, 3); // 12 facts
    const keys = (id: number) => inExam(id).map((r) => r.fact_key!);
    const a = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(a);
    answerAllRight(a);
    const b = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(b);
    expect(new Set([...keys(a), ...keys(b)]).size).toBe(12);
    answerAllRight(b);
    // Every fact has been asked: the next exam goes back to those tested longest ago (exam a's).
    const c = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(c);
    expect(new Set(keys(c))).toEqual(new Set(keys(a)));
  });

  // Facts already planned in an exam still open (not finished, started in the last day) rank after every other, so a
  // second exam started before the first is answered plans the other facts (lib/examPlan.ts keysInOpenExams).
  it("two exams started back to back, the first not answered yet, plan different facts; a third takes the least bad", async () => {
    const w = exam(2, 3); // 12 facts
    const keys = (id: number) => inExam(id).map((r) => r.fact_key!);
    const a = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    const b = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(a);
    await settled(b);
    expect(keys(a)).toHaveLength(6);
    expect(keys(b)).toHaveLength(6);
    expect(new Set([...keys(a), ...keys(b)]).size).toBe(12);
    expect(inExam(a).some((r) => inExam(b).some((x) => x.question_id === r.question_id))).toBe(false);
    // Every fact is in an open exam: the third still gets a full exam of distinct facts, each its own why.
    const c = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(c);
    expect(new Set(keys(c)).size).toBe(6);
    expect(planOf(c).slots.every((s) => s.why === "new")).toBe(true);
  });

  it("an open exam started more than a day ago doesn't count", async () => {
    const w = exam(2, 3);
    const keys = (id: number) => inExam(id).map((r) => r.fact_key!);
    const a = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(a);
    db.prepare("UPDATE attempts SET started_at = datetime('now', '-25 hours') WHERE id = ?").run(a);
    const b = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(b);
    expect(new Set(keys(b))).toEqual(new Set(keys(a)));
  });

  it("a finished exam doesn't count as open: only the facts she answered in it count, through her answers", async () => {
    const w = exam(2, 3);
    const keys = (id: number) => inExam(id).map((r) => r.fact_key!);
    const a = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(a);
    // She answers two questions, then finishes: the four unanswered facts are free again, the two answered are not new.
    const answered = inExam(a).slice(0, 2);
    for (const r of answered) db.prepare("UPDATE attempt_questions SET chosen_index = 0, correct = 1, confidence = 'sure' WHERE attempt_id = ? AND question_id = ?").run(a, r.question_id);
    db.prepare("UPDATE attempts SET status = 'finished', finished_at = datetime('now') WHERE id = ?").run(a);
    const b = startAttempt(w.examId, { size: 10, mode: "tutor", style: "recall", adaptive: false });
    await settled(b);
    const unanswered = keys(a).filter((k) => !answered.some((r) => r.fact_key === k));
    expect(keys(b)).toEqual(expect.arrayContaining(unanswered));
    expect(keys(b).filter((k) => answered.some((r) => r.fact_key === k))).toHaveLength(0);
  });

  it("a classmate's open exam on her copy never counts", async () => {
    const owner = apiReadyUser();
    const w = world({ userId: owner, sections: 2, slidesEach: 3, ready: true, notes: (n) => slideNotes({ title: `slide ${n}`, key_facts: [`fact ${n}a`, `fact ${n}b`] }) });
    const classId = createClass(owner, "C");
    const mate = apiReadyUser();
    joinClass(mate, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code);
    expect(shareExam(owner, classId, w.examId)).toBeNull();
    const shared = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(w.examId) as { id: number }).id;
    const copy = (addSharedExam(mate, shared) as { examId: number }).examId;
    const keys = (id: number) => inExam(id).map((r) => r.fact_key!);
    const theirs = startAttempt(copy, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(theirs);
    const mine = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(mine);
    expect(new Set(keys(mine))).toEqual(new Set(keys(theirs)));
  });

  it("case sets: each planned case is one patient filling its slots in order; a case under three questions is dropped and its slots fail", async () => {
    const w = exam(1, 6); // 12 facts
    let shortCase: number | null = null;
    gen.answer = (slots, call, opts) => {
      const out = answerAll(slots, call, opts) as { cases: { questions: { slot: number }[] }[] };
      // The first case of every call comes back with only two questions.
      shortCase ??= slots[0].caseN;
      out.cases.forEach((c) => {
        if (slots.find((s) => s.n === c.questions[0].slot)!.caseN === shortCase) c.questions = c.questions.slice(0, 2);
      });
      return out;
    };
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "caseset", adaptive: false });
    const a = await settled(id);
    const plan = planOf(id);
    expect(plan.cases).toHaveLength(2);
    expect(gen.calls).toHaveLength(2); // the call, then a follow-up for the dropped case only
    expect(new Set(slotsOf(gen.calls[1].content).map((s) => s.caseN))).toEqual(new Set([shortCase]));
    const dropped = plan.cases.find((c) => c.case_n === shortCase)!;
    const kept = plan.cases.find((c) => c.case_n !== shortCase)!;
    expect(dropped.slots.every((n) => plan.slots.find((s) => s.n === n)!.state === "failed")).toBe(true);
    const rows = inExam(id);
    expect(rows.map((r) => r.question_id)).toEqual(kept.slots.map((n) => plan.slots.find((s) => s.n === n)!.question_id));
    expect(new Set(rows.map((r) => r.case_id)).size).toBe(1);
    expect(a.short_reason).toBe("busy");
  });

  it("case sets: a written case with fewer questions than planned keeps them and the rest leave the plan", async () => {
    const w = exam(1, 6);
    gen.answer = (slots, call, opts) => {
      const out = answerAll(slots, call, opts) as { cases: { questions: unknown[] }[] };
      out.cases.forEach((c) => (c.questions = c.questions.slice(0, 3)));
      return out;
    };
    const id = startAttempt(w.examId, { size: 4, mode: "tutor", style: "caseset", adaptive: false });
    const a = await settled(id);
    const plan = planOf(id);
    expect(gen.calls.flatMap((c) => slotsOf(c.content))).toHaveLength(4); // a case of four was planned
    expect(plan.slots).toHaveLength(3);
    expect(plan.cases[0].slots).toHaveLength(3);
    expect(a.short_reason).toBeNull();
    expect(progress(id)).toMatchObject({ planned: 3, written: 3, pending: 0, short: null });
  });
});

describe("failures", () => {
  it("a key problem on the second call stops every later call: ready, short for 'key', pending right", async () => {
    const w = exam(6, 2); // six sections → six calls, four at a time
    gen.fail = (n) => (n === 2 ? KEY_ERROR : null);
    hold();
    const id = startAttempt(w.examId, { size: 6, mode: "timed", style: "recall", adaptive: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(gen.calls).toHaveLength(4);
    release!();
    const a = await settled(id);
    expect(gen.calls).toHaveLength(4); // calls five and six are never made, and no follow-ups
    expect(a.status).toBe("ready");
    expect(a.short_reason).toBe("key");
    expect(a.time_limit_sec).toBe(3 * SECONDS_PER_QUESTION);
    const plan = planOf(id);
    expect(plan.slots.filter((s) => s.state === "done")).toHaveLength(3);
    expect(progress(id)).toMatchObject({ requested: 6, planned: 6, written: 3, pending: 3, short: { reason: "key", writing: false } });
  });

  it("a busy failure leaves a short exam marked 'busy'", async () => {
    const w = exam(2, 3);
    let failing: number | null = null;
    gen.fail = (_n, opts) => {
      const first = slotsOf(opts.content)[0].n;
      failing ??= first;
      return first === failing ? BUSY_ERROR : null;
    };
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    const a = await settled(id);
    expect(a).toMatchObject({ status: "ready", short_reason: "busy" });
    expect(gen.calls).toHaveLength(3); // the failed call got its one follow-up
    expect(progress(id).pending).toBe(3);
  });

  it("nothing written is an error with the first failure's text", async () => {
    const w = exam(2, 3);
    gen.fail = () => BUSY_ERROR;
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    const a = await settled(id);
    expect(a.status).toBe("error");
    expect(a.error).toContain(BUSY_ERROR);
    expect(inExam(id)).toHaveLength(0);
  });
});

/** A short exam: its first section's call fails twice (busy), the other section's is written. */
async function shortExam(mode: "tutor" | "timed" = "tutor") {
  const w = exam(2, 3);
  let failing: number | null = null;
  gen.fail = (_n, opts) => {
    const first = slotsOf(opts.content)[0]?.n;
    failing ??= first;
    return first === failing ? BUSY_ERROR : null;
  };
  const id = startAttempt(w.examId, { size: 6, mode, style: "recall", adaptive: false });
  await settled(id);
  gen.fail = null;
  gen.calls = [];
  return { w, id };
}
const ago = (id: number, minutes: number) => db.prepare("UPDATE attempts SET resumed_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);

describe("resumeAttempt", () => {
  it("writes only the open slots, appends them at the end, never touches existing rows, extends the timer and clears short_reason", async () => {
    const { id } = await shortExam("timed");
    const before = inExam(id);
    db.prepare("UPDATE attempt_questions SET chosen_index = 0, correct = 1 WHERE attempt_id = ? AND position = 0").run(id);
    const answered = db.prepare("SELECT * FROM attempt_questions WHERE attempt_id = ? ORDER BY position").all(id);
    const open = planOf(id).slots.filter((s) => s.state !== "done").map((s) => s.n);
    expect(attemptRow(id).time_limit_sec).toBe(3 * SECONDS_PER_QUESTION);
    expect(resumeAttempt(id)).toBe(false); // just tried: two minutes apart
    ago(id, 3);
    expect(resumeAttempt(id)).toBe(true);
    const a = await settled(id);
    expect(gen.calls.flatMap((c) => slotsOf(c.content).map((s) => s.n)).sort()).toEqual(open.sort());
    const after = inExam(id);
    expect(after).toHaveLength(6);
    expect(after.slice(0, 3)).toEqual(before);
    expect(db.prepare("SELECT * FROM attempt_questions WHERE attempt_id = ? AND position < 3 ORDER BY position").all(id)).toEqual(answered);
    const plan = planOf(id);
    expect(after.slice(3).map((r) => r.question_id)).toEqual(plan.slots.filter((s) => open.includes(s.n)).map((s) => s.question_id));
    expect(a.time_limit_sec).toBe(6 * SECONDS_PER_QUESTION);
    expect(a.short_reason).toBeNull();
    expect(progress(id)).toMatchObject({ written: 6, pending: 0, short: null });
    ago(id, 3);
    expect(resumeAttempt(id)).toBe(false); // nothing left
  });

  it("runs once at a time per attempt, and shows that it is writing", async () => {
    const { id } = await shortExam();
    ago(id, 3);
    hold();
    expect(resumeAttempt(id)).toBe(true);
    expect(resumeAttempt(id)).toBe(false);
    db.prepare("UPDATE attempts SET resumed_at = NULL WHERE id = ?").run(id);
    expect(resumeAttempt(id)).toBe(false); // still single flight, whatever resumed_at says
    expect(progress(id).short).toEqual({ reason: "busy", writing: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(gen.calls).toHaveLength(1);
    release!();
    await settled(id);
    expect(progress(id).short).toBeNull();
  });

  it("a short exam that fails again stays short, with the slots open for the next try", async () => {
    const { id } = await shortExam();
    ago(id, 3);
    gen.fail = () => BUSY_ERROR;
    expect(resumeAttempt(id)).toBe(true);
    const a = await settled(id);
    expect(a.short_reason).toBe("busy");
    expect(progress(id).pending).toBe(3);
    expect(inExam(id)).toHaveLength(3);
  });

  it("after a key problem: not while the key is unchanged, at once when it changed, or after 30 minutes", async () => {
    const w = exam(2, 3);
    let failing: number | null = null;
    gen.fail = (_n, opts) => {
      const first = slotsOf(opts.content)[0]?.n;
      failing ??= first;
      return first === failing ? KEY_ERROR : null;
    };
    hold();
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await new Promise((r) => setTimeout(r, 20));
    release!();
    await settled(id);
    expect(attemptRow(id).short_reason).toBe("key");
    expect(attemptRow(id).options_json).not.toContain("enc");
    gen.calls = [];
    gen.fail = () => KEY_ERROR;
    ago(id, 3);
    expect(resumeAttempt(id)).toBe(false); // unchanged key, three minutes
    ago(id, 29);
    expect(resumeAttempt(id)).toBe(false);
    ago(id, 31);
    expect(resumeAttempt(id)).toBe(true); // half an hour: try again
    await settled(id);
    expect(gen.calls.length).toBeGreaterThan(0);
    expect(attemptRow(id).short_reason).toBe("key");
    gen.calls = [];
    ago(id, 1);
    expect(resumeAttempt(id)).toBe(false);
    db.prepare("UPDATE users SET api_key_enc = 'a new key' WHERE id = ?").run(w.userId);
    gen.fail = null;
    expect(resumeAttempt(id)).toBe(true); // a changed key goes at once
    await settled(id);
    expect(attemptRow(id).short_reason).toBeNull();
    expect(inExam(id)).toHaveLength(6);
  });

  it("a provider change counts as a changed key", async () => {
    const w = exam(1, 3);
    gen.fail = () => KEY_ERROR;
    const id = startAttempt(w.examId, { size: 3, mode: "tutor", style: "recall", adaptive: false });
    expect((await settled(id)).status).toBe("error"); // nothing written: an error, never resumed
    expect(resumeAttempt(id)).toBe(false);
    // A short exam stopped by her key.
    const s = exam(2, 3);
    let failing: number | null = null;
    gen.fail = (_n, opts) => {
      const first = slotsOf(opts.content)[0]?.n;
      failing ??= first;
      return first === failing ? KEY_ERROR : null;
    };
    hold();
    const id2 = startAttempt(s.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await new Promise((r) => setTimeout(r, 20));
    release!();
    await settled(id2);
    gen.fail = null;
    expect(resumeAttempt(id2)).toBe(false);
    db.prepare("UPDATE users SET provider = 'openai' WHERE id = ?").run(s.userId);
    expect(resumeAttempt(id2)).toBe(true);
    await settled(id2);
  });

  it("waits its turn with the course's other writing: a new exam started meanwhile is planned after it and shares nothing", async () => {
    const { w, id } = await shortExam();
    ago(id, 3);
    hold();
    expect(resumeAttempt(id)).toBe(true);
    const next = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(gen.calls.every((c) => c.ref === `attempt:${id}`)).toBe(true);
    release!();
    await settled(id);
    await settled(next);
    const refs = gen.calls.map((c) => c.ref);
    expect(refs.lastIndexOf(`attempt:${id}`)).toBeLessThan(refs.indexOf(`attempt:${next}`));
    const mine = new Set(inExam(id).map((r) => r.question_id));
    expect(inExam(next).some((r) => mine.has(r.question_id))).toBe(false);
  });

  it("never runs for a finished exam or one from before plans", async () => {
    const { id } = await shortExam();
    ago(id, 3);
    db.prepare("UPDATE attempts SET status = 'finished' WHERE id = ?").run(id);
    expect(resumeAttempt(id)).toBe(false);
    // An exam from before plans: no slots, no options.
    db.prepare("UPDATE attempts SET status = 'ready', slots_json = NULL, options_json = NULL, requested = NULL WHERE id = ?").run(id);
    expect(resumeAttempt(id)).toBe(false);
    expect(gen.calls).toHaveLength(0);
    expect(progress(id)).toEqual({ requested: null, planned: null, smaller: false, written: 3, pending: 0, short: null, coverage: null });
  });

  it("an exam finished while its missing questions are written keeps what it had", async () => {
    const { id } = await shortExam();
    ago(id, 3);
    hold();
    expect(resumeAttempt(id)).toBe(true);
    db.prepare("UPDATE attempts SET status = 'finished' WHERE id = ?").run(id);
    release!();
    await settled(id);
    expect(inExam(id)).toHaveLength(3);
  });
});

describe("GET /api/attempts/[id]", () => {
  it("starts writing what is missing without waiting for it", async () => {
    const { w, id } = await shortExam();
    ago(id, 3);
    jar.cookie = sessionCookie(w.userId);
    hold();
    const res = await attemptGET(getReq(), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.short).toEqual({ reason: "busy", writing: true });
    expect(body.pending).toBe(3);
    expect(body.attempt.options_json).toBeUndefined();
    expect(body.attempt.slots_json).toBeUndefined();
    release!();
    await settled(id);
    const again = await (await attemptGET(getReq(), ctx(id))).json();
    expect(again).toMatchObject({ written: 6, pending: 0, short: null });
  });

  it("someone else's attempt is not found and is never resumed", async () => {
    const { id } = await shortExam();
    ago(id, 3);
    jar.cookie = sessionCookie(apiReadyUser());
    const res = await attemptGET(getReq(), ctx(id));
    expect(res.status).toBe(404);
    expect(isResuming(id)).toBe(false);
    expect(gen.calls).toHaveLength(0);
  });
});

describe("at boot", () => {
  it("an interrupted exam with written questions becomes a short exam that resumes; one with none, or an old one, is an error", async () => {
    // One written in full, then put back to "generating" with two slots still open, as a restart would leave it.
    const w = exam(1, 3);
    const id = startAttempt(w.examId, { size: 4, mode: "timed", style: "recall", adaptive: false });
    await settled(id);
    const plan = planOf(id);
    plan.slots[1].state = "todo";
    plan.slots[3].state = "todo";
    db.prepare("DELETE FROM attempt_questions WHERE attempt_id = ?").run(id);
    db.prepare("UPDATE attempts SET status = 'generating', slots_json = ?, started_at = datetime('now', '-6 minutes'), resumed_at = NULL WHERE id = ?").run(JSON.stringify(plan), id);
    // One with a plan and nothing done, and one from before plans.
    const none = Number(
      db
        .prepare("INSERT INTO attempts (exam_id, mode, status, started_at, slots_json) VALUES (?, 'tutor', 'generating', datetime('now', '-6 minutes'), ?)")
        .run(w.examId, JSON.stringify({ ...plan, slots: plan.slots.map((s) => ({ ...s, state: "todo", question_id: null })) })).lastInsertRowid,
    );
    const old = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, started_at) VALUES (?, 'tutor', 'generating', datetime('now', '-6 minutes'))").run(w.examId).lastInsertRowid);
    const fresh = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'generating')").run(w.examId).lastInsertRowid);

    expect(recoverStaleAttempts()).toEqual({ recovered: 1, failed: 2 });
    expect(attemptRow(id)).toMatchObject({ status: "ready", short_reason: "interrupted", time_limit_sec: 2 * SECONDS_PER_QUESTION });
    expect(inExam(id).map((r) => r.question_id)).toEqual([plan.slots[0].question_id, plan.slots[2].question_id]);
    expect(attemptRow(none)).toMatchObject({ status: "error", error: INTERRUPTED_ATTEMPT });
    expect(attemptRow(old)).toMatchObject({ status: "error", error: INTERRUPTED_ATTEMPT });
    expect(attemptRow(fresh).status).toBe("generating");
    expect(progress(id)).toMatchObject({ written: 2, pending: 2, short: { reason: "interrupted", writing: false } });

    // The normal resume takes over at once (nothing was tried since the restart).
    gen.calls = [];
    expect(resumeAttempt(id)).toBe(true);
    const a = await settled(id);
    expect(gen.calls.flatMap((c) => slotsOf(c.content).map((s) => s.n)).sort()).toEqual([plan.slots[1].n, plan.slots[3].n].sort());
    expect(a).toMatchObject({ short_reason: null, time_limit_sec: 4 * SECONDS_PER_QUESTION });
    expect(inExam(id).slice(0, 2).map((r) => r.question_id)).toEqual([plan.slots[0].question_id, plan.slots[2].question_id]);
    expect(recoverStaleAttempts()).toEqual({ recovered: 0, failed: 0 });
  });
});

describe("attemptView", () => {
  it("a complete exam", async () => {
    const w = exam(2, 3);
    const id = startAttempt(w.examId, { size: 6, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    expect(progress(id)).toEqual({ requested: 6, planned: 6, smaller: false, written: 6, pending: 0, short: null, coverage: { facts: 12, inThisExam: 6, tested: 0 } });
    answerAllRight(id);
    expect(progress(id).coverage).toEqual({ facts: 12, inThisExam: 6, tested: 6 });
  });

  it("a plan smaller than asked for is complete: planned < requested, nothing pending", async () => {
    const w = exam(1, 2); // four facts
    const id = startAttempt(w.examId, { size: 10, mode: "tutor", style: "recall", adaptive: false });
    await settled(id);
    expect(progress(id)).toEqual({ requested: 10, planned: 4, smaller: true, written: 4, pending: 0, short: null, coverage: { facts: 4, inThisExam: 4, tested: 0 } });
  });

  it("coverage counts every planned question, written or not, within the exam's scope", async () => {
    const { w, id } = await shortExam();
    expect(progress(id).coverage).toEqual({ facts: 12, inThisExam: 6, tested: 0 });
    // A scoped exam counts only its sections' facts.
    const scoped = startAttempt(w.examId, { size: 3, mode: "tutor", style: "recall", topicIds: [w.topicIds[1]], adaptive: false });
    await settled(scoped);
    expect(progress(scoped).coverage).toEqual({ facts: 6, inThisExam: 3, tested: 0 });
  });

  it("while the exam is first being written: written counts the planned questions written so far, nothing is short", async () => {
    const { id } = await shortExam();
    db.prepare("DELETE FROM attempt_questions WHERE attempt_id = ?").run(id);
    db.prepare("UPDATE attempts SET status = 'generating' WHERE id = ?").run(id);
    expect(progress(id)).toMatchObject({ requested: 6, planned: 6, written: 3, pending: 3, short: null });
  });

  it("case sets: the cases aimed for are a complete exam whatever their question count; fewer cases is smaller", async () => {
    const w = exam(2, 6); // 24 facts
    // Each written case keeps three questions: the rest leave the plan, and the exam is complete with fewer than asked.
    gen.answer = (slots, call, opts) => {
      const out = answerAll(slots, call, opts) as { cases: { questions: unknown[] }[] };
      out.cases.forEach((c) => (c.questions = c.questions.slice(0, 3)));
      return out;
    };
    const full = startAttempt(w.examId, { size: 9, mode: "tutor", style: "caseset", adaptive: false });
    await settled(full);
    expect(planOf(full).cases).toHaveLength(2); // round(9 / 4)
    expect(progress(full)).toMatchObject({ requested: 9, planned: 6, pending: 0, smaller: false });
    expect(smallerPlanLine(attemptView(full)!)).toBeNull();
    gen.answer = null;
    const small = exam(1, 2); // four facts: one case where five were aimed for
    const short = startAttempt(small.examId, { size: 20, mode: "tutor", style: "caseset", adaptive: false });
    await settled(short);
    expect(planOf(short).cases).toHaveLength(1);
    expect(progress(short)).toMatchObject({ requested: 20, smaller: true });
    expect(smallerPlanLine(attemptView(short)!)).toMatch(/^These lectures have material for \d+ questions, so this exam has \d+ \(you asked for 20\)\.$/);
  });

  it("an exam from before plans keeps working: all null or zero", () => {
    const w = exam(1, 1);
    const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(w.examId).lastInsertRowid);
    const q = Number(db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e')").run(w.examId, w.topicIds[0]).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 0)").run(id, q);
    const v = attemptView(id)!;
    expect(v.questions).toHaveLength(1);
    expect(progress(id)).toEqual({ requested: null, planned: null, smaller: false, written: 1, pending: 0, short: null, coverage: null });
  });
});

describe("copyExam", () => {
  it("carries fact keys over; a slide's key follows the slide", () => {
    const owner = apiReadyUser();
    const w = world({ userId: owner, sections: 1, slidesEach: 2, ready: true, notes: () => slideNotes() });
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id, fact_key) VALUES (?, ?, 'recall', ?, '[]', 0, 'e', ?, ?)");
    ins.run(w.examId, w.topicIds[0], "by fact", w.pageIds[0][0], factKey("a fact"));
    ins.run(w.examId, w.topicIds[0], "by slide", w.pageIds[0][1], `slide:${w.pageIds[0][1]}`);
    ins.run(w.examId, w.topicIds[0], "old", w.pageIds[0][0], null);
    ins.run(w.examId, w.topicIds[0], "gone slide", w.pageIds[0][0], "slide:987654");
    const classId = createClass(owner, "C");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    const mate = apiReadyUser();
    joinClass(mate, code);
    expect(shareExam(owner, classId, w.examId)).toBeNull();
    const shared = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(w.examId) as { id: number }).id;
    const res = addSharedExam(mate, shared) as { examId: number };
    const copy = db.prepare("SELECT stem, fact_key, source_page_id FROM questions WHERE exam_id = ? ORDER BY id").all(res.examId) as { stem: string; fact_key: string | null; source_page_id: number }[];
    const byStem = new Map(copy.map((q) => [q.stem, q]));
    expect(byStem.get("by fact")!.fact_key).toBe(factKey("a fact"));
    expect(byStem.get("by slide")!.fact_key).toBe(`slide:${byStem.get("by slide")!.source_page_id}`);
    expect(byStem.get("by slide")!.source_page_id).not.toBe(w.pageIds[0][1]);
    expect(byStem.get("old")!.fact_key).toBeNull();
    expect(byStem.get("gone slide")!.fact_key).toBeNull();
  });
});
