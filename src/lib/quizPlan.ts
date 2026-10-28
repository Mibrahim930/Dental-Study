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

/**
 * One planned question: the slide, the fact(s) it must test, and the angle. `facts` is empty for "the slide in
 * general"; with several facts the writer makes one question that needs all of them. `fact` is the first of them (or
 * null), kept for the single-fact case. `pages` lists every slide the facts come from when a slot spans two.
 */
export type FactSlot = { page: number | null; pages?: number[]; fact: string | null; facts: string[]; angle: Angle };

/** The most questions a section quiz has: a denser section condenses several facts into one question. */
export const QUIZ_MAX = 25;

/** Distinct facts across the slides (a slide with no listed facts counts as one), at least one. */
export function distinctFacts(slides: Pick<FactSlide, "facts">[]): number {
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
 * How many questions a section quiz has: one per distinct fact, up to QUIZ_MAX. No floor (a section with little
 * material gets a short quiz; padding made the writer repeat itself). Past the cap the material is still covered whole:
 * the planner condenses it, several related facts to a question, so a dense section is 25 questions, not 48.
 */
export function quizSize(slides: Pick<FactSlide, "facts">[]): number {
  return Math.min(QUIZ_MAX, distinctFacts(slides));
}

type Entry = { slide: FactSlide; fact: string | null };

/** `n` consecutive chunks of a list, as even as possible, in order. */
function chunks<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  const size = list.length / n;
  for (let i = 0; i < n; i++) out.push(list.slice(Math.round(i * size), Math.round((i + 1) * size)));
  return out.filter((c) => c.length > 0);
}

/**
 * The plan: every distinct fact once, in slide order (facts in the order the slide lists them), one slot each when they
 * fit in `size`. When there are more facts than slots, the facts are condensed, not dropped: each slide gets slots in
 * proportion to its facts (at least one), and a slot holding several facts asks for one question that needs all of
 * them. A section with more fact-bearing slides than slots condenses across neighbouring slides instead.
 * `mode: "cut"` keeps the old behaviour for a smaller size: the most important facts survive (professor-stressed
 * slides first, then case slides, then slide order), the rest are left out.
 */
export function planQuizByFacts(slides: FactSlide[], size = quizSize(slides), mode: "condense" | "cut" = "condense"): FactSlot[] {
  if (!(size > 0)) return [];
  size = Math.floor(size);
  if (slides.length === 0) {
    return Array.from({ length: size }, (_, i) => ({ page: null, fact: null, facts: [], angle: (["recall", "apply", "compare"] as Angle[])[i % 3] }));
  }

  // Every distinct fact once, remembering which slide first listed it.
  const seen = new Set<string>();
  const all: Entry[] = [];
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
    // adds nothing: its facts already have their slots (distinctFacts counts it the same way).
    if (facts.length === 0) {
      if (listed === 0) all.push({ slide: s, fact: null });
      continue;
    }
    for (const f of facts) all.push({ slide: s, fact: f });
  }

  let groups: Entry[][];
  if (all.length <= size) {
    groups = all.map((e) => [e]);
  } else if (mode === "cut") {
    // Keep the `size` most important (stressed slides first, then case slides, then slide order), back in slide order.
    const rank = (x: Entry) => (x.slide.emphasized ? 0 : 2) + (x.slide.hasCase ? 0 : 1);
    groups = all
      .map((x, i) => ({ x, i }))
      .sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i)
      .slice(0, size)
      .sort((a, b) => a.i - b.i)
      .map((a) => [a.x]);
  } else {
    // Condense. Entries per slide, in order.
    const bySlide: Entry[][] = [];
    for (const e of all) {
      const last = bySlide[bySlide.length - 1];
      if (last && last[0].slide.id === e.slide.id) last.push(e);
      else bySlide.push([e]);
    }
    if (bySlide.length > size) {
      // More fact-bearing slides than slots: neighbouring slides share a question.
      groups = chunks(all, size);
    } else {
      // Slots per slide in proportion to its facts, at least one each, adding up to `size` (largest remainders first).
      const quota = bySlide.map((g) => (g.length * size) / all.length);
      const slots = quota.map((q) => Math.max(1, Math.floor(q)));
      let left = size - slots.reduce((a, b) => a + b, 0);
      const order = quota.map((q, i) => ({ i, r: q - Math.floor(q) })).sort((a, b) => b.r - a.r || a.i - b.i);
      for (let k = 0; left > 0; k = (k + 1) % order.length) {
        const i = order[k].i;
        if (slots[i] < bySlide[i].length) {
          slots[i]++;
          left--;
        } else if (order.every((o) => slots[o.i] >= bySlide[o.i].length)) break;
      }
      for (; left < 0; ) {
        // Rounding gave too many (every slide got its floor of one): take from the slides with the most slots per fact.
        const i = slots.map((n, i) => ({ i, spare: n - 1, ratio: n / bySlide[i].length })).filter((x) => x.spare > 0).sort((a, b) => b.ratio - a.ratio)[0]?.i;
        if (i == null) break;
        slots[i]--;
        left++;
      }
      groups = bySlide.flatMap((g, i) => chunks(g, Math.min(slots[i], g.length)));
    }
  }

  // Vary the angle so a quiz isn't all recall: every second fact is applied, every third compared; case slides apply.
  // A slot with several facts takes an angle that can hold them all: a comparison, "which is NOT", a vignette.
  return groups.map((g, i) => {
    const pages = [...new Set(g.map((e) => e.slide.id))];
    const facts = g.map((e) => e.fact).filter((f): f is string => f != null);
    const multi = facts.length > 1;
    const angle: Angle = g[0].slide.hasCase ? "apply" : multi ? (["compare", "not", "apply"] as Angle[])[i % 3] : i % 3 === 1 ? "apply" : i % 3 === 2 ? "compare" : "recall";
    return { page: pages[0], ...(pages.length > 1 ? { pages } : {}), fact: facts[0] ?? null, facts, angle };
  });
}

/** Normalised question text, to spot the same question written twice. */
export const normStem = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const ANGLE_TEXT: Record<Angle, string> = {
  recall: "recall of a key fact",
  apply: "apply it: a short clinical vignette or 'which finding / next step'",
  compare: "compare or distinguish it from a related item on the slides",
  not: "'which is NOT …' / 'all EXCEPT' over the listed facts",
};
