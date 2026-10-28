// Lessons explain the slides instead of repeating them. A copy check (quotedFacts) finds facts the writer pasted word
// for word; too many of them get one repair call; a stored slide-by-slide lesson that mostly copies is rewritten once.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; system: string };
const calls: Call[] = [];
let lessonWriter: (call: number, content: string) => unknown = () => ({});
let lessonCalls = 0;

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string; system: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content, system: opts.system });
    if (opts.purpose === "lesson" || opts.purpose === "lesson repair") return lessonWriter(++lessonCalls, opts.content);
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, type Topic } from "@/lib/db";
import { getLesson, lessonIsCurrent, lessonText, LESSON_VERSION } from "@/lib/study";
import { coveredFacts, QUOTE_MIN_WORDS, quotedFacts } from "@/lib/lessonCoverage";
import { makeUser } from "./helpers";

// Each slide's facts carry their own code words (k0a…), so one slide's copied sentence can't pass as another slide's.
const FACT_A = (i: number) => `Cystatin C-based estimates for GFR k${i}a are believed to be less influenced by muscle mass or diet k${i}b`;
const FACT_B = (i: number) => `Creatinine comes from muscle breakdown k${i}c and varies with diet k${i}d`;
/** The slide's sentences pasted as they are. */
const copy = (i: number) => `${FACT_A(i)}. ${FACT_B(i)}.`;
/** The same facts said another way (every key word there, no long run of the slide's words). */
const explain = (i: number) =>
  `Because creatinine is made by muscle, a muscular or frail patient ${i} gets a misleading number; cystatin C is made by all cells at a steady rate, so a GFR estimate from it is less influenced by diet and muscle mass. ` +
  `Creatinine comes from muscle breakdown, so a meat-heavy diet ${i} or big muscles change it.`;

const notesJson = (i: number, facts: string[]) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: false, emphasis_note: null,
    case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

function world(n = 3, facts: (i: number) => string[] = (i) => [FACT_A(i), FACT_B(i)]) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, 0, 1.5)")
        .run(doc, i + 1, notesJson(i, facts(i))).lastInsertRowid,
    ),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, pages, topicId, topic };
}
type World = ReturnType<typeof world>;
const lessonOf = (w: World, text: (i: number) => string, extra: object = {}) => ({
  intro: "What kidney-function estimates are good for.",
  slides: w.pages.map((page_id, i) => ({ page_id, explanation: text(i) })),
  key_points: ["k"],
  connections: null,
  ...extra,
});
const stored = (w: World, lesson: object) => db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), w.topicId);
const repair = () => calls.find((c) => c.purpose === "lesson repair");
const repairAsk = () => {
  const c = repair()!.content;
  return c.slice(c.indexOf("Your previous lesson"));
};

beforeEach(() => {
  calls.length = 0;
  lessonCalls = 0;
  lessonWriter = () => ({});
});

describe("quotedFacts: which facts a text repeats word for word", () => {
  it("an exact copy is quoted; punctuation, case and markdown don't hide it", () => {
    const f = "Cystatin C-based estimates for GFR are less influenced by muscle mass";
    const r = quotedFacts(`Note: **cystatin C**-based estimates for GFR are less influenced by muscle mass!`, [f]);
    expect(r).toEqual({ quoted: [f], judged: 1, ratio: 1 });
  });

  it("a run of 70% of the fact's words in order counts; a shorter run does not", () => {
    const f = "one two three four five six seven eight nine ten"; // 10 words → a run of 7
    expect(quotedFacts("so: one two three four five six seven, then other things", [f]).quoted).toEqual([f]);
    expect(quotedFacts("so: one two three four five six, then other things", [f]).quoted).toEqual([]);
    expect(quotedFacts("four five six seven eight nine ten is the end", [f]).quoted).toEqual([f]); // a run from the middle
  });

  it(`facts under ${QUOTE_MIN_WORDS} words are not judged and don't count in the ratio`, () => {
    const r = quotedFacts("GFR under 60 means CKD. Pulp is the nerve.", ["GFR under 60", "pulp is nerve"]);
    expect(r).toEqual({ quoted: [], judged: 0, ratio: 0 });
    // five words is enough to be judged
    expect(quotedFacts("yes the pulp is the nerve inside", ["the pulp is the nerve"]).quoted).toEqual(["the pulp is the nerve"]);
  });

  it("an explanation in other words is not quoted even though it covers the fact", () => {
    const f = FACT_A(0);
    expect(coveredFacts(explain(0), [f]).ratio).toBe(1);
    expect(quotedFacts(explain(0), [f])).toEqual({ quoted: [], judged: 1, ratio: 0 });
  });

  it("the ratio is copied over judged", () => {
    const facts = [FACT_A(0), FACT_B(0), "short one", FACT_A(1)];
    const r = quotedFacts(`${FACT_A(0)}. ${explain(1)}`, facts);
    expect(r.quoted).toEqual([FACT_A(0)]);
    expect(r.judged).toBe(3);
    expect(r.ratio).toBeCloseTo(1 / 3);
  });

  it("empty text or no facts: nothing quoted, ratio 0", () => {
    expect(quotedFacts("", [FACT_A(0)])).toEqual({ quoted: [], judged: 1, ratio: 0 });
    expect(quotedFacts("anything", [])).toEqual({ quoted: [], judged: 0, ratio: 0 });
  });
});

