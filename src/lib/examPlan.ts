// Planning a practice exam before any question of it is written (docs/EXAM-PLAN.md): every question is a slot that
// names its section, slide, fact and kind, and why it is in the exam. The writer (lib/practice.ts) then writes to the
// plan, one question per slot. A pure core (planExam) plus thin database readers; no AI call.
//
// ---- API for the writer and the screens ----
//
// planExam(input: PlanInput): ExamPlan
//   Pure. `input.shuffle` (default practicePlan's shuffle) only orders the finished slots; an identity shuffle makes
//   the whole plan deterministic.
//
// buildExamPlan(examId, opts: BuildOptions): ExamPlan
//   Reads everything planExam needs and calls it. opts:
//     size, style ("mixed" | "recall" | "case" | "caseset"), adaptive (focus on weak spots),
//     topicIds? (the chosen sections; empty or absent = the whole exam), documentIds? (the chosen lectures: only their
//     slides are used), shuffle?,
//     unused?: number[]        ids of questions written earlier and never answered. practice.ts unusedQuestions() is
//                              private, so the writer passes them: unusedQuestions(topic.id, style, 1000, pages) for
//                              every topic in scope, concatenated (any order; they are matched to slots by fact_key).
//     unusedCases?: number[][] never-answered case sets, each the question ids of one case in order: practice.ts
//                              unusedCases(topic.id, 1000, pages) for every topic in scope, concatenated (case sets only).
//     retries?: number[]       missed questions that may come back, most recent first. Leave out: buildExamPlan calls
//                              retryQuestions() itself (same arguments as practice.ts generateAttempt). The share cap and
//                              "never starve a section" (practice.ts pickRetries) are applied by the planner, so pass
//                              every candidate, not pickRetries' result.
//     retriedCases?: number[][] same for case sets (retryCases() by default; the planner caps it).
//
// examCoverage(examId, scope: Scope, slots?: Slot[]): Coverage
//   { facts, tested, right, inThisExam? } for the exam page and the results. Two queries plus the slides in scope.
//
// Readers, exported for tests and for the writer: planSections, answerHistory, oldQuestionCounts, returningQuestions.
// Keys: factKey(text) for a fact, slideKey(pageId) for a slide with no facts listed; questions.fact_key stores the key.
//
// Stored as attempts.slots_json: the ExamPlan JSON (slots in exam order, numbered 1..n, and case groups).
import { db, type PageRow } from "./db";
import { normStem } from "./quizPlan";
import { lastPracticed, lecturePageIds, retryCases, retryQuestions, RETRY_SHARE, scopeTopicIds, shuffle, type Scope } from "./practicePlan";
import { examFamily } from "./quizProgress";
import { pictureOf } from "./questionImage";
import { slideNotes, topicPages } from "./study";
import type { Style } from "./practice";

export type SlotKind = "recall" | "case" | "image";
export type SlotWhy = "missed" | "unsure" | "new" | "starred" | "rotation" | "retry" | "unused";
export type SlotState = "todo" | "done" | "failed";

/** One planned question. See docs/EXAM-PLAN.md "Words". */
export type Slot = {
  /** 1-based number in the plan, stable for the life of the attempt. */
  n: number;
  /** The section. Null only for a returning question whose section was removed since (whole-exam practice). */
  topic_id: number | null;
  page_id: number | null;
  /** The fact text, or null: "a question from this slide" (a slide with no facts listed, or an old question). */
  fact: string | null;
  /** factKey(fact), or slideKey(page_id) when fact is null (`question:<id>` for an old question with no slide). */
  key: string;
  kind: SlotKind;
  why: SlotWhy;
  state: SlotState;
  question_id: number | null;
  /** Case sets: the case this slot belongs to. */
  case_n?: number;
};

/** Case sets: one patient case, its slots (by n) in the order they are asked. */
export type CaseGroup = { case_n: number; topic_id: number | null; why: SlotWhy; slots: number[] };

export type ExamPlan = { style: Style; requested: number; slots: Slot[]; cases: CaseGroup[] };

/** A slide as the planner sees it (like quizPlan's FactSlide). */
export type PlanSlide = { id: number; facts: string[]; starred: boolean; hasCase: boolean; hasPicture: boolean };
export type PlanSection = { id: number; slides: PlanSlide[] };

/** Her latest answer on any question written for a fact key; `at` orders answers (the attempt id: larger is later). */
export type FactHistory = { result: "wrong" | "unsure" | "right"; at: number };

