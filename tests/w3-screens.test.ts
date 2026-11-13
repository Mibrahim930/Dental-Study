// Wave 3, the screens for planned practice exams (docs/EXAM-PLAN.md "What she sees"): every sentence and its edge
// cases (components/examProgressText.ts), the merge that folds a poll into the exam on screen (mergeAttempt), and the
// exam page's coverage numbers (loadExamPage).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async () => {
    throw new Error("no AI in screen tests");
  }),
}));

import { db } from "@/lib/db";
import { factKey } from "@/lib/examPlan";
import { loadExamPage } from "@/lib/examPage";
import {
  addedToast,
  completeLine,
  coverageLine,
  examCoverageLine,
  finishPendingLine,
  planFields,
  plannedStep,
  progressLine,
  smallerPlanLine,
  writtenStep,
} from "@/components/examProgressText";
import { addedCount, mergeAttempt } from "@/app/attempts/[id]/mergeAttempt";
import { slideNotes, world } from "./helpers";

describe("progressLine (above the questions while some are still being written)", () => {
  it("writing now", () => {
    expect(progressLine({ planned: 100, requested: 100, written: 23, pending: 77, short: { reason: "busy", writing: true } })).toEqual({
      text: "23 of 100 questions so far. The rest are being written and will appear at the end.",
      settings: false,
    });
  });
  it("key problem, not writing: points to Settings", () => {
    expect(progressLine({ planned: 100, written: 23, pending: 77, short: { reason: "key", writing: false } })).toEqual({
      text: "23 of 100 questions so far. Your AI key couldn't write the rest (a credit or key problem). Fix it in Settings and the rest are written when you come back.",
      settings: true,
    });
  });
  it("busy or interrupted, not writing", () => {
    for (const reason of ["busy", "interrupted"] as const)
      expect(progressLine({ planned: 100, written: 23, pending: 77, short: { reason, writing: false } })?.text).toBe("23 of 100 questions so far. The rest will be written shortly.");
  });
  it("a key problem being retried right now reads as writing", () => {
    expect(progressLine({ planned: 10, written: 3, pending: 7, short: { reason: "key", writing: true } })?.settings).toBe(false);
  });
  it("pending but no `short` sent: being written", () => {
    expect(progressLine({ planned: 10, written: 3, pending: 7 })?.text).toBe("3 of 10 questions so far. The rest are being written and will appear at the end.");
  });
  it("the total is planned, else requested, else written + pending", () => {
    const s = { reason: "busy", writing: false } as const;
    expect(progressLine({ planned: 30, requested: 100, written: 5, pending: 25, short: s })?.text).toMatch(/^5 of 30 questions/);
    expect(progressLine({ planned: null, requested: 40, written: 5, pending: 25, short: s })?.text).toMatch(/^5 of 40 questions/);
    expect(progressLine({ written: 5, pending: 25, short: s })?.text).toMatch(/^5 of 30 questions/);
  });
  it("singular, zero written, and nothing when complete or the fields are absent", () => {
    expect(progressLine({ planned: 1, written: 0, pending: 1, short: { reason: "busy", writing: false } })?.text).toBe("0 of 1 question so far. The rest will be written shortly.");
    expect(progressLine({ pending: 1 })?.text).toMatch(/^0 of 1 question so far/);
    expect(progressLine({ planned: 10, written: 10, pending: 0, short: null })).toBeNull();
    expect(progressLine({})).toBeNull();
    expect(progressLine({ pending: -3 })).toBeNull();
  });
});