describe("the lesson writer is asked to explain, not copy", () => {
  it("the system prompt says so, with a bad-versus-good example, and the slide list asks for the facts in its own words", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, explain);
    await getLesson(w.topic());
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toMatch(/Explain, never copy/);
    expect(calls[0].system).toMatch(/Bad, a copy: "Cystatin C-based estimates/);
    expect(calls[0].system).toMatch(/Good, an explanation: "Creatinine comes from muscle/);
    expect(calls[0].system).toMatch(/the words around them are yours/);
    expect(calls[0].content).toMatch(/must be explained, in your own words, in that slide's entry/);
  });

  it("a lesson that explains every fact gets no repair call and is stored as the current version", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, explain);
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(lesson.version).toBe(LESSON_VERSION);
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("a lesson that pastes the slides gets one repair call naming the copied lines; the explained rewrite is kept", async () => {
    const w = world();
    lessonWriter = (n) => (n === 1 ? lessonOf(w, copy) : lessonOf(w, explain));
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    const ask = repairAsk();
    expect(ask).toMatch(/^Your previous lesson repeated the slides instead of explaining them\. Write the whole lesson again, keeping every fact, but say each one in your own words:/);
    expect(ask).toMatch(/copied from the slides word for word/);
    for (let i = 0; i < 3; i++) {
      expect(ask).toContain(`- ${FACT_A(i)}`);
      expect(ask).toContain(`- ${FACT_B(i)}`);
    }
    expect(lessonText(lesson)).toContain("a muscular or frail patient 0");
    expect(quotedFacts(lessonText(lesson), [FACT_A(0), FACT_B(1)]).ratio).toBe(0);
    expect(lesson.version).toBe(LESSON_VERSION);
  });

  it("a few copied lines are tolerated (no repair below the limit)", async () => {
    const w = world(5);
    // 10 judged facts; slide 0 copied (2 of 10 = 20%), the rest explained
    lessonWriter = () => lessonOf(w, (i) => (i === 0 ? copy(i) : explain(i)));
    await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
  });

  it("when the lesson both copies and leaves facts out, the repair asks for both", async () => {
    const w = world(4, (i) => (i === 3 ? ["Lithium toxicity causes nephrogenic diabetes insipidus and polyuria"] : [FACT_A(i), FACT_B(i)]));
    // slides 0-1 copied, slide 2 explained, slide 3 skipped
    lessonWriter = (n) =>
      n === 1
        ? { ...lessonOf(w, copy), slides: w.pages.slice(0, 3).map((page_id, i) => ({ page_id, explanation: i < 2 ? copy(i) : explain(i) })) }
        : lessonOf(w, explain);
    await getLesson(w.topic());
    const ask = repairAsk();
    expect(ask).toMatch(/^Your previous lesson left things out and repeated the slides instead of explaining them\./);
    expect(ask).toContain(`- [P${w.pages[3]}] L1.pdf slide 4`);
    expect(ask).toContain("- Lithium toxicity causes nephrogenic diabetes insipidus and polyuria"); // missing
    expect(ask).toContain(`- ${FACT_A(0)}`); // copied
    expect(ask).toMatch(/explain each one under its slide/);
  });

  it("a repair that copies even more than before is thrown away; the first lesson stands", async () => {
    const w = world(4);
    // first: slides 0-1 copied, 2-3 explained (50% copied → repair); repair: everything copied
    lessonWriter = (n) => (n === 1 ? lessonOf(w, (i) => (i < 2 ? copy(i) : explain(i))) : lessonOf(w, copy));
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    expect(lessonText(lesson)).toContain("a muscular or frail patient 2");
    expect(lesson.version).toBe(LESSON_VERSION);
  });

  it("a repair that explains is kept even when the word check now misses a few facts (an explanation may use other words)", async () => {
    const LITHIUM = "Lithium toxicity causes nephrogenic diabetes insipidus and polyuria";
    const w = world(5, (i) => (i === 4 ? [FACT_A(i), LITHIUM] : [FACT_A(i), FACT_B(i)]));
    // the rewrite says the lithium fact in words the check can't match: coverage drops from 1 to 0.9
    lessonWriter = (n) =>
      n === 1
        ? lessonOf(w, (i) => (i === 4 ? `${FACT_A(i)}. ${LITHIUM}.` : copy(i)))
        : lessonOf(w, (i) => (i === 4 ? `${explain(i)} Too much of the mood drug makes the kidney stop concentrating urine, so she passes a lot of it.` : explain(i)));
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    expect(coveredFacts(lessonText(lesson), [LITHIUM]).ratio).toBe(0);
    expect(lessonText(lesson)).not.toContain(FACT_A(0) + ".");
  });

  it("a repair that loses a slide is thrown away even if it explains", async () => {
    const w = world(3);
    lessonWriter = (n) => (n === 1 ? lessonOf(w, copy) : { ...lessonOf(w, explain), slides: w.pages.slice(0, 2).map((page_id, i) => ({ page_id, explanation: explain(i) })) });
    const lesson = await getLesson(w.topic());
    expect(lesson.slides).toHaveLength(3);
    expect(lessonText(lesson)).toContain(FACT_A(0));
  });
});

describe("stored lessons: which ones are rewritten", () => {
  it("a version-3 lesson that explains is kept (no AI call); one that copies is rewritten once", async () => {
    const keep = world();
    stored(keep, { ...lessonOf(keep, explain), version: 3 });
    expect(lessonIsCurrent(keep.topic())).toBe(true);
    const got = await getLesson(keep.topic());
    expect(calls).toHaveLength(0);
    expect(got.version).toBe(3);

    const redo = world();
    stored(redo, { ...lessonOf(redo, copy), version: 3 });
    expect(lessonIsCurrent(redo.topic())).toBe(false);
    lessonWriter = () => lessonOf(redo, explain);
    const fresh = await getLesson(redo.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(fresh.version).toBe(LESSON_VERSION);
    expect(lessonIsCurrent(redo.topic())).toBe(true);
    await getLesson(redo.topic());
    expect(calls).toHaveLength(1); // cached now
  });

  it("a version-3 lesson over a section whose facts are all short is kept (nothing to judge)", () => {
    const w = world(3, (i) => [`fact a${i}`, `fact b${i}`]);
    stored(w, { ...lessonOf(w, () => "fact a0 fact b0 fact a1 fact b1 fact a2 fact b2"), version: 3 });
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("a version-3 lesson right at the limit is kept; just over it is not", () => {
    const w = world(10); // 20 judged facts
    const text = (copied: number) => (i: number) => (i < copied ? copy(i) : explain(i));
    stored(w, { ...lessonOf(w, text(3)), version: 3 }); // 6/20 = 30%
    expect(lessonIsCurrent(w.topic())).toBe(true);
    stored(w, { ...lessonOf(w, text(4)), version: 3 }); // 8/20 = 40%
    expect(lessonIsCurrent(w.topic())).toBe(false);
  });

  it("older versions and damaged lessons are rewritten; the current version is kept whatever it says", () => {
    const w = world();
    stored(w, { ...lessonOf(w, explain), version: 2 });
    expect(lessonIsCurrent(w.topic())).toBe(false);
    stored(w, { ...lessonOf(w, copy), version: LESSON_VERSION });
    expect(lessonIsCurrent(w.topic())).toBe(true);
    db.prepare("UPDATE topics SET lesson_json = 'nope' WHERE id = ?").run(w.topicId);
    expect(lessonIsCurrent(w.topic())).toBe(false);
  });
});
