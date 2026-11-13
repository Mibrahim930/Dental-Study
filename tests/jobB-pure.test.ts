import { describe, expect, it } from "vitest";
import { cleanTopics, matchTopics, sameSlides, type SlideRef } from "@/lib/topicMerge";

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

describe("matchTopics", () => {
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

});