describe("smallerPlanLine (the lectures hold less than she asked for)", () => {
  it("planned < requested", () => {
    expect(smallerPlanLine({ planned: 30, requested: 100 })).toBe("These lectures have material for 30 questions, so this exam has 30 (you asked for 100).");
    expect(smallerPlanLine({ planned: 1, requested: 25 })).toBe("These lectures have material for 1 question, so this exam has 1 (you asked for 25).");
  });
  it("nothing when the plan is as asked, larger, empty, or either number is missing (old exams)", () => {
    expect(smallerPlanLine({ planned: 100, requested: 100 })).toBeNull();
    expect(smallerPlanLine({ planned: 101, requested: 100 })).toBeNull();
    expect(smallerPlanLine({ planned: 0, requested: 100 })).toBeNull();
    expect(smallerPlanLine({ planned: 30, requested: null })).toBeNull();
    expect(smallerPlanLine({ requested: 30 })).toBeNull();
    expect(smallerPlanLine({})).toBeNull();
  });

  it("follows the server's `smaller` when the view has it (case sets plan whole cases, a few questions off what was asked)", () => {
    expect(smallerPlanLine({ planned: 24, requested: 25, smaller: false })).toBeNull();
    expect(smallerPlanLine({ planned: 12, requested: 25, smaller: true })).toBe("These lectures have material for 12 questions, so this exam has 12 (you asked for 25).");
    // Never a sentence that contradicts itself, whatever the flag says.
    expect(smallerPlanLine({ planned: 27, requested: 25, smaller: true })).toBeNull();
    // Absent or not a boolean: the numbers decide, as before.
    expect(smallerPlanLine({ planned: 24, requested: 25 })).not.toBeNull();
    expect(smallerPlanLine({ planned: 24, requested: 25, smaller: null })).not.toBeNull();
    expect(planFields({ smaller: "yes" }).smaller).toBeNull();
  });
});

describe("coverageLine (exam screen and results)", () => {
  it("covers some, tested on some", () => {
    expect(coverageLine({ coverage: { facts: 212, inThisExam: 40, tested: 96 } })).toBe("This exam covers 40 of the 212 facts in these lectures. You have been tested on 96 so far.");
    expect(coverageLine({ coverage: { facts: 212, inThisExam: 0, tested: 0 } })).toBe("This exam covers 0 of the 212 facts in these lectures. You have been tested on 0 so far.");
  });
  it("tested on everything (and more, when counts overlap)", () => {
    expect(coverageLine({ coverage: { facts: 212, inThisExam: 40, tested: 212 } })).toBe("You have been tested on all 212 facts in these lectures.");
    expect(coverageLine({ coverage: { facts: 5, inThisExam: 5, tested: 7 } })).toBe("You have been tested on all 5 facts in these lectures.");
    expect(coverageLine({ coverage: { facts: 1, inThisExam: 1, tested: 1 } })).toBe("You have been tested on the 1 fact in these lectures.");
  });
  it("one fact, untested", () => {
    expect(coverageLine({ coverage: { facts: 1, inThisExam: 1, tested: 0 } })).toBe("This exam covers 1 of the 1 fact in these lectures. You have been tested on 0 so far.");
  });
  it("without inThisExam: only how much she has been tested on", () => {
    expect(coverageLine({ coverage: { facts: 12, tested: 3 } })).toBe("You have been tested on 3 of the 12 facts in these lectures.");
  });
  it("nothing without facts or coverage", () => {
    expect(coverageLine({ coverage: { facts: 0, inThisExam: 0, tested: 0 } })).toBeNull();
    expect(coverageLine({ coverage: null })).toBeNull();
    expect(coverageLine({})).toBeNull();
  });
});

describe("examCoverageLine (exam page practice card)", () => {
  it("some, all, one, none", () => {
    expect(examCoverageLine({ facts: 212, tested: 96 })).toBe("You have been tested on 96 of the 212 facts in this exam's lectures.");
    expect(examCoverageLine({ facts: 212, tested: 0 })).toBe("You have been tested on 0 of the 212 facts in this exam's lectures.");
    expect(examCoverageLine({ facts: 212, tested: 212 })).toBe("You have been tested on all 212 facts in this exam's lectures.");
    expect(examCoverageLine({ facts: 1, tested: 0 })).toBe("You have been tested on 0 of the 1 fact in this exam's lectures.");
    expect(examCoverageLine({ facts: 1, tested: 1 })).toBe("You have been tested on the 1 fact in this exam's lectures.");
    expect(examCoverageLine({ facts: 0, tested: 0 })).toBeNull();
    expect(examCoverageLine(null)).toBeNull();
    expect(examCoverageLine(undefined)).toBeNull();
  });
});