/** A question already written that may take a slot as it is. */
export type ReturningQuestion = { questionId: number; topicId: number | null; pageId: number | null; factKey: string | null; type: SlotKind };

export type PlanInput = {
  /** The sections in scope, in order, each with its slides in order. */
  sections: PlanSection[];
  size: number;
  style: Style;
  /** "Focus on my weak spots". */
  adaptive: boolean;
  history: ReadonlyMap<string, FactHistory>;
  /** Section id → when it was last practised (practicePlan lastPracticed). Absent = never. */
  lastPracticed?: ReadonlyMap<number, number>;
  /** Slide id → old questions written from it with no fact_key (rule 6). */
  oldQuestions?: ReadonlyMap<number, number>;
  /** Missed questions that may come back, most recent first (every candidate: the planner caps them). */
  retries?: ReturningQuestion[];
  /** Questions written earlier and never answered. */
  unused?: ReturningQuestion[];
  /** Case sets: missed case questions, grouped by case, most recent case first. */
  retriedCases?: ReturningQuestion[][];
  /** Case sets: never-answered cases, each its questions in order. */
  unusedCases?: ReturningQuestion[][];
  shuffle?: <T>(xs: readonly T[]) => T[];
};

/** A fact's key: its normalised text, so the same fact written twice (or on two slides) is one. */
export const factKey = (text: string) => normStem(text);
/** The key of a slide with no facts listed (its slot is "a question from this slide"). */
export const slideKey = (pageId: number) => `slide:${pageId}`;
const questionKey = (q: ReturningQuestion) => q.factKey ?? (q.pageId != null ? slideKey(q.pageId) : `question:${q.questionId}`);

/** Question types an exam style may hold (the same as practice.ts styleTypes). */
export const styleKinds = (style: Style): SlotKind[] => (style === "recall" ? ["recall"] : style === "case" ? ["case", "image"] : style === "caseset" ? ["case"] : ["recall", "case", "image"]);

/** Mixed exams: the share of each kind. */
const MIX: Record<SlotKind, number> = { recall: 0.6, case: 0.25, image: 0.15 };

// ---- The facts in scope ----

/** One distinct fact (or fact-less slide) in scope. */
type Fact = { key: string; fact: string | null; topic: number; sec: number; slideIdx: number; page: number; order: number; slide: PlanSlide; share: number };

/**
 * Every distinct fact in scope, in section and slide order. The same text twice is one fact, the first slide (and
 * section) wins; a slide with no real fact listed is one "slide" entry; a recap slide whose facts all repeat earlier
 * slides adds nothing (as quizPlan's planQuizByFacts). `share` is rule 6: old questions without a fact_key written
 * from the slide, per fact on it.
 */
function distinctFacts(sections: PlanSection[], oldQuestions?: ReadonlyMap<number, number>): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  sections.forEach((s, sec) =>
    s.slides.forEach((slide, slideIdx) => {
      const mine: { key: string; fact: string | null }[] = [];
      let listed = 0;
      for (const raw of slide.facts) {
        const fact = raw.replace(/\s+/g, " ").trim();
        const key = factKey(fact);
        if (!key) continue;
        listed++;
        if (seen.has(key)) continue;
        seen.add(key);
        mine.push({ key, fact });
      }
      if (listed === 0 && !seen.has(slideKey(slide.id))) {
        seen.add(slideKey(slide.id));
        mine.push({ key: slideKey(slide.id), fact: null });
      }
      const share = (oldQuestions?.get(slide.id) ?? 0) / Math.max(1, listed);
      for (const m of mine) out.push({ ...m, topic: s.id, sec, slideIdx, page: slide.id, order: out.length, slide, share });
    }),
  );
  return out;
}

/** A fact ranked for this exam (rule 3). Lower rank comes first. */
type Cand = Fact & { rank: number; why: SlotWhy; at: number };

function rankFacts(facts: Fact[], history: ReadonlyMap<string, FactHistory>, adaptive: boolean): Cand[] {
  return facts.map((f) => {
    const h = history.get(f.key);
    // Missed and unsure lead with focus on; with it off they rank with the never-tested facts (their label stays).
    if (h?.result === "wrong") return { ...f, rank: adaptive ? 0 : 2, why: "missed", at: h.at };
    if (h?.result === "unsure") return { ...f, rank: adaptive ? 1 : 2, why: "unsure", at: h.at };
    // Rule 6: a fact with no keyed history on a slide that already has at least as many old (unkeyed) questions as
    // facts counts as tested, longest ago of all (at 0). With fewer it stays new, behind the new facts of slides with
    // fewer old questions (see `compare`), without pretending to know which of its facts they tested.
    if (!h && f.share < 1) return { ...f, rank: 2, why: "new", at: 0 };
    return { ...f, rank: f.slide.starred ? 3 : 4, why: f.slide.starred ? "starred" : "rotation", at: h?.at ?? 0 };
  });
}

