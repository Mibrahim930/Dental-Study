// Planning a section quiz before the AI writes it: which slide each question tests and from what angle.
// Pure (no database, no AI), so the coverage rules can be tested directly.

/** How a question approaches its slide. "not" ("which is NOT…") is only used for slides that are lists. */
export type Angle = "recall" | "apply" | "compare" | "not";

// ---- Fact-based planning (Release 3) ----
// A section quiz has about one question per distinct fact on its slides, never the same fact twice: a short section
// gets a short quiz instead of the same three facts asked seven ways.

/** A slide with the facts its notes list. */
export type FactSlide = {
  id: number;
  /** Number of testable facts on the slide. */
  keyFacts: number;
  /** The professor stressed it (★). */
  emphasized: boolean;
  /** The slide poses a clinical case. */
  hasCase: boolean;
  facts: string[];
};

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
 * Too few groups for `size`: hand out the remaining questions to whichever unit has the most facts per question, one
 * at a time, re-chunking it evenly each time (so a 120-fact slide ends up as 25 questions of 4-5 facts, and two equal
 * slides get 13 and 12). A unit is one slide's facts (split into k even chunks) or a merged run of thin slides (split
 * at slide boundaries into k pieces); a "general" group stays as it is.
 */
function spread(groups: Entry[][], size: number): Entry[][] {
  type Unit = { entries: Entry[]; k: number; single: boolean; fixed: boolean };
  const units: Unit[] = [];
  for (const g of groups) {
    const last = units[units.length - 1];
    const single = slidesOf(g) === 1 && !general(g);
    if (single && last?.single && last.entries[0].slide.id === g[0].slide.id) {
      last.entries.push(...g);
      last.k++;
    } else units.push({ entries: [...g], k: 1, single, fixed: general(g) });
  }
  const pieces = (u: Unit) => (u.single ? u.entries.length : slidesOf(u.entries)); // the most questions a unit can become
  let total = units.reduce((n, u) => n + u.k, 0);
  while (total < size) {
    let best: Unit | null = null;
    for (const u of units) {
      if (u.fixed || u.k >= pieces(u)) continue;
      if (!best || u.entries.length / u.k > best.entries.length / best.k) best = u;
    }
    if (!best) break;
    best.k++;
    total++;
  }
  return units.flatMap((u) => {
    if (u.single || u.fixed) return chunks(u.entries, u.k);
    // A merged run: split at slide boundaries, as evenly as possible, by slide.
    const runs: Entry[][] = [];
    for (const e of u.entries) {
      const last = runs[runs.length - 1];
      if (last && last[0].slide.id === e.slide.id) last.push(e);
      else runs.push([e]);
    }
    return chunks(runs, u.k).map((piece) => piece.flat());
  });
}

/** A "test the slide in general" entry: it stays a question of its own, never merged with facts. */
const general = (g: Entry[]) => g.some((e) => e.fact == null);
const slidesOf = (g: Entry[]) => new Set(g.map((e) => e.slide.id)).size;

/**
 * Condense `all` (every fact, in slide order) into exactly `size` groups, each a question:
 * 1. A bound on facts per question, M = ceil(facts / size). Each slide's facts are split into even chunks of at most M.
 * 2. Still too many groups (thin slides): neighbouring chunks are merged, left to right, while a merge stays within M,
 *    only as far as needed. If that isn't enough, M goes up by one and it all runs again.
 * 3. Too few groups: the biggest groups are split (a merged group at a slide boundary first) until there are `size`.
 * So facts stay with their slide whenever the slide is big enough to deserve a question, a dense slide gets the most
 * questions, a question never carries more than about M facts, and thin neighbouring slides share one.
 */
function condense(all: Entry[], size: number): Entry[][] {
  // "General" entries (fact-less slides) never merge; more of them than slots means merging them anyway (below).
  for (let M = Math.max(1, Math.ceil(all.length / size)); M <= all.length; M++) {
    const bySlide: Entry[][] = [];
    for (const e of all) {
      const last = bySlide[bySlide.length - 1];
      if (last && last[0].slide.id === e.slide.id) last.push(e);
      else bySlide.push([e]);
    }
    const parts = bySlide.flatMap((g) => chunks(g, Math.ceil(g.length / M)));
    const groups: Entry[][] = [];
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i];
      const last = groups[groups.length - 1];
      const stillTooMany = groups.length + (parts.length - i) > size;
      if (last && stillTooMany && !general(last) && !general(c) && last.length + c.length <= M) last.push(...c);
      else groups.push([...c]);
    }
    if (groups.length > size) continue;
    return spread(groups, size);
  }
  // Only fact-less slides left to merge (more of them than slots): plain consecutive chunks.
  return chunks(all, size);
}

/**
 * The plan: every distinct fact once, in slide order (facts in the order the slide lists them), one slot each when they
 * fit in `size`. When there are more facts than slots, the facts are condensed, not dropped: each slide gets slots in
 * proportion to its facts (at least one), and a slot holding several facts asks for one question that needs all of
 * them. A section with more fact-bearing slides than slots condenses across neighbouring slides instead.
 */
export function planQuizByFacts(slides: FactSlide[], size = quizSize(slides)): FactSlot[] {
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

  const groups: Entry[][] = all.length <= size ? all.map((e) => [e]) : condense(all, size);

  // Vary the angle so a quiz isn't all recall: every second fact is applied, every third compared; case slides apply.
  // A slot with several facts takes an angle that can hold them all: a comparison, "which is NOT", a vignette.
  return groups.map((g, i) => {
    const pages = [...new Set(g.map((e) => e.slide.id))];
    const facts = g.map((e) => e.fact).filter((f): f is string => f != null);
    const multi = facts.length > 1;
    const angle: Angle = g.some((e) => e.slide.hasCase) ? "apply" : multi ? (["compare", "not", "apply"] as Angle[])[i % 3] : i % 3 === 1 ? "apply" : i % 3 === 2 ? "compare" : "recall";
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
