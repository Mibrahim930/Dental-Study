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

// ---- Fact-based planning (Release 3) ----
// A section quiz has about one question per distinct fact on its slides, never the same fact twice: a short section
// gets a short quiz instead of the same three facts asked seven ways.

/** A slide with the facts its notes list. */
export type FactSlide = PlanSlide & { facts: string[] };

/** One planned question: the slide, the exact fact it must test (null = the slide in general), and the angle. */
export type FactSlot = { page: number | null; fact: string | null; angle: Angle };

/**
 * How many questions a section quiz has: one per distinct fact across its slides (a slide with no listed facts counts
 * as one), at least one. No floor and no cap: a section with little material gets a short quiz, and a big one is covered
 * whole (padding a small section used to make the writer repeat itself).
 */
export function quizSize(slides: Pick<FactSlide, "facts">[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const s of slides) {
    const facts = s.facts.map(normStem).filter(Boolean);
    if (facts.length === 0) n++;
    for (const f of facts) {
      if (seen.has(f)) continue;
      seen.add(f);
      n++;
    }
  }
  return Math.max(1, n);
}

/**
 * One slot per distinct fact, in slide order (facts in the order the slide lists them). A smaller `size` keeps the most
 * important facts (professor-stressed slides first, then case slides, then slide order). Never more slots than facts:
 * extra slots with no fact pinned only made the writer repeat itself.
 */
export function planQuizByFacts(slides: FactSlide[], size = quizSize(slides)): FactSlot[] {
  if (size <= 0) return [];
  if (slides.length === 0) {
    return Array.from({ length: size }, (_, i) => ({ page: null, fact: null, angle: (["recall", "apply", "compare"] as Angle[])[i % 3] }));
  }

  // Every distinct fact once, remembering which slide first listed it.
  const seen = new Set<string>();
  const all: { slide: FactSlide; fact: string | null }[] = [];
  for (const s of slides) {
    // Whitespace collapsed (a fact is one line in the writer's plan); a fact repeated on this or an earlier slide, or one
    // that is only punctuation, is not a slot.
    const facts: string[] = [];
    let listed = 0; // real facts on this slide, repeats included
    for (const raw of s.facts) {
      const f = raw.replace(/\s+/g, " ").trim();
      const key = normStem(f);
      if (!key) continue;
      listed++;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(f);
    }
    // A slide with no real facts is tested in general (one slot). A recap slide whose facts all repeat earlier slides
    // adds nothing: its facts already have their slots (quizSize counts it the same way).
    if (facts.length === 0) {
      if (listed === 0) all.push({ slide: s, fact: null });
      continue;
    }
    for (const f of facts) all.push({ slide: s, fact: f });
  }

  let chosen = all;
  if (all.length > size) {
    // Keep the `size` most important (stressed slides first, then case slides, then slide order), back in slide order.
    const rank = (x: (typeof all)[number]) => (x.slide.emphasized ? 0 : 2) + (x.slide.hasCase ? 0 : 1);
    chosen = all
      .map((x, i) => ({ x, i }))
      .sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i)
      .slice(0, size)
      .sort((a, b) => a.i - b.i)
      .map((a) => a.x);
  }

  // Vary the angle so a quiz isn't all recall: every second fact is applied, every third compared; case slides apply.
  const slots: FactSlot[] = chosen.map((x, i) => ({
    page: x.slide.id,
    fact: x.fact,
    angle: x.slide.hasCase ? "apply" : i % 3 === 1 ? "apply" : i % 3 === 2 ? "compare" : "recall",
  }));

  return slots;
}

/** Normalised question text, to spot the same question written twice. */
export const normStem = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const ANGLE_TEXT: Record<Angle, string> = {
  recall: "recall of a key fact",
  apply: "apply it: a short clinical vignette or 'which finding / next step'",
  compare: "compare or distinguish it from a related item on the slides",
  not: "'which is NOT …' over the slide's list",
};
