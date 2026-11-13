// One check for every multiple-choice question an AI writer returns (practice exams, case sets, "quiz me", and the
// section quiz), so the rules can't drift apart between writers. A question either comes back cleaned up and with its
// options shuffled, or it is dropped with a short reason (for the logs and the tests).
import { shuffle } from "./practicePlan";
import { normStem } from "./quizPlan";

/** A question as a writer returns it. The question text is `stem` (practice, case sets) or `question` (quizzes). */
export type RawMcq = {
  stem?: unknown;
  question?: unknown;
  options?: unknown;
  correct_index?: unknown;
  correct_answer?: unknown;
  option_notes?: unknown;
  source_page_id?: unknown;
};

export type McqRules = {
  /** How many options the writer was told to give: anything else is dropped. */
  optionCount: number;
  /** The slides the question may cite. A source slide outside them is cleared (or, with requireSource, drops the question). */
  validPageIds?: ReadonlySet<number>;
  /** The question must cite one of validPageIds. Ignored when there are none (a section without slides). */
  requireSource?: boolean;
  /** Shuffle the options so the answer isn't always in one place (default true). Notes move with their options. */
  shuffle?: boolean;
};

export type ValidMcq = {
  stem: string;
  options: string[];
  correct_index: number;
  /** One note per option in display order, or null when the writer's list didn't fit (the question is kept). */
  option_notes: string[] | null;
  source_page_id: number | null;
  /** order[k] is the writer's index of the option shown at k, to carry anything else that is per option. */
  order: number[];
};

/** Options count as the same when they differ only in case or spacing. */
const optionKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Check one AI-written question. Returns the cleaned question, or a reason string when it can't be used:
 * - the question text is blank;
 * - not exactly `optionCount` options, or any blank or repeated (ignoring case and spacing);
 * - correct_index is not a whole number in range;
 * - the writer also gave the answer as text and it matches no option, or matches a different option than the index
 *   (the writer contradicted itself: which one is right can't be known);
 * - with `requireSource`, the source slide is not one of the valid slides.
 * Option notes that are not one non-blank note per option are dropped, never the question.
 */
export function validateMcq(raw: RawMcq, rules: McqRules): ValidMcq | string {
  const text = typeof raw.stem === "string" ? raw.stem : raw.question;
  const stem = typeof text === "string" ? text.trim() : "";
  if (!stem) return "blank question";

  if (!Array.isArray(raw.options)) return "no options";
  if (raw.options.length !== rules.optionCount) return `${raw.options.length} options instead of ${rules.optionCount}`;
  if (!raw.options.every((o) => typeof o === "string")) return "an option is not text";
  const options = (raw.options as string[]).map((o) => o.trim());
  if (options.some((o) => !o)) return "a blank option";
  if (new Set(options.map(optionKey)).size !== options.length) return "repeated options";

  const correct = raw.correct_index;
  if (typeof correct !== "number" || !Number.isInteger(correct) || correct < 0 || correct >= options.length) return "answer index out of range";

  if (typeof raw.correct_answer === "string" && normStem(raw.correct_answer)) {
    const target = normStem(raw.correct_answer);
    const matches = options.map((o, i) => (normStem(o) === target ? i : -1)).filter((i) => i !== -1);
    if (matches.length === 0) return "answer text matches no option";
    if (!matches.includes(correct)) return "answer text and index disagree";
  }

  const notesIn = raw.option_notes;
  const notes =
    Array.isArray(notesIn) && notesIn.length === options.length && notesIn.every((n) => typeof n === "string" && n.trim()) ? (notesIn as string[]).map((n) => n.trim()) : null;

  const cited = typeof raw.source_page_id === "number" && Number.isInteger(raw.source_page_id) ? raw.source_page_id : null;
  const source = cited != null && (!rules.validPageIds || rules.validPageIds.has(cited)) ? cited : null;
  if (rules.requireSource && rules.validPageIds && rules.validPageIds.size > 0 && source == null) return "not from one of the given slides";

  const order = rules.shuffle === false ? options.map((_, i) => i) : shuffle(options.map((_, i) => i));
  return {
    stem,
    options: order.map((i) => options[i]),
    correct_index: order.indexOf(correct),
    option_notes: notes ? order.map((i) => notes[i]) : null,
    source_page_id: source,
    order,
  };
}
