import { db } from "./db";
import { parseNotes } from "./processing";
import type { Confidence } from "./practicePlan";
import { isResuming, openSlots, type AttemptPlan, type ShortReason } from "./practice";
import { scoreContext } from "./readiness";
import { examCoverage, type ExamPlan } from "./examPlan";
import type { Scope } from "./practicePlan";

/**
 * How complete a planned exam is, for the line above the questions and the coverage line (docs/EXAM-PLAN.md "What
 * she sees"). Exams from before plans: requested, planned and coverage are null, pending is 0 and short is null.
 */
export type AttemptProgress = {
  /** How many questions she asked for. */
  requested: number | null;
  /** Planned questions (can be fewer than requested when the material runs out: that exam is complete). */
  planned: number | null;
  /** The plan is really smaller than asked (the material ran out), so the screens say so. Case sets plan whole cases
   *  of 3-5 questions, so theirs counts cases: fewer than the planner aims for (one per four questions asked). */
  smaller: boolean;
  /** Questions in the exam now. While it is first being written: the planned questions written so far (questions
   *  coming back as they were are not counted; they go in when the exam is ready). */
  written: number;
  /** Planned questions still to write (todo or failed). */
  pending: number;
  /** Why some are still missing, and whether they are being written right now. Null when none are missing. */
  short: null | { reason: ShortReason; writing: boolean };
  /** The material in scope: distinct facts, how many this exam's plan covers, how many she has been tested on. */
  coverage: { facts: number; inThisExam: number; tested: number } | null;
};

type Row = {
  question_id: number;
  position: number;
  chosen_index: number | null;
  correct: number | null;
  confidence: Confidence | null;
  option_order: string | null;
  type: "recall" | "case" | "image";
  topic_id: number | null;
  patient_box: string | null;
  stem: string;
  options: string;
  correct_index: number;
  explanation: string;
  image_page_id: number | null;
  source_page_id: number | null;
  flagged: number;
  case_id: number | null;
  scenario: string | null;
  topic_title: string | null;
  concept_name: string | null;
  source_filename: string | null;
  source_page_number: number | null;
  source_emphasized: number | null;
  source_aspect: number | null;
  option_notes: string | null;
};

/** The attempt as the student may see it: answers are only revealed when allowed. */
/** Stored option notes (JSON string[], original option order) in the shown order, or null when missing or malformed. */
export function optionNotes(json: string | null | undefined, order: number[]): string[] | null {
  if (!json) return null;
  try {
    const notes = JSON.parse(json) as unknown;
    if (!Array.isArray(notes) || notes.length !== order.length || !notes.every((n) => typeof n === "string")) return null;
    return order.map((i) => notes[i] as string);
  } catch {
    return null;
  }
}

