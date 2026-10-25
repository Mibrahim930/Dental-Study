// Release 3, Job B: a section quiz has about one question per distinct fact (floor 5, ceiling 25), never the same fact twice.
import { describe, expect, it } from "vitest";
import { planQuizByFacts, QUIZ_MAX, QUIZ_MIN, quizSize, type FactSlide } from "@/lib/quizPlan";

const slide = (id: number, facts: string[], extra: Partial<FactSlide> = {}): FactSlide => ({ id, keyFacts: facts.length, emphasized: false, hasCase: false, facts, ...extra });

describe("quizSize", () => {
  it("counts distinct facts, floor 5, ceiling 25", () => {
    expect(quizSize([])).toBe(QUIZ_MIN);
    expect(quizSize([slide(1, ["a", "b"])])).toBe(QUIZ_MIN);
    expect(quizSize([slide(1, ["a", "b", "c"]), slide(2, ["d", "e", "f", "g"])])).toBe(7);
    const dense = Array.from({ length: 10 }, (_, i) => slide(i + 1, ["p", "q", "r", "s"].map((f) => `${f}${i}`)));
    expect(quizSize(dense)).toBe(QUIZ_MAX);
  });

  it("the same fact on two slides counts once; a slide with no facts counts once", () => {
    expect(quizSize([slide(1, ["Apical constriction is 0.5-1 mm from the foramen"]), slide(2, ["apical constriction is 0.5-1 mm from the foramen!"]), slide(3, [])])).toBe(QUIZ_MIN);
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

  it("when the ceiling cuts, stressed slides' facts survive first, then case slides, back in slide order", () => {
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

  it("below the floor, extra slots take other angles on the most important slides without pinning a fact", () => {
    const slots = planQuizByFacts([slide(1, ["only fact"], { emphasized: true }), slide(2, [])]);
    expect(slots).toHaveLength(QUIZ_MIN);
    expect(slots.filter((s) => s.fact === "only fact")).toHaveLength(1);
    const extras = slots.slice(2);
    expect(extras.every((s) => s.fact === null)).toBe(true);
    expect(extras[0].page).toBe(1); // the stressed slide first
    expect(extras.every((s) => s.angle !== "not")).toBe(true); // "which is NOT" only for list slides (4+ facts)
  });

  it("a one-slide section still reaches the floor (BUG found by QA: the extra-slot loop used to give up early)", () => {
    expect(planQuizByFacts([slide(1, ["a", "b"])])).toHaveLength(QUIZ_MIN);
    expect(planQuizByFacts([slide(1, [])])).toHaveLength(QUIZ_MIN);
    const two = planQuizByFacts([slide(1, ["only"]), slide(2, [])]);
    expect(two).toHaveLength(QUIZ_MIN);
    expect(two.every((s) => s.page === 1 || s.page === 2)).toBe(true);
  });

  it("with no slides, slots test the topic in general", () => {
    const slots = planQuizByFacts([], 5);
    expect(slots).toHaveLength(5);
    expect(slots.every((s) => s.page === null && s.fact === null)).toBe(true);
  });

  it("respects an explicit size and never exceeds it", () => {
    const dense = Array.from({ length: 10 }, (_, i) => slide(i + 1, ["p", "q", "r", "s"].map((f) => `${f}${i}`)));
    expect(planQuizByFacts(dense)).toHaveLength(QUIZ_MAX);
    expect(planQuizByFacts(dense, 8)).toHaveLength(8);
    expect(planQuizByFacts(dense, 0)).toEqual([]);
  });
});