describe("the other sentences", () => {
  it("writing screen steps", () => {
    expect(plannedStep(40, 8)).toBe("Planned 40 questions across 8 sections");
    expect(plannedStep(1, 1)).toBe("Planned 1 question across 1 section");
    expect(plannedStep(12, null)).toBe("Planned 12 questions");
    expect(plannedStep(12, 0)).toBe("Planned 12 questions");
    expect(writtenStep(12)).toBe("Writing from your slides · 12 written so far");
    expect(writtenStep(0)).toBe("Writing the questions from your slides");
    expect(writtenStep(undefined)).toBe("Writing the questions from your slides");
  });
  it("toast, finish confirm, complete", () => {
    expect(addedToast(1)).toBe("1 more question was added at the end");
    expect(addedToast(12)).toBe("12 more questions were added at the end");
    expect(finishPendingLine(1)).toBe("1 question is still being written and won't be in this exam if you finish now.");
    expect(finishPendingLine(77)).toBe("77 questions are still being written and won't be in this exam if you finish now.");
    expect(finishPendingLine(0)).toBeNull();
    expect(completeLine(1)).toBe("The 1 question is in.");
    expect(completeLine(30)).toBe("All 30 questions are in.");
  });
  it("planFields reads an old attempt (no plan fields) as nothing pending", () => {
    expect(planFields({ attempt: {}, questions: [] })).toEqual({ requested: null, planned: null, smaller: null, written: null, pending: 0, short: null, coverage: null });
    expect(planFields({ pending: "3", coverage: { tested: 1 } })).toMatchObject({ pending: 0, coverage: null });
  });
});

// ---- mergeAttempt ----

type Q = { id: number; position: number; chosen_index: number | null; stem?: string };
type V = { attempt: { status: string; time_limit_sec: number | null; started_at?: string }; questions: Q[]; pending?: number; written?: number; plan?: unknown };
const q = (id: number, position: number, chosen_index: number | null = null): Q => ({ id, position, chosen_index, stem: `s${id}` });
const view = (questions: Q[], o: Partial<V> = {}, attempt: Partial<V["attempt"]> = {}): V => ({
  attempt: { status: "ready", time_limit_sec: null, started_at: "2026-11-13 10:00:00", ...attempt },
  questions,
  pending: 0,
  written: questions.length,
  plan: { style: "mixed", topics: 2 },
  ...o,
});

