// Planning a section quiz before the AI writes it: which slide each question tests and from what angle.
// Pure (no database, no AI), so the coverage rules can be tested directly.

/** How a question approaches its slide. "not" ("which is NOT…") is only used for slides that are lists. */
export type Angle = "recall" | "apply" | "compare" | "not";

export type PlanSlide = {
  id: number;
  /** Number of testable facts on the slide. */
  keyFacts: number;
  /** The professor stressed it (★). */
  emphasized: boolean;
  /** The slide poses a clinical case. */
  hasCase: boolean;
};

export type Slot = { page: number | null; angle: Angle };

/** A slide with several separate facts reads as a list, so a "which is NOT" question is fair. */
const isList = (s: PlanSlide) => s.keyFacts >= 4;

/** The angles a slide's questions take, in turn: a case slide starts with applying it. */
function angles(s: PlanSlide): Angle[] {
  const base: Angle[] = s.hasCase ? ["apply", "recall", "compare"] : ["recall", "apply", "compare"];
  return isList(s) ? [...base, "not"] : base;
}

/** Most important first: stressed by the professor, then clinical cases, then the most facts, then slide order. */
function byImportance(slides: PlanSlide[]): PlanSlide[] {
  return slides
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(b.s.emphasized) - Number(a.s.emphasized) || Number(b.s.hasCase) - Number(a.s.hasCase) || b.s.keyFacts - a.s.keyFacts || a.i - b.i)
    .map((x) => x.s);
}

/**
 * Exactly `size` question slots over the slides, in slide order:
 * - fewer slides than slots: every slide gets one question; the extra slots go to the slides with the most to test
 *   (stressed slides count double), each new question on a slide taking a different angle;
 * - more slides than slots: the `size` most important slides get one question each.
 * With no slides at all, the slots test the topic in general (page null).
 */
export function planQuiz(slides: PlanSlide[], size: number): Slot[] {
  if (size <= 0) return [];
  if (slides.length === 0) return Array.from({ length: size }, (_, i) => ({ page: null, angle: (["recall", "apply", "compare"] as Angle[])[i % 3] }));

  const counts = new Map<number, number>();
  if (slides.length >= size) {
    for (const s of byImportance(slides).slice(0, size)) counts.set(s.id, 1);
  } else {
    for (const s of slides) counts.set(s.id, 1);
    const weight = (s: PlanSlide) => (s.emphasized ? 2 : 1) * (1 + s.keyFacts) + (s.hasCase ? 1 : 0);
    const ranked = byImportance(slides);
    for (let left = size - slides.length; left > 0; left--) {
      // Highest weight per question already planned wins the next slot (ties: more important slide).
      let best = ranked[0];
      for (const s of ranked) if (weight(s) / (counts.get(s.id)! + 1) > weight(best) / (counts.get(best.id)! + 1)) best = s;
      counts.set(best.id, counts.get(best.id)! + 1);
    }
  }

  const out: Slot[] = [];
  for (const s of slides) {
    const n = counts.get(s.id) ?? 0;
    const a = angles(s);
    for (let k = 0; k < n; k++) out.push({ page: s.id, angle: a[k % a.length] });
  }
  return out;
}

/** Normalised question text, to spot the same question written twice. */
export const normStem = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const ANGLE_TEXT: Record<Angle, string> = {
  recall: "recall of a key fact",
  apply: "apply it: a short clinical vignette or 'which finding / next step'",
  compare: "compare or distinguish it from a related item on the slides",
  not: "'which is NOT …' over the slide's list",
};
