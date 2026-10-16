import { describe, expect, it } from "vitest";
import { planQuiz, type PlanSlide } from "@/lib/quizPlan";
import { cleanTopics, matchTopics, placeNewTopics, sameSlides, type SlideRef } from "@/lib/topicMerge";

const slide = (id: number, over: Partial<PlanSlide> = {}): PlanSlide => ({ id, keyFacts: 2, emphasized: false, hasCase: false, ...over });
const perPage = (slots: { page: number | null }[]) => slots.reduce((m, s) => m.set(s.page, (m.get(s.page) ?? 0) + 1), new Map<number | null, number>());

describe("planQuiz: which slide each of the 20 questions tests", () => {
  it("always exactly 20 slots", () => {
    for (const n of [0, 1, 3, 6, 12, 20, 25, 60]) expect(planQuiz(Array.from({ length: n }, (_, i) => slide(i + 1)), 20), `${n} slides`).toHaveLength(20);
  });

  it("12 slides: every slide gets at least one question, slots in slide order", () => {
    const slides = Array.from({ length: 12 }, (_, i) => slide(i + 1));
    const plan = planQuiz(slides, 20);
    const counts = perPage(plan);
    for (const s of slides) expect(counts.get(s.id) ?? 0, `slide ${s.id}`).toBeGreaterThanOrEqual(1);
    expect(plan.map((p) => p.page)).toEqual([...plan.map((p) => p.page)].sort((a, b) => a! - b!));
  });

  it("6 slides: the extra slots go to the starred slides first, with different angles on one slide", () => {
    const slides = [slide(1), slide(2, { emphasized: true }), slide(3), slide(4, { emphasized: true }), slide(5), slide(6)];
    const plan = planQuiz(slides, 20);
    const counts = perPage(plan);
    for (const s of slides) expect(counts.get(s.id)).toBeGreaterThanOrEqual(1);
    expect(counts.get(2)!).toBeGreaterThan(counts.get(1)!);
    expect(counts.get(4)!).toBeGreaterThan(counts.get(3)!);
    const angles2 = plan.filter((p) => p.page === 2).map((p) => p.angle);
    expect(new Set(angles2.slice(0, 3)).size).toBe(3); // recall, apply, compare before repeating
  });

  it("'which is NOT' only on list slides; case slides start with an applied question", () => {
    const plan = planQuiz([slide(1, { keyFacts: 1 }), slide(2, { keyFacts: 6 }), slide(3, { hasCase: true })], 20);
    expect(plan.filter((p) => p.page === 1).every((p) => p.angle !== "not")).toBe(true);
    expect(plan.some((p) => p.page === 2 && p.angle === "not")).toBe(true);
    expect(plan.find((p) => p.page === 3)!.angle).toBe("apply");
  });

  it("25 slides: the 20 most important (starred, then cases, then most facts), one each", () => {
    const slides = Array.from({ length: 25 }, (_, i) => slide(i + 1, { keyFacts: 1 }));
    slides[24].emphasized = true; // last slide is starred
    slides[23].hasCase = true;
    slides[22].keyFacts = 9;
    const plan = planQuiz(slides, 20);
    const pages = new Set(plan.map((p) => p.page));
    expect(pages.size).toBe(20);
    for (const id of [25, 24, 23]) expect(pages.has(id), `slide ${id}`).toBe(true);
    // Ties fall back to slide order: slides 18-22 (plain, 1 fact) are the ones left out.
    for (const id of [18, 19, 20, 21, 22]) expect(pages.has(id)).toBe(false);
  });

  it("no slides: 20 general questions", () => {
    expect(planQuiz([], 20).every((p) => p.page === null)).toBe(true);
  });
});

const refs = (pairs: [doc: number, n: number][]): SlideRef[] => pairs.map(([doc, n], i) => ({ id: i + 1, doc, n }));

describe("cleanTopics: every slide in exactly one topic", () => {
  it("drops invented ids, dedupes (first topic wins), attaches omitted slides to their nearest neighbour", () => {
    // Lecture 10 slides 1..8 (ids 1..8), lecture 20 slides 1..4 (ids 9..12)
    const slides = refs([...Array.from({ length: 8 }, (_, i) => [10, i + 1] as [number, number]), ...Array.from({ length: 4 }, (_, i) => [20, i + 1] as [number, number])]);
    const ai = [
      { title: "A", page_ids: [1, 2, 3, 999] },
      { title: "B", page_ids: [3, 6, 7] }, // 3 is a duplicate
      { title: "C", page_ids: [9, 10, 11, 12] },
    ];
    // Omitted: 4, 5, 8
    const out = cleanTopics(ai, slides);
    const all = out.flatMap((t) => t.page_ids);
    expect(all.sort((a, b) => a - b)).toEqual(slides.map((s) => s.id));
    expect(out[0].page_ids).toEqual([1, 2, 3, 4]); // 4 is next to 3 (A)
    expect(out[1].page_ids).toEqual([5, 6, 7, 8]); // 5 is next to 6 (B; tie with 4? 4 isn't placed), 8 next to 7
  });

  it("ties go to the earlier topic", () => {
    const slides = refs([[1, 1], [1, 2], [1, 3]]);
    const out = cleanTopics([{ t: "x", page_ids: [1] }, { t: "y", page_ids: [3] }], slides);
    expect(out[0].page_ids).toEqual([1, 2]);
  });

  it("a lecture the AI ignored entirely joins the nearest topic in lecture order", () => {
    const slides = refs([[1, 1], [1, 2], [2, 1], [2, 2]]);
    const out = cleanTopics([{ page_ids: [1, 2] }], slides);
    expect(out[0].page_ids).toEqual([1, 2, 3, 4]);
  });

  it("topics left empty are removed; nothing placed at all gives no topics", () => {
    const slides = refs([[1, 1], [1, 2]]);
    expect(cleanTopics([{ page_ids: [1, 2] }, { page_ids: [2] }], slides)).toHaveLength(1);
    expect(cleanTopics([{ page_ids: [77] }], slides)).toEqual([]);
  });
});

describe("matchTopics / placeNewTopics", () => {
  it("matches when at least half of each one's slides are shared, one-to-one, biggest first", () => {
    const old = [
      { id: 100, page_ids: [1, 2, 3, 4] },
      { id: 200, page_ids: [5, 6] },
      { id: 300, page_ids: [7, 8, 9, 10] },
    ];
    const fresh = [{ page_ids: [1, 2, 3, 4, 11] }, { page_ids: [5, 6, 7] }, { page_ids: [8, 12, 13, 14, 15] }];
    const m = matchTopics(old, fresh);
    expect(m.get(0)).toBe(100);
    expect(m.get(1)).toBe(200); // 2 of 2 old, 2 of 3 new
    expect(m.has(2)).toBe(false); // 1 of 4 old
  });

  it("sameSlides ignores order", () => {
    expect(sameSlides([1, 2, 3], [3, 1, 2])).toBe(true);
    expect(sameSlides([1, 2], [1, 2, 3])).toBe(false);
  });

  it("new topics go after the topic they name; out-of-range anchors are clamped", () => {
    const order = placeNewTopics(["o1", "o2", "o3"], [
      { topic: "n-start", after: 0 },
      { topic: "n-after2", after: 2 },
      { topic: "n-end", after: 99 },
      { topic: "n-neg", after: -4 },
    ]);
    expect(order.map((o) => ("old" in o ? o.old : o.fresh))).toEqual(["n-start", "n-neg", "o1", "o2", "n-after2", "o3", "n-end"]);
  });
});
