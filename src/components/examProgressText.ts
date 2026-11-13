// Every sentence about a planned practice exam's progress and coverage (docs/EXAM-PLAN.md "What she sees"), in one
// place so the exam screen, the writing screen, the results and the exam page say the same thing the same way.
// Pure: no React, no database.

/**
 * The attempt fields these sentences read. Declared here rather than imported from lib/attemptView: attempts made
 * before the exam plan (and servers that have not been updated yet) do not send them, so every one may be missing.
 */
export type PlanFields = {
  requested?: number | null;
  planned?: number | null;
  /** The server's word on whether the plan is really smaller than asked (case sets count cases). Absent: compare numbers. */
  smaller?: boolean | null;
  written?: number | null;
  pending?: number | null;
  short?: { reason: "key" | "busy" | "interrupted" | string; writing: boolean } | null;
  coverage?: { facts: number; inThisExam?: number | null; tested: number } | null;
};

/** The plan fields of an attempt view, each null (or 0) when absent, so the screens never read undefined. */
export function planFields(view: PlanFields | object) {
  const v = view as PlanFields;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    requested: num(v.requested),
    planned: num(v.planned),
    smaller: typeof v.smaller === "boolean" ? v.smaller : null,
    written: num(v.written),
    pending: Math.max(0, num(v.pending) ?? 0),
    short: v.short && typeof v.short === "object" ? v.short : null,
    coverage: v.coverage && typeof v.coverage === "object" && num(v.coverage.facts) != null ? v.coverage : null,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where the key sentence sends her (the screen turns this word into a link). */
export const SETTINGS_WORD = "Settings";

/**
 * The line above the questions while some are still to be written, or null when the exam is complete. `settings`
 * says the sentence asks her to fix her key (the screen links the word "Settings").
 */
export function progressLine(v: PlanFields | object): { text: string; settings: boolean } | null {
  const f = planFields(v);
  if (f.pending <= 0) return null;
  const written = f.written ?? 0;
  const total = f.planned ?? f.requested ?? written + f.pending;
  const head = `${written} of ${plural(total, "question")} so far.`;
  if (f.short?.writing || !f.short) return { text: `${head} The rest are being written and will appear at the end.`, settings: false };
  if (f.short.reason === "key")
    return {
      text: `${head} Your AI key couldn't write the rest (a credit or key problem). Fix it in ${SETTINGS_WORD} and the rest are written when you come back.`,
      settings: true,
    };
  return { text: `${head} The rest will be written shortly.`, settings: false };
}

/**
 * When the lectures hold less than she asked for: a complete exam, smaller than asked. Null otherwise. The server says
 * whether the shortfall is real (`smaller`: a case set naturally plans a few questions more or less than asked, as its
 * cases hold 3-5 each); a view without it compares the numbers.
 */
export function smallerPlanLine(v: PlanFields | object): string | null {
  const { planned, requested, smaller } = planFields(v);
  if (smaller === false) return null;
  if (planned == null || requested == null || planned <= 0 || planned >= requested) return null;
  return `These lectures have material for ${plural(planned, "question")}, so this exam has ${planned} (you asked for ${requested}).`;
}

/** The exam screen and the results: what this exam covers and how much she has been tested on. Null without facts. */
export function coverageLine(v: PlanFields | object): string | null {
  const c = planFields(v).coverage;
  if (!c || c.facts <= 0) return null;
  if (c.tested >= c.facts) return c.facts === 1 ? "You have been tested on the 1 fact in these lectures." : `You have been tested on all ${c.facts} facts in these lectures.`;
  const of = `of the ${plural(c.facts, "fact")} in these lectures`;
  if (c.inThisExam == null) return `You have been tested on ${c.tested} ${of}.`;
  return `This exam covers ${c.inThisExam} ${of}. You have been tested on ${c.tested} so far.`;
}

/** The exam page's practice card: how much of the whole exam she has been tested on. Null without facts. */
export function examCoverageLine(c: { facts: number; tested: number } | null | undefined): string | null {
  if (!c || !(c.facts > 0)) return null;
  if (c.tested >= c.facts) return c.facts === 1 ? "You have been tested on the 1 fact in this exam's lectures." : `You have been tested on all ${c.facts} facts in this exam's lectures.`;
  return `You have been tested on ${c.tested} of the ${plural(c.facts, "fact")} in this exam's lectures.`;
}

/** The writing screen's first step once a plan exists: "Planned 40 questions across 8 sections". */
export function plannedStep(planned: number, sections: number | null | undefined): string {
  return `Planned ${plural(planned, "question")}${sections && sections > 0 ? ` across ${plural(sections, "section")}` : ""}`;
}

/** The writing screen's step while writing: "12 written so far", or the plain step before the first is written. */
export function writtenStep(written: number | null | undefined): string {
  return written && written > 0 ? `Writing from your slides · ${written} written so far` : "Writing the questions from your slides";
}

/** The toast when questions are appended at the end. */
export function addedToast(n: number): string {
  return n === 1 ? "1 more question was added at the end" : `${n} more questions were added at the end`;
}

/** The finish confirm's extra sentence while questions are still to be written, or null. */
export function finishPendingLine(pending: number): string | null {
  if (!(pending > 0)) return null;
  return pending === 1
    ? "1 question is still being written and won't be in this exam if you finish now."
    : `${pending} questions are still being written and won't be in this exam if you finish now.`;
}

/** Takes the progress line's place once the last question is in (so the questions below don't move up). */
export function completeLine(n: number): string {
  return n === 1 ? "The 1 question is in." : `All ${n} questions are in.`;
}