/**
 * Order within one rank: starred first, then slides with fewer old questions (rule 6), then (starred and rotation only)
 * least recently tested, then slide order. With focus off, missed / unsure / new share a rank and are simply in slide order.
 */
const compare = (a: Cand, b: Cand) =>
  a.rank - b.rank ||
  Number(b.slide.starred) - Number(a.slide.starred) ||
  a.share - b.share ||
  (a.rank >= 3 ? a.at - b.at : 0) ||
  a.order - b.order;

/** Sections, least recently practised first (never practised first of all), then in order. */
function sectionOrder(sections: PlanSection[], last?: ReadonlyMap<number, number>): number[] {
  return sections.map((_, i) => i).sort((a, b) => (last?.get(sections[a].id) ?? 0) - (last?.get(sections[b].id) ?? 0) || a - b);
}

/** Candidates by rank; within a rank one per section in turn (sections in `order`), so one long section can't take every slot. */
function roundRobin(cands: Cand[], order: number[]): Cand[] {
  const out: Cand[] = [];
  const ranks = [...new Set(cands.map((c) => c.rank))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const queues = order.map((sec) => cands.filter((c) => c.rank === rank && c.sec === sec).sort(compare));
    for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

// ---- Kinds (rule 5) ----

/** The kinds a slide can carry in this style: an image needs a picture she can be shown. */
function kindsFor(slide: PlanSlide, style: Style): SlotKind[] {
  if (style === "recall") return ["recall"];
  if (style === "caseset") return ["case"];
  if (style === "case") return slide.hasPicture ? ["image", "case"] : ["case"];
  return slide.hasPicture ? ["recall", "case", "image"] : ["recall", "case"];
}

/**
 * The first question on each fact: "recall" → recall; "case" → image on a slide with a picture, case elsewhere;
 * "mixed" → about 15% image (slides with a picture, those without a case first), 25% case (case slides first, then
 * any), the rest recall, counted over the whole exam (questions coming back included).
 */
function firstKinds(first: Cand[], style: Style, size: number, already: SlotKind[]): SlotKind[] {
  if (style === "recall") return first.map(() => "recall");
  if (style === "caseset") return first.map(() => "case");
  if (style === "case") return first.map((c) => (c.slide.hasPicture ? "image" : "case"));
  const kinds: SlotKind[] = first.map(() => "recall");
  const target = (k: SlotKind) => Math.round(MIX[k] * size) - already.filter((x) => x === k).length;
  const give = (k: SlotKind, n: number, ok: (c: Cand) => boolean) => {
    for (let i = 0; i < first.length && n > 0; i++) {
      if (kinds[i] !== "recall" || !ok(first[i])) continue;
      kinds[i] = k;
      n--;
    }
    return n;
  };
  let images = target("image");
  images = give("image", images, (c) => c.slide.hasPicture && !c.slide.hasCase);
  give("image", images, (c) => c.slide.hasPicture); // an image kind with no picture left becomes recall (stays)
  let cases = target("case");
  cases = give("case", cases, (c) => c.slide.hasCase);
  give("case", cases, () => true);
  return kinds;
}

// ---- Returning questions (rule 1) ----

/**
 * Missed questions to bring back (practice.ts pickRetries' rules): one per section first, then the rest, most recent
 * first; at most RETRY_SHARE of the exam, and never so many that a section in scope is left without a slot. A second
 * question on the same key and kind is skipped (a fact is never asked the same way twice in one exam).
 */
function capRetries(candidates: ReturningQuestion[], sections: PlanSection[], size: number, allowed: SlotKind[]): ReturningQuestion[] {
  const seenQ = new Set<number>();
  const seenKey = new Set<string>();
  const list = candidates.filter((q) => {
    const k = `${questionKey(q)}|${q.type}`;
    if (!allowed.includes(q.type) || seenQ.has(q.questionId) || seenKey.has(k)) return false;
    seenQ.add(q.questionId);
    seenKey.add(k);
    return true;
  });
  const topics = new Set<number | null>();
  const firstPerTopic = list.filter((q) => !topics.has(q.topicId) && (topics.add(q.topicId), true));
  const picked = [...firstPerTopic, ...list.filter((q) => !firstPerTopic.includes(q))].slice(0, Math.floor(size * RETRY_SHARE));
  const inScope = new Set(sections.map((s) => s.id));
  const uncovered = (qs: ReturningQuestion[]) => sections.length - new Set(qs.map((q) => q.topicId).filter((t) => t != null && inScope.has(t))).size;
  while (picked.length > 0 && size - picked.length < uncovered(picked)) picked.pop();
  return picked;
}

type Draft = Omit<Slot, "n" | "case_n"> & { cand?: Cand };

function returningSlot(q: ReturningQuestion, why: "retry" | "unused", factText: Map<string, string | null>): Draft {
  const key = questionKey(q);
  return { topic_id: q.topicId, page_id: q.pageId, fact: factText.get(key) ?? null, key, kind: q.type, why, state: "done", question_id: q.questionId };
}

/** Kinds already planned per key. */
class Used {
  private m = new Map<string, Set<SlotKind>>();
  has = (key: string, kind: SlotKind) => !!this.m.get(key)?.has(kind);
  add = (key: string, kind: SlotKind) => void (this.m.get(key) ?? this.m.set(key, new Set()).get(key)!).add(kind);
  remove = (key: string, kind: SlotKind) => void this.m.get(key)?.delete(kind);
}

/**
 * Unused questions fill planned slots as they are: one with the slot's key (the slot's kind first, else another kind
 * the style allows and the key doesn't have yet). An old unused question with no fact_key fills a "new" or "rotation"
 * slot on its own slide; the slot then becomes "a question from this slide" (its fact is left for a later exam, since
 * nobody knows which fact the old question tested). Missed, unsure and starred facts always get a question of their own.
 */
function fillWithUnused(drafts: Draft[], unused: ReturningQuestion[], allowed: SlotKind[], used: Used) {
  const taken = new Set<number>();
  const pool = unused.filter((q) => allowed.includes(q.type));
  for (const d of drafts) {
    if (d.state !== "todo") continue;
    const sameKey = pool.filter((q) => !taken.has(q.questionId) && questionKey(q) === d.key && (q.type === d.kind || !used.has(d.key, q.type)));
    const q = sameKey.find((x) => x.type === d.kind) ?? sameKey[0];
    if (q) {
      taken.add(q.questionId);
      used.remove(d.key, d.kind);
      used.add(d.key, q.type);
      Object.assign(d, { kind: q.type, why: "unused", state: "done", question_id: q.questionId });
      continue;
    }
    if (d.fact == null || d.page_id == null || (d.why !== "new" && d.why !== "rotation")) continue;
    const page = d.page_id;
    const old = pool.find((x) => !taken.has(x.questionId) && x.factKey == null && x.pageId === page && !used.has(slideKey(page), x.type));
    if (!old) continue;
    taken.add(old.questionId);
    used.remove(d.key, d.kind);
    used.add(slideKey(page), old.type);
    Object.assign(d, { fact: null, key: slideKey(page), kind: old.type, why: "unused", state: "done", question_id: old.questionId });
  }
}

// ---- The planner ----

export function planExam(input: PlanInput): ExamPlan {
  const size = Math.max(0, Math.floor(input.size || 0));
  const order = (input.shuffle ?? shuffle) as <T>(xs: readonly T[]) => T[];
  const sections = input.sections.filter((s) => s.slides.length > 0);
  const facts = distinctFacts(sections, input.oldQuestions);
  const factText = new Map(facts.map((f) => [f.key, f.fact]));
  const empty: ExamPlan = { style: input.style, requested: size, slots: [], cases: [] };
  if (size === 0) return empty;
  const cands = rankFacts(facts, input.history, input.adaptive);
  const secOrder = sectionOrder(sections, input.lastPracticed);
  if (input.style === "caseset") return planCaseSet(input, size, sections, cands, secOrder, factText, order);

  const allowed = styleKinds(input.style);
  const used = new Used();
  // 1. Questions coming back as they were.
  const retries = capRetries(input.retries ?? [], sections, size, allowed).map((q) => returningSlot(q, "retry", factText));
  retries.forEach((d) => used.add(d.key, d.kind));
  const coveredKeys = new Set(retries.map((d) => d.key));
  const coveredTopics = new Set(retries.map((d) => d.topic_id));
  const open = cands.filter((c) => !coveredKeys.has(c.key));
  const room = size - retries.length;

  // 2. One slot for every section not covered yet, least recently practised first when there isn't room for all.
  const first: Cand[] = [];
  for (const sec of secOrder) {
    if (first.length >= room) break;
    if (coveredTopics.has(sections[sec].id)) continue;
    const best = open.filter((c) => c.sec === sec).sort(compare)[0];
    if (best) first.push(best);
  }
  // 3. The rest by rank, round-robin across sections within a rank.
  const picked = new Set(first);
  first.push(
    ...roundRobin(
      open.filter((c) => !picked.has(c)),
      secOrder,
    ).slice(0, Math.max(0, room - first.length)),
  );

  const drafts: Draft[] = [...retries];
  const kinds = firstKinds(first, input.style, size, retries.map((d) => d.kind));
  first.forEach((c, i) => {
    used.add(c.key, kinds[i]);
    drafts.push({ cand: c, topic_id: c.topic, page_id: c.page, fact: c.fact, key: c.key, kind: kinds[i], why: c.why, state: "todo", question_id: null });
  });

  // 4. More slots than facts: second (then third) questions on the highest-ranked facts, each with a kind that fact
  // doesn't have yet; in a mixed exam the kind furthest below its share. Never the same fact with the same kind twice,
  // so a style with one kind (recall) gives a plan shorter than asked when the material runs out.
  const count = (k: SlotKind) => drafts.filter((d) => d.kind === k).length;
  const again = roundRobin(first, secOrder);
  for (let pass = 0; pass < 2 && drafts.length < size; pass++) {
    for (const c of again) {
      if (drafts.length >= size) break;
      const avail = kindsFor(c.slide, input.style).filter((k) => !used.has(c.key, k));
      if (avail.length === 0) continue;
      const kind = input.style === "mixed" ? [...avail].sort((a, b) => count(a) - MIX[a] * size - (count(b) - MIX[b] * size))[0] : avail[0];
      used.add(c.key, kind);
      drafts.push({ cand: c, topic_id: c.topic, page_id: c.page, fact: c.fact, key: c.key, kind, why: c.why, state: "todo", question_id: null });
    }
  }

  fillWithUnused(drafts, input.unused ?? [], allowed, used);
  // The exam doesn't run section by section.
  const slots = order(drafts).map((d, i): Slot => finish(d, i + 1));
  return { ...empty, slots };
}

const finish = (d: Draft, n: number, case_n?: number): Slot => ({
  n,
  topic_id: d.topic_id,
  page_id: d.page_id,
  fact: d.fact,
  key: d.key,
  kind: d.kind,
  why: d.why,
  state: d.state,
  question_id: d.question_id,
  ...(case_n != null ? { case_n } : {}),
});

/** How many questions each new case gets: the questions left, split as evenly as possible, 3 to 5 a case. */
function caseSizes(questions: number, cases: number): number[] {
  return Array.from({ length: cases }, (_, i) => Math.min(5, Math.max(3, Math.floor(questions / cases) + (i < questions % cases ? 1 : 0))));
}

/**
 * Rule 7. The exam is a list of cases (about one per four questions asked, as before). Missed case questions come back
 * grouped by their case, at most RETRY_SHARE of the cases (at least one may) and never so many that a section is left
 * without a case; at least one new case always. Each new case goes to a section (every uncovered section first, least
 * recently practised first; then wherever the best remaining fact is, a section with fewer cases first within a rank)
 * and is a never-answered case of that section when there is one, else 3-5 slots grown from the section's best fact
 * outward to the neighbouring slides. A section too small for three slots gives a shorter case.
 */
function planCaseSet(
  input: PlanInput,
  size: number,
  sections: PlanSection[],
  cands: Cand[],
  secOrder: number[],
  factText: Map<string, string | null>,
  order: <T>(xs: readonly T[]) => T[],
): ExamPlan {
  const caseCount = Math.max(1, Math.round(size / 4));
  const inScope = new Set(sections.map((s) => s.id));
  const topicOf = (g: ReturningQuestion[]) => g.find((q) => q.topicId != null)?.topicId ?? null;
  // Retried cases: whole groups, each question once.
  const seenQ = new Set<number>();
  const groups = (input.retriedCases ?? [])
    .map((g) => g.filter((q) => !seenQ.has(q.questionId) && (seenQ.add(q.questionId), true)))
    .filter((g) => g.length > 0);
  const retried = groups.slice(0, Math.max(1, Math.floor(caseCount * RETRY_SHARE)));
  const uncovered = (gs: ReturningQuestion[][]) => sections.length - new Set(gs.flatMap((g) => g.map((q) => q.topicId)).filter((t) => t != null && inScope.has(t))).size;
  while (retried.length > 0 && Math.max(1, caseCount - retried.length) < uncovered(retried)) retried.pop();

  type Group = { topic_id: number | null; why: SlotWhy; drafts: Draft[] };
  const out: Group[] = retried.map((g) => ({ topic_id: topicOf(g), why: "retry", drafts: g.map((q) => ({ ...returningSlot(q, "retry", factText), kind: "case" as SlotKind })) }));
  const coveredKeys = new Set(out.flatMap((g) => g.drafts.map((d) => d.key)));
  const casesIn = new Map<number, number>(); // section index → cases planned
  for (const g of out) {
    const sec = sections.findIndex((s) => s.id === g.topic_id);
    if (sec !== -1) casesIn.set(sec, (casesIn.get(sec) ?? 0) + 1);
  }

  const unusedBySection = new Map<number, ReturningQuestion[][]>();
  for (const g of input.unusedCases ?? []) {
    const t = topicOf(g);
    if (t == null || g.length === 0 || g.some((q) => seenQ.has(q.questionId))) continue;
    g.forEach((q) => seenQ.add(q.questionId));
    unusedBySection.set(t, [...(unusedBySection.get(t) ?? []), g]);
  }

  const taken = new Set<Cand>();
  const left = () => cands.filter((c) => !taken.has(c) && !coveredKeys.has(c.key));
  const retriedQs = out.reduce((n, g) => n + g.drafts.length, 0);
  const sizes = caseSizes(Math.max(0, size - retriedQs), Math.max(1, caseCount - out.length));

  /** Grow a case from `seed` over its section: its own slide first, then the slides one away, two away, … */
  const grow = (seed: Cand, k: number): Cand[] => {
    const pool = left().filter((c) => c.sec === seed.sec && c !== seed);
    const chosen = [seed];
    for (let dist = 0; chosen.length < k; dist++) {
      const ring = pool.filter((c) => Math.abs(c.slideIdx - seed.slideIdx) === dist);
      if (ring.length === 0 && pool.every((c) => Math.abs(c.slideIdx - seed.slideIdx) < dist)) break;
      // Nearer slides after the seed's first (i+1 before i-1), best facts first on each slide.
      ring.sort((a, b) => Number(a.slideIdx < seed.slideIdx) - Number(b.slideIdx < seed.slideIdx) || compare(a, b));
      chosen.push(...ring.slice(0, k - chosen.length));
    }
    return chosen.sort((a, b) => a.order - b.order);
  };

  const seat = (sec: number, seed: Cand | undefined, k: number): boolean => {
    const reuse = unusedBySection.get(sections[sec].id);
    if (reuse?.length) {
      const g = reuse.shift()!;
      out.push({ topic_id: sections[sec].id, why: "unused", drafts: g.map((q) => ({ ...returningSlot(q, "unused", factText), kind: "case" as SlotKind })) });
      g.forEach((q) => coveredKeys.add(questionKey(q)));
    } else {
      if (!seed) return false;
      const chosen = grow(seed, k);
      chosen.forEach((c) => taken.add(c));
      out.push({
        topic_id: seed.topic,
        why: seed.why,
        drafts: chosen.map((c) => ({ topic_id: c.topic, page_id: c.page, fact: c.fact, key: c.key, kind: "case", why: c.why, state: "todo", question_id: null })),
      });
    }
    casesIn.set(sec, (casesIn.get(sec) ?? 0) + 1);
    return true;
  };

  let next = 0;
  // Every section without a case gets one first, least recently practised first.
  for (const sec of secOrder) {
    if (next >= sizes.length) break;
    if (casesIn.has(sec)) continue;
    if (seat(sec, left().filter((c) => c.sec === sec).sort(compare)[0], sizes[next])) next++;
  }
  // Then wherever the best fact left is: by rank, a section with fewer cases first, then the usual order.
  while (next < sizes.length) {
    const seed = left().sort((a, b) => a.rank - b.rank || (casesIn.get(a.sec) ?? 0) - (casesIn.get(b.sec) ?? 0) || compare(a, b))[0];
    if (!seed || !seat(seed.sec, seed, sizes[next])) break;
    next++;
  }

  // Cases in a shuffled order; each case's questions stay together and in order.
  const slots: Slot[] = [];
  const cases: CaseGroup[] = [];
  order(out).forEach((g, i) => {
    const case_n = i + 1;
    const ns = g.drafts.map((d) => {
      const s = finish(d, slots.length + 1, case_n);
      slots.push(s);
      return s.n;
    });
    cases.push({ case_n, topic_id: g.topic_id, why: g.why, slots: ns });
  });
  return { style: input.style, requested: size, slots, cases };
}

// ---- Database readers ----

/**
 * The sections in scope with their slides, as the planner sees them. Slides come from topicPages (and, with chosen
 * lectures, only theirs, like practice.ts pagesFor); a slide's facts from its notes (study.ts slideNotes, damage
 * tolerated); its picture from questionImage pictureOf. A slide with no readable notes is left out (it has not been
 * read, so nothing can be planned on it), and so is a title / agenda / thank-you slide that lists no fact. Sections
 * left with no slides are left out.
 */
export function planSections(examId: number, topicIds: number[] = [], documentIds: number[] = []): PlanSection[] {
  const pages = documentIds.length ? lecturePageIds(examId, documentIds) : null;
  return scopeTopics(examId, topicIds)
    .map((t) => ({
      id: t.id,
      slides: topicPages(t)
        .filter((p) => !pages || pages.has(p.id))
        .flatMap((p) => planSlide(p)),
    }))
    .filter((s) => s.slides.length > 0);
}

function scopeTopics(examId: number, topicIds: number[]) {
  const all = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Parameters<typeof topicPages>[0][];
  return topicIds.length ? all.filter((t) => topicIds.includes(t.id)) : all;
}

function planSlide(p: PageRow): PlanSlide[] {
  const n = slideNotes(p);
  if (!n) return [];
  const facts = n.key_facts;
  if (!facts.some((f) => factKey(f)) && (n.is_filler || p.is_filler)) return [];
  return [{ id: p.id, facts, starred: !!(n.emphasized ?? p.emphasized), hasCase: !!(n.case_prompt ?? p.has_case), hasPicture: !!pictureOf(p) }];
}

/** What her latest answer to a question says, with the same definitions as practicePlan focusPoints / pendingCounts. */
const resultOf = (correct: number, confidence: string | null): FactHistory["result"] =>
  correct === 0 ? "wrong" : confidence === "guess" || confidence === "unsure" ? "unsure" : "right";

/**
 * Her answers that count for planning and coverage, in one query:
 * - `facts`: per fact key, her latest answer on any question written for it, in any practice exam of this exam's
 *   family (quizProgress examFamily) that she owns: a classmate's answers on a shared copy never count.
 * - `oldBySlide`: per slide of this exam, the old questions with no fact_key she has answered, and how many of those
 *   her latest answer got right (rule 6, for coverage).
 * Only answered questions, not retired (flagged), and only an exam's own questions (as practicePlan latestResults).
 */
export function answerHistory(examId: number): { facts: Map<string, FactHistory>; oldBySlide: Map<number, { answered: number; right: number }> } {
  const owner = (db.prepare("SELECT user_id FROM exams WHERE id = ?").get(examId) as { user_id: number | null } | undefined)?.user_id ?? null;
  const family = examFamily(examId);
  const rows = db
    .prepare(
      `SELECT q.id AS qid, q.fact_key, q.source_page_id AS page_id, a.exam_id, aq.correct, aq.confidence, aq.attempt_id
       FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id JOIN exams e ON e.id = a.exam_id JOIN questions q ON q.id = aq.question_id
       WHERE a.exam_id IN (${family.map(() => "?").join(",")}) AND e.user_id IS ? AND q.exam_id = a.exam_id
         AND aq.chosen_index IS NOT NULL AND q.flagged = 0 AND (q.fact_key IS NOT NULL OR a.exam_id = ?)
       ORDER BY aq.attempt_id, aq.position`,
    )
    .all(...family, owner, examId) as { qid: number; fact_key: string | null; page_id: number | null; exam_id: number; correct: number; confidence: string | null; attempt_id: number }[];
  const facts = new Map<string, FactHistory>();
  const old = new Map<number, { page: number; right: boolean }>(); // latest per old question
  for (const r of rows) {
    const result = resultOf(r.correct, r.confidence);
    if (r.fact_key != null) facts.set(r.fact_key, { result, at: r.attempt_id });
    else if (r.page_id != null) old.set(r.qid, { page: r.page_id, right: result !== "wrong" });
  }
  const oldBySlide = new Map<number, { answered: number; right: number }>();
  for (const o of old.values()) {
    const s = oldBySlide.get(o.page) ?? { answered: 0, right: 0 };
    s.answered++;
    if (o.right) s.right++;
    oldBySlide.set(o.page, s);
  }
  return { facts, oldBySlide };
}

/** Rule 6: per slide of this exam, how many questions (not retired) were written from it before fact keys existed. */
export function oldQuestionCounts(examId: number): Map<number, number> {
  const rows = db
    .prepare("SELECT source_page_id AS id, COUNT(*) AS n FROM questions WHERE exam_id = ? AND fact_key IS NULL AND flagged = 0 AND source_page_id IS NOT NULL GROUP BY source_page_id")
    .all(examId) as { id: number; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** Questions by id, as the planner needs them, in the order given (unknown ids are left out). */
export function returningQuestions(ids: number[]): ReturningQuestion[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT id, topic_id, source_page_id, fact_key, type FROM questions WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: number; topic_id: number | null; source_page_id: number | null; fact_key: string | null; type: SlotKind }[];
  const byId = new Map(rows.map((r) => [r.id, { questionId: r.id, topicId: r.topic_id, pageId: r.source_page_id, factKey: r.fact_key, type: r.type }]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export type BuildOptions = {
  size: number;
  style: Style;
  adaptive: boolean;
  topicIds?: number[];
  documentIds?: number[];
  unused?: number[];
  unusedCases?: number[][];
  retries?: number[];
  retriedCases?: number[][];
  shuffle?: <T>(xs: readonly T[]) => T[];
};

/** The plan for a new practice exam on this exam (see the top of this file). */
export function buildExamPlan(examId: number, opts: BuildOptions): ExamPlan {
  const scoped = !!opts.topicIds?.length;
  const topicIds = scopeTopics(examId, opts.topicIds ?? []).map((t) => t.id);
  const pageIds = opts.documentIds?.length ? lecturePageIds(examId, opts.documentIds) : null;
  const caseset = opts.style === "caseset";
  const retries = opts.retries ?? (caseset ? [] : retryQuestions(examId, topicIds, 1000, { types: styleKinds(opts.style), wholeExam: !scoped, pageIds }));
  const retriedCases = opts.retriedCases ?? (caseset ? retryCases(examId, topicIds, 1000, { wholeExam: !scoped, pageIds }) : []);
  return planExam({
    sections: planSections(examId, topicIds, opts.documentIds ?? []),
    size: opts.size,
    style: opts.style,
    adaptive: opts.adaptive,
    history: answerHistory(examId).facts,
    lastPracticed: lastPracticed(examId),
    oldQuestions: oldQuestionCounts(examId),
    retries: returningQuestions(retries),
    unused: returningQuestions(opts.unused ?? []),
    retriedCases: retriedCases.map(returningQuestions),
    unusedCases: (opts.unusedCases ?? []).map(returningQuestions),
    shuffle: opts.shuffle,
  });
}

export type Coverage = { facts: number; tested: number; right: number; inThisExam?: number };

/**
 * How much of the material in scope she has been tested on:
 * - facts: distinct fact keys in scope (a slide with no facts listed counts as one, as in the plan);
 * - tested: those she has answered a question on at least once; on slides with old questions written before fact
 *   keys, as many of the slide's untested facts as she answered old questions from it (rule 6);
 * - right: of those, how many her latest answer got right (an unsure right answer is right);
 * - inThisExam (with the exam's slots): distinct keys in scope among the slots of its plan, written yet or not (what the exam plans to cover).
 * The scope is read like a practice exam's (practicePlan Scope: the whole exam, chosen sections or chosen lectures).
 */
export function examCoverage(examId: number, scope: Scope, slots?: Slot[]): Coverage {
  const topicIds = scope.kind === "all" ? [] : scopeTopicIds(examId, scope);
  const documentIds = scope.kind === "lectures" ? scope.documentIds : [];
  const facts = distinctFacts(planSections(examId, topicIds, documentIds));
  const { facts: hist, oldBySlide } = answerHistory(examId);
  let tested = 0;
  let right = 0;
  const untested = new Map<number, number>(); // slide → facts with no keyed answer
  for (const f of facts) {
    const h = hist.get(f.key);
    if (h) {
      tested++;
      if (h.result !== "wrong") right++;
    } else untested.set(f.page, (untested.get(f.page) ?? 0) + 1);
  }
  for (const [page, n] of untested) {
    const old = oldBySlide.get(page);
    if (!old) continue;
    const t = Math.min(n, old.answered);
    tested += t;
    right += Math.min(t, old.right);
  }
  const out: Coverage = { facts: facts.length, tested, right };
  if (slots) {
    const keys = new Set(facts.map((f) => f.key));
    out.inThisExam = new Set(slots.filter((s) => keys.has(s.key)).map((s) => s.key)).size;
  }
  return out;
}