export function attemptView(attemptId: number) {
  const attempt = db.prepare("SELECT a.*, e.name AS exam_name FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.id = ?").get(attemptId) as
    | {
        id: number;
        exam_id: number;
        exam_name: string;
        mode: "tutor" | "timed";
        status: string;
        error: string | null;
        time_limit_sec: number | null;
        score: number | null;
        adaptive: number;
        plan_json: string | null;
        started_at: string;
        requested: number | null;
        slots_json?: string | null;
        options_json?: string | null;
        short_reason: string | null;
        resumed_at: string | null;
      }
    | undefined;
  if (!attempt) return null;
  // The stored plan and start options are read here, never sent as they are (the options hold a hash of her key).
  const slotsJson = attempt.slots_json ?? null;
  const optionsJson = attempt.options_json ?? null;
  delete attempt.slots_json;
  delete attempt.options_json;
  const finished = attempt.status === "finished";
  const rows = db
    .prepare(
      `SELECT aq.question_id, aq.position, aq.chosen_index, aq.correct, aq.confidence, aq.option_order, q.*, t.title AS topic_title, c.name AS concept_name,
              d.filename AS source_filename, sp.page_number AS source_page_number, sp.emphasized AS source_emphasized, sp.aspect AS source_aspect
       , cs.scenario
       FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
       LEFT JOIN cases cs ON cs.id = q.case_id
       LEFT JOIN topics t ON t.id = q.topic_id LEFT JOIN concepts c ON c.id = q.concept_id
       LEFT JOIN pages sp ON sp.id = q.source_page_id LEFT JOIN documents d ON d.id = sp.document_id
       WHERE aq.attempt_id = ? AND aq.reported = 0 ORDER BY aq.position`,
    )
    .all(attemptId) as Row[];

  const imagePage = db.prepare("SELECT notes_json, aspect FROM pages WHERE id = ?");
  // Number the cases in the order they appear, and each question within its case.
  const caseNumber = new Map<number, number>();
  const caseSize = new Map<number, number>();
  for (const r of rows) {
    if (r.case_id == null) continue;
    if (!caseNumber.has(r.case_id)) caseNumber.set(r.case_id, caseNumber.size + 1);
    caseSize.set(r.case_id, (caseSize.get(r.case_id) ?? 0) + 1);
  }
  const seenInCase = new Map<number, number>();
  const questions = rows.map((r) => {
    const reveal = finished || (attempt.mode === "tutor" && r.chosen_index != null);
    let image: { page_id: number; aspect: number; crop: unknown } | null = null;
    if (r.image_page_id) {
      const p = imagePage.get(r.image_page_id) as { notes_json: string | null; aspect: number } | undefined;
      if (p) image = { page_id: r.image_page_id, aspect: p.aspect, crop: parseNotes(p)?.case_image_box ?? null };
    }
    const caseInfo =
      r.case_id != null
        ? (() => {
            const n = (seenInCase.get(r.case_id) ?? 0) + 1;
            seenInCase.set(r.case_id, n);
            return { number: caseNumber.get(r.case_id)!, index: n, size: caseSize.get(r.case_id)!, scenario: r.scenario ?? "" };
          })()
        : null;
    // Questions retried from an earlier exam show their options in a new order; indexes are stored in the original order.
    const options = JSON.parse(r.options) as string[];
    const order = r.option_order ? (JSON.parse(r.option_order) as number[]) : options.map((_, i) => i);
    const shown = (i: number | null) => (i == null ? null : order.indexOf(i));
    return {
      id: r.question_id,
      topic_id: r.topic_id,
      position: r.position,
      caseInfo,
      type: r.type,
      patient_box: r.patient_box ? (JSON.parse(r.patient_box) as Record<string, string>) : null,
      stem: r.stem,
      options: order.map((i) => options[i]),
      image,
      chosen_index: shown(r.chosen_index),
      confidence: r.confidence,
      retry: r.option_order != null,
      emphasized: !!r.source_emphasized,
      flagged: !!r.flagged,
      topic: r.topic_title,
      concept: r.concept_name,
      ...(reveal
        ? {
            correct_index: shown(r.correct_index)!,
            correct: r.correct === 1,
            explanation: r.explanation,
            // Per-option notes follow the display order (stored in the original order; retries show options reshuffled).
            option_notes: optionNotes(r.option_notes, order),
            source: r.source_page_id
              ? { page_id: r.source_page_id, filename: r.source_filename, page_number: r.source_page_number, aspect: r.source_aspect }
              : null,
          }
        : {}),
    };
  });
  return {
    attempt,
    questions,
    plan: attempt.plan_json ? (JSON.parse(attempt.plan_json) as AttemptPlan) : null,
    context: finished ? scoreContext(attemptId) : null,
    ...progress(attempt, slotsJson, optionsJson, questions.length),
  };
}

function progress(
  attempt: { id: number; exam_id: number; status: string; requested: number | null; short_reason: string | null },
  slotsJson: string | null,
  optionsJson: string | null,
  written: number,
): AttemptProgress {
  let plan: ExamPlan | null = null;
  let scope: Scope = { kind: "all" };
  try {
    plan = slotsJson ? (JSON.parse(slotsJson) as ExamPlan) : null;
    if (plan && !Array.isArray(plan.slots)) plan = null;
    const opts = optionsJson ? (JSON.parse(optionsJson) as { scope?: Scope }) : null;
    if (opts?.scope?.kind) scope = opts.scope;
  } catch {
    plan = null;
  }
  if (!plan) return { requested: attempt.requested ?? null, planned: null, smaller: false, written, pending: 0, short: null, coverage: null };
  const pending = openSlots(plan).length;
  // While the exam is first being written nothing is "missing" yet (the loading screen shows that), and nothing is in
  // the exam yet either: what has been written so far is what the planned questions say.
  const generating = attempt.status === "generating";
  const reason = attempt.short_reason as ShortReason | null;
  const short = !generating && pending > 0 && reason ? { reason, writing: isResuming(attempt.id) } : null;
  if (generating) written = plan.slots.filter((s) => s.state === "done" && s.why !== "retry" && s.why !== "unused").length;
  // The coverage line counts what the exam plans to cover, whatever each planned question's state.
  const c = examCoverage(attempt.exam_id, scope, plan.slots);
  const requested = attempt.requested ?? null;
  // As planCaseSet in lib/examPlan.ts: it aims for one case per four questions asked.
  const smaller =
    requested != null &&
    (plan.style === "caseset" ? (Array.isArray(plan.cases) ? plan.cases.length : 0) < Math.max(1, Math.round(requested / 4)) : plan.slots.length < requested);
  return {
    requested,
    planned: plan.slots.length,
    smaller,
    written,
    pending,
    short,
    coverage: { facts: c.facts, inThisExam: c.inThisExam ?? 0, tested: c.tested },
  };
}

export type AttemptView = NonNullable<ReturnType<typeof attemptView>>;