describe("mergeAttempt", () => {
  it("identical views (or an equal copy) give back the same object: no re-render", () => {
    const old = view([q(1, 0, 1), q(2, 1)], { pending: 3 });
    expect(mergeAttempt(old, old)).toBe(old);
    expect(mergeAttempt(old, structuredClone(old))).toBe(old);
  });

  it("appended questions go at the end, in order; the ones on screen keep their objects", () => {
    const old = view([q(1, 0, 1), q(2, 1)], { pending: 3, written: 2 });
    const fresh = view([q(1, 0, 1), q(2, 1), q(9, 4), q(7, 2), q(8, 3)], { pending: 0, written: 5 });
    const m = mergeAttempt(old, structuredClone(fresh));
    expect(m.questions.map((x) => x.id)).toEqual([1, 2, 7, 8, 9]);
    expect(m.questions[0]).toBe(old.questions[0]);
    expect(m.questions[1]).toBe(old.questions[1]);
    expect(m.pending).toBe(0);
    expect(m.written).toBe(5);
    expect(m.plan).toBe(old.plan);
    expect(addedCount(old, m)).toBe(3);
  });

  it("an answer she locked in is not undone by a poll sent before it", () => {
    const old = view([q(1, 0, 2), q(2, 1)], { pending: 1 });
    const stale = view([q(1, 0, null), q(2, 1), q(3, 2)], { pending: 0 });
    const m = mergeAttempt(old, stale);
    expect(m.questions[0]).toBe(old.questions[0]);
    expect(m.questions[0].chosen_index).toBe(2);
    expect(m.questions.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("the reply to an answer brings that answer in", () => {
    const old = view([q(1, 0), q(2, 1)]);
    const reply = view([q(1, 0, 3), q(2, 1)]);
    const m = mergeAttempt(old, reply);
    expect(m.questions[0].chosen_index).toBe(3);
    expect(m.questions[1]).toBe(old.questions[1]);
  });

  it("a question reported meanwhile stays out: one in the middle of a late poll, and one named in `gone`", () => {
    const old = view([q(1, 0), q(3, 2)], { pending: 2 }); // 2 (position 1) was reported here
    const late = view([q(1, 0), q(2, 1), q(3, 2), q(4, 3)], { pending: 1 });
    expect(mergeAttempt(old, late).questions.map((x) => x.id)).toEqual([1, 3, 4]);
    // The reply to her report still lists 3 (sent before it); `gone` takes it out of the screen too.
    const m = mergeAttempt(old, late, new Set([2, 3]));
    expect(m.questions.map((x) => x.id)).toEqual([1, 4]);
    // Everything reported, then a late poll: nothing comes back but what is new.
    const empty = view([], { pending: 1 });
    expect(mergeAttempt(empty, view([q(1, 0), q(5, 4)]), new Set([1])).questions.map((x) => x.id)).toEqual([5]);
  });

  it("a timed exam's limit grows with appended questions and never shrinks on a late poll", () => {
    const old = view([q(1, 0)], { pending: 2 }, { time_limit_sec: 600 });
    const grown = mergeAttempt(old, view([q(1, 0), q(2, 1)], { pending: 1 }, { time_limit_sec: 690 }));
    expect(grown.attempt.time_limit_sec).toBe(690);
    expect(grown.attempt.started_at).toBe(old.attempt.started_at);
    const late = mergeAttempt(grown, view([q(1, 0), q(2, 1)], { pending: 1 }, { time_limit_sec: 600 }));
    expect(late.attempt.time_limit_sec).toBe(690);
    expect(late).toBe(grown);
    // An untimed exam stays untimed.
    expect(mergeAttempt(view([q(1, 0)]), view([q(1, 0), q(2, 1)])).attempt.time_limit_sec).toBeNull();
  });

  it("finished stays finished; finishing and the end of writing are taken whole", () => {
    const done = view([q(1, 0, 1)], {}, { status: "finished" });
    expect(mergeAttempt(done, view([q(1, 0, 1), q(2, 1)]))).toBe(done);
    const open = view([q(1, 0, 1)]);
    const finished = view([q(1, 0, 1)], {}, { status: "finished" });
    expect(mergeAttempt(open, finished)).toBe(finished);
    const writing = view([], { pending: 5 }, { status: "generating" });
    const ready = view([q(1, 0), q(2, 1)], { pending: 0 });
    expect(mergeAttempt(writing, ready)).toBe(ready);
    expect(addedCount(writing, ready)).toBe(2);
  });

  it("a field the new server no longer sends is dropped, one it newly sends is taken", () => {
    const old = view([q(1, 0)], { pending: 1 });
    const fresh = { ...view([q(1, 0)]), pending: undefined } as V;
    delete fresh.pending;
    const m = mergeAttempt(old, fresh);
    expect(m).not.toBe(old);
    expect("pending" in m).toBe(false);
    const withCoverage = { ...view([q(1, 0)], { pending: 1 }), coverage: { facts: 3, tested: 1, inThisExam: 2 } } as V;
    expect((mergeAttempt(old, withCoverage) as V & { coverage?: unknown }).coverage).toEqual({ facts: 3, tested: 1, inThisExam: 2 });
  });
});

// ---- loadExamPage coverage ----

describe("loadExamPage: coverage for the whole exam", () => {
  it("counts the facts in the exam's lectures and how many she has been tested on", () => {
    const w = world({ sections: 2, slidesEach: 2, notes: (n) => slideNotes({ key_facts: [`f${n}a`, `f${n}b`] }) });
    expect(loadExamPage(w.userId, w.examId)!.coverage).toEqual({ facts: 8, tested: 0, right: 0 });
    // One question written for f1a, answered wrong in a finished exam: one fact tested.
    const qid = Number(
      db
        .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id, fact_key) VALUES (?, ?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e', ?, ?)")
        .run(w.examId, w.topicIds[0], w.pageIds[0][0], factKey("f1a")).lastInsertRowid,
    );
    const a = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(w.examId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, 0, 1, 0)").run(a, qid);
    const c = loadExamPage(w.userId, w.examId)!.coverage;
    expect(c).toEqual({ facts: 8, tested: 1, right: 0 });
    expect(examCoverageLine(c)).toBe("You have been tested on 1 of the 8 facts in this exam's lectures.");
  });

  it("is null for an exam without sections yet", () => {
    const w = world({ sections: [] });
    expect(loadExamPage(w.userId, w.examId)!.coverage).toBeNull();
  });
});
