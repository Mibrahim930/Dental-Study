// Pure helpers for the topic map: clean up what the AI returned, place slides it left out, and recognise which new
// topics are the same as old ones (so lessons, quizzes, answers and progress survive a rebuild). No database access.

/** A slide as the topic map sees it: its lecture and its slide number inside that lecture. */
export type SlideRef = { id: number; doc: number; n: number };

/** One topic from the AI, reduced to what matters here. */
export type DraftTopic<T> = T & { page_ids: number[] };

/**
 * Make every content slide belong to exactly one topic:
 * - ids the AI invented (not in `slides`) are dropped;
 * - a slide listed in several topics stays only in the first;
 * - a slide the AI left out joins the topic holding its nearest neighbour in the same lecture (closest slide number;
 *   a tie goes to the earlier topic). With no topic in that lecture, the nearest slide overall (in lecture order) wins.
 * Topics left with no slides are removed. `slides` should be in lecture order (document, then slide number).
 */
export function cleanTopics<T>(topics: DraftTopic<T>[], slides: SlideRef[]): DraftTopic<T>[] {
  const known = new Map(slides.map((s, i) => [s.id, { ...s, order: i }]));
  const owner = new Map<number, number>(); // slide id -> topic index
  const out = topics.map((t, ti) => {
    const ids: number[] = [];
    for (const id of t.page_ids) {
      if (!known.has(id) || owner.has(id)) continue;
      owner.set(id, ti);
      ids.push(id);
    }
    return { ...t, page_ids: ids };
  });
  if (owner.size === 0) return [];

  // Leftover slides attach to their nearest neighbour among the slides the AI did place.
  const placed = [...owner.keys()].map((id) => known.get(id)!);
  const additions = new Map<number, number[]>();
  for (const s of slides) {
    if (owner.has(s.id)) continue;
    const me = known.get(s.id)!;
    const sameDoc = placed.filter((p) => p.doc === s.doc);
    const pool = sameDoc.length ? sameDoc : placed;
    let best: { topic: number; dist: number } | null = null;
    for (const p of pool) {
      const dist = sameDoc.length ? Math.abs(p.n - s.n) : Math.abs(p.order - me.order);
      const topic = owner.get(p.id)!;
      if (!best || dist < best.dist || (dist === best.dist && topic < best.topic)) best = { topic, dist };
    }
    additions.set(best!.topic, [...(additions.get(best!.topic) ?? []), s.id]);
  }
  for (const [ti, ids] of additions) {
    // Keep each topic's slides in lecture order.
    out[ti].page_ids = [...out[ti].page_ids, ...ids].sort((a, b) => known.get(a)!.order - known.get(b)!.order);
  }
  return out.filter((t) => t.page_ids.length > 0);
}

/**
 * Which old topic each new topic continues. A pair matches when they share at least half of each one's slides;
 * each old topic is used at most once, biggest overlaps first. Returns new-topic index -> old topic id.
 */
export function matchTopics(old: { id: number; page_ids: number[] }[], fresh: { page_ids: number[] }[]): Map<number, number> {
  const pairs: { ni: number; oid: number; overlap: number }[] = [];
  fresh.forEach((f, ni) => {
    const mine = new Set(f.page_ids);
    for (const o of old) {
      const overlap = o.page_ids.filter((p) => mine.has(p)).length;
      if (overlap > 0 && overlap * 2 >= o.page_ids.length && overlap * 2 >= f.page_ids.length) pairs.push({ ni, oid: o.id, overlap });
    }
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.ni - b.ni);
  const out = new Map<number, number>();
  const usedOld = new Set<number>();
  for (const p of pairs) {
    if (out.has(p.ni) || usedOld.has(p.oid)) continue;
    out.set(p.ni, p.oid);
    usedOld.add(p.oid);
  }
  return out;
}

/** Same slides, in any order. */
export function sameSlides(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * Final order when new topics are added to an existing map: old topics keep their order, and each new topic goes
 * right after the existing topic number it names (1-based; 0 or less = at the start, too big = at the end).
 * New topics anchored to the same place keep the AI's order.
 */
export function placeNewTopics<O, N>(oldInOrder: O[], fresh: { topic: N; after: number }[]): ({ old: O } | { fresh: N })[] {
  const out: ({ old: O } | { fresh: N })[] = [];
  const at = (k: number) => fresh.filter((f) => Math.min(Math.max(Math.round(f.after) || 0, 0), oldInOrder.length) === k).map((f) => ({ fresh: f.topic }));
  out.push(...at(0));
  oldInOrder.forEach((o, i) => {
    out.push({ old: o });
    out.push(...at(i + 1));
  });
  return out;
}
