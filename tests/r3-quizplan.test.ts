// Release 3, Job B: a section quiz has exactly one question per distinct fact (no floor, no cap since the repeat-question fix), never the same fact twice.
import { describe, expect, it } from "vitest";
import { planQuizByFacts, quizSize, type FactSlide } from "@/lib/quizPlan";

const slide = (id: number, facts: string[], extra: Partial<FactSlide> = {}): FactSlide => ({ id, keyFacts: facts.length, emphasized: false, hasCase: false, facts, ...extra });

describe("quizSize", () => {
  it("counts distinct facts: no floor (a small section gets a short quiz), no cap (a big one is covered whole), at least 1", () => {
    expect(quizSize([])).toBe(1);
    expect(quizSize([slide(1, ["a", "b"])])).toBe(2);
    expect(quizSize([slide(1, ["a", "b", "c"]), slide(2, ["d", "e", "f", "g"])])).toBe(7);
    const dense = Array.from({ length: 10 }, (_, i) => slide(i + 1, ["p", "q", "r", "s"].map((f) => `${f}${i}`)));
    expect(quizSize(dense)).toBe(40);
  });

  it("the same fact on two slides counts once; a slide with no facts counts once", () => {
    expect(quizSize([slide(1, ["Apical constriction is 0.5-1 mm from the foramen"]), slide(2, ["apical constriction is 0.5-1 mm from the foramen!"]), slide(3, [])])).toBe(2);
    const six = [slide(1, ["a", "b", "c"]), slide(2, ["A", "d", "e"]), slide(3, ["f"]), slide(4, [])];
    expect(quizSize(six)).toBe(7); // a b c d e f + one for the empty slide
  });
});

describe("planQuizByFacts", () => {
  it("one slot per distinct fact, in slide order, with the fact pinned", () => {
    const slots = planQuizByFacts([slide(1, ["a", "b", "c"]), slide(2, ["d", "e", "f"])]);
    expect(slots).toHaveLength(6);
    expect(slots.map((s) => s.fact)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(slots.map((s) => s.page)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(new Set(slots.map((s) => s.fact)).size).toBe(6);
    // Angles vary so the quiz isn't all recall.
    expect(new Set(slots.map((s) => s.angle)).size).toBeGreaterThan(1);
  });

  it("never pins the same fact twice even when slides repeat it", () => {
    const slots = planQuizByFacts([slide(1, ["x", "y"]), slide(2, ["X", "z"]), slide(3, ["y"])], 3);
    expect(slots.map((s) => s.fact)).toEqual(["x", "y", "z"]);
  });

  it("with an explicit smaller size, stressed slides' facts survive first, then case slides, back in slide order", () => {
    const slides = [
      slide(1, ["a1", "a2", "a3"]),
      slide(2, ["b1", "b2"], { emphasized: true }),
      slide(3, ["c1", "c2"], { hasCase: true }),
      slide(4, ["d1", "d2", "d3"]),
    ];
    const slots = planQuizByFacts(slides, 5);
    expect(slots).toHaveLength(5);
    const facts = slots.map((s) => s.fact);
    expect(facts).toEqual(expect.arrayContaining(["b1", "b2", "c1", "c2"]));
    expect(facts[0]).toBe("a1"); // the one remaining slot goes to the earliest other fact, and order is slide order
    expect(facts.indexOf("b1")).toBeLessThan(facts.indexOf("c1"));
  });

  it("never more slots than facts: a small section gets a short quiz, nothing is padded (padding made the writer repeat itself)", () => {
    const slots = planQuizByFacts([slide(1, ["only fact"], { emphasized: true }), slide(2, [])]);
    expect(slots).toHaveLength(2); // the fact, plus the fact-less slide in general
    expect(slots[0]).toMatchObject({ page: 1, fact: "only fact" });
    expect(slots[1]).toMatchObject({ page: 2, fact: null });
    expect(planQuizByFacts([slide(1, ["a", "b"])])).toHaveLength(2);
    expect(planQuizByFacts([slide(1, [])])).toHaveLength(1);
    expect(planQuizByFacts([slide(1, ["a", "b"])], 10)).toHaveLength(2); // an explicit size can't add questions either
  });

  it("with no slides, one slot tests the topic in general (more only when a size is asked for)", () => {
    expect(planQuizByFacts([])).toHaveLength(1);
    const slots = planQuizByFacts([], 5);
    expect(slots).toHaveLength(5);
    expect(slots.every((s) => s.page === null && s.fact === null)).toBe(true);
  });

  it("respects an explicit size and never exceeds it", () => {
    const dense = Array.from({ length: 10 }, (_, i) => slide(i + 1, ["p", "q", "r", "s"].map((f) => `${f}${i}`)));
    expect(planQuizByFacts(dense)).toHaveLength(40);
    expect(planQuizByFacts(dense, 8)).toHaveLength(8);
    expect(planQuizByFacts(dense, 0)).toEqual([]);
  });
});
