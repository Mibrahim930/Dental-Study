// Wave 2, lessons and section quizzes (audit L1, L2, L4, M6, M7): lessons written in parts of at most five slides with
// numbered facts and a targeted repair; the section quiz checked by the shared validateMcq and judged by slot number.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; raw: unknown; system: string; maxTokens?: number; cache?: boolean; schema: { shape: Record<string, unknown> } };
const calls: Call[] = [];
let lessonWriter: (call: Call) => unknown = () => ({});
let quizWriter: (slots: { n: number; page: number }[]) => unknown[] = () => [];
let judge: (listed: number[]) => unknown[] = (listed) => listed.map((n) => ({ n, ok: true, picture: false, reason: "" }));
let inFlight = 0;
let maxInFlight = 0;

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: unknown; system: string; maxTokens?: number; cache?: boolean; schema: { shape: Record<string, unknown> } }) => {
    const call: Call = { purpose: opts.purpose, content: promptText(opts.content), raw: opts.content, system: opts.system, maxTokens: opts.maxTokens, cache: opts.cache, schema: opts.schema };
    calls.push(call);
    if (opts.purpose === "lesson" || opts.purpose === "lesson repair") {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return claimAll(opts.content, await lessonWriter(call));
      } finally {
        inFlight--;
      }
    }
    if (opts.purpose === "section quiz") {
      const slots = [...call.content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return { questions: quizWriter(slots) };
    }
    if (opts.purpose === "section quiz check") return { verdicts: judge([...call.content.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))) };
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, type Topic } from "@/lib/db";
import { getLesson, getSectionQuiz, LESSON_VERSION, lessonParts, recentFailure, type QuizQuestion } from "@/lib/study";
import { makeUser } from "./helpers";
import { claimAll, factIdsInPrompt, promptText, slidesInPrompt } from "./lessonClaims";

const notesJson = (i: number, facts: string[], o: { emphasized?: boolean; case_prompt?: string } = {}) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: !!o.emphasized, emphasis_note: null,
    case_prompt: o.case_prompt ?? null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

/** One exam, one topic over n slides with two facts each (each with its own code word). */
function world(n: number, facts: (i: number) => string[] = (i) => [`first fact k${i}a`, `second fact k${i}b`]) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const insert = db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, 0, 1.5)");
  const pages = Array.from({ length: n }, (_, i) => Number(insert.run(doc, i + 1, notesJson(i, facts(i))).lastInsertRowid));
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 'about T', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, pages, topicId, topic };
}
type World = ReturnType<typeof world>;

/** A writer that explains every slide it was given (claimAll then claims all their facts). */
const explainAll = (c: Call) => ({
  intro: "What T is about.",
  slides: slidesInPrompt(c.raw).map((page_id) => ({ page_id, explanation: `Explained ${page_id} in plain words.` })),
  key_points: ["★ one", "two"],
  connections: null,
});
const isRepair = (c: Call) => c.purpose === "lesson repair";
const lessonCalls = () => calls.filter((c) => c.purpose.startsWith("lesson"));
const pagesOf = (w: World, from: number, to: number) => w.pages.slice(from, to);

beforeEach(() => {
  calls.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  lessonWriter = explainAll;
  quizWriter = () => [];
  judge = (listed) => listed.map((n) => ({ n, ok: true, picture: false, reason: "" }));
});

describe("L1: a lesson is written in parts of at most five slides", () => {
  it("part sizes: in order, as even as possible", () => {
    const sizes = (n: number) => lessonParts(Array.from({ length: n }, (_, i) => i)).map((p) => p.length);
    expect(sizes(1)).toEqual([1]);
    expect(sizes(5)).toEqual([5]);
    expect(sizes(6)).toEqual([3, 3]);
    expect(sizes(11)).toEqual([4, 4, 3]);
    expect(sizes(25)).toEqual([5, 5, 5, 5, 5]);
    expect(sizes(0)).toEqual([0]);
    expect(lessonParts([1, 2, 3, 4, 5, 6, 7]).flat()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a section of up to five slides is exactly one call, which also writes the intro, key points and connections", async () => {
    const w = world(4);
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(Object.keys(calls[0].schema.shape).sort()).toEqual(["connections", "intro", "key_points", "slides"]);
    expect(calls[0].maxTokens).toBe(1200 * 4 + 2500 + 1000);
    expect(calls[0].cache).toBe(false);
    expect(calls[0].content).not.toMatch(/This is part/);
    expect(lesson.intro).toBe("What T is about.");
    expect(lesson.key_points).toEqual(["★ one", "two"]);
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("a 12-slide section is three calls of four slides; only the first writes the intro; later ones are told what came before", async () => {
    const w = world(12);
    const lesson = await getLesson(w.topic());
    const ls = lessonCalls();
    expect(ls.map((c) => c.purpose)).toEqual(["lesson", "lesson", "lesson"]);
    expect(ls.map((c) => slidesInPrompt(c.raw))).toEqual([pagesOf(w, 0, 4), pagesOf(w, 4, 8), pagesOf(w, 8, 12)]);
    expect(Object.keys(ls[0].schema.shape)).toContain("intro");
    expect(Object.keys(ls[1].schema.shape)).toEqual(["slides"]);
    expect(ls.map((c) => c.maxTokens)).toEqual([1200 * 4 + 3500, 1200 * 4 + 2500, 1200 * 4 + 2500]);
    for (const c of ls) expect(c.maxTokens!).toBeLessThan(24000);
    // the first part sees the rest of the section in short, for the intro and key points
    expect(ls[0].content).toMatch(/The rest of the section, only for the intro and key points[^\n]*\n- slide 4: first fact k4a; second fact k4b\n/);
    expect(ls[0].content).toContain("No related material from earlier exams.");
    expect(ls[1].content).not.toContain("The rest of the section");
    expect(ls[1].content).not.toContain("earlier exams");
    expect(ls[0].content).toContain("This is part 1 of 3 of the section.");
    expect(ls[2].content).toContain("This is part 3 of 3 of the section. Earlier parts covered:\n- Part 1: slide 0; slide 1; slide 2; slide 3\n- Part 2: slide 4; slide 5; slide 6; slide 7");
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
    expect(lesson.intro).toBe("What T is about.");
  });

  it("at most two calls run at a time (25 slides: five calls)", async () => {
    const w = world(25);
    await getLesson(w.topic());
    expect(lessonCalls()).toHaveLength(5);
    expect(maxInFlight).toBe(2);
  });

  it("an entry for a slide of another part is ignored", async () => {
    const w = world(6);
    lessonWriter = (c) => ({ ...explainAll(c), slides: w.pages.map((page_id) => ({ page_id, explanation: slidesInPrompt(c.raw).includes(page_id) ? "mine" : "NOT MINE" })) });
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.every((s) => s.explanation === "mine")).toBe(true);
  });
});

describe("L1: numbered facts and exact coverage", () => {
  it("facts are numbered F1…Fn across the section, in slide order and across parts", async () => {
    const w = world(7);
    await getLesson(w.topic());
    const ids = new Map(lessonCalls().flatMap((c) => [...factIdsInPrompt(c.raw)]));
    expect(w.pages.map((p) => ids.get(p))).toEqual(w.pages.map((_, i) => [2 * i + 1, 2 * i + 2]));
    expect(lessonCalls()[1].content).toContain("- F9: first fact k4a");
  });

  it("every fact claimed: no repair; one fact not claimed: a repair asks for exactly that fact on exactly that slide, and the answer is added", async () => {
    const w = world(3);
    lessonWriter = (c) =>
      isRepair(c)
        ? { slides: [{ page_id: w.pages[1], explanation: "The second fact, explained." }] }
        : { ...explainAll(c), slides: w.pages.map((page_id, i) => ({ page_id, explanation: `Entry ${i}.`, ...(i === 1 ? { facts: [3] } : {}) })) };
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    const rep = calls[1].content;
    expect(slidesInPrompt(rep)).toEqual([w.pages[1]]);
    expect(rep).toContain("To do: explain F4, which the entry leaves out. Write only the new part");
    expect(rep).toContain('Its entry so far (between the lines):\n"""\nEntry 1.\n"""');
    expect(lesson.slides[1].explanation).toBe("Entry 1.\n\nThe second fact, explained.");
    expect(lesson.slides[0].explanation).toBe("Entry 0.");
  });

  it("fact numbers that belong to another slide are ignored (and so the other slide's fact counts as missing)", async () => {
    const w = world(2);
    lessonWriter = (c) =>
      isRepair(c)
        ? { slides: [] }
        : { ...explainAll(c), slides: [{ page_id: w.pages[0], explanation: "Both slides here.", facts: [1, 2, 3, 4] }, { page_id: w.pages[1], explanation: "Thin.", facts: [] }] };
    await getLesson(w.topic());
    const rep = calls.find(isRepair)!.content;
    expect(slidesInPrompt(rep)).toEqual([w.pages[1]]);
    expect(rep).toContain("explain F3, F4, which the entry leaves out");
  });

  it("'F7' strings are read as 7; numbers outside the section are ignored", async () => {
    const w = world(1);
    lessonWriter = () => ({ intro: "i", slides: [{ page_id: w.pages[0], explanation: "e", facts: ["F1", "f2", 99] }], key_points: [], connections: null });
    await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
  });

  it("a slide with facts or a case and no entry is asked to be written; a fact-less slide may be left out", async () => {
    const w = world(3, (i) => (i === 1 ? [] : [`fact k${i}`]));
    db.prepare("UPDATE pages SET notes_json = ? WHERE id = ?").run(notesJson(1, [], { case_prompt: "Which tooth?" }), w.pages[1]);
    const w2 = world(2, (i) => (i === 0 ? [] : [`fact k${i}`]));
    lessonWriter = (c) => (isRepair(c) ? explainAll(c) : { ...explainAll(c), slides: [] });
    await getLesson(w.topic());
    const rep = calls.find(isRepair)!.content;
    expect(slidesInPrompt(rep)).toEqual(w.pages);
    expect(rep).toContain("To do: this slide got no entry. Write it, and answer its case from the slides.");
    calls.length = 0;
    await getLesson(w2.topic());
    expect(slidesInPrompt(calls.find(isRepair)!.content)).toEqual([w2.pages[1]]);
  });

  it("there is no whole-lesson rewrite: the repair carries only the slides that need it", async () => {
    const w = world(12);
    lessonWriter = (c) => (isRepair(c) ? explainAll(c) : { ...explainAll(c), slides: explainAll(c).slides.filter((s) => s.page_id !== w.pages[9]) });
    await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson", "lesson", "lesson repair"]);
    expect(slidesInPrompt(calls[3].raw)).toEqual([w.pages[9]]);
    expect(calls.some((c) => /whole lesson/i.test(c.content))).toBe(false);
    expect(calls[3].maxTokens).toBe(1200 + 2500);
  });

  it("a part that mostly copies the slides has its copied slides re-asked, to be explained; the other part is left alone", async () => {
    const long = (i: number, k: string) => `The ${k} fact of slide number ${i} is a long sentence about teeth`;
    const w = world(6, (i) => [long(i, "first"), long(i, "second")]);
    lessonWriter = (c) => {
      if (isRepair(c)) return { slides: slidesInPrompt(c.raw).map((page_id) => ({ page_id, explanation: "Now in her own words." })) };
      const mine = slidesInPrompt(c.raw);
      return { ...explainAll(c), slides: mine.map((page_id) => ({ page_id, explanation: w.pages.indexOf(page_id) < 3 ? `${long(w.pages.indexOf(page_id), "first")}. ${long(w.pages.indexOf(page_id), "second")}.` : "Explained." })) };
    };
    const lesson = await getLesson(w.topic());
    const rep = calls.find(isRepair)!.content;
    expect(slidesInPrompt(rep)).toEqual(pagesOf(w, 0, 3));
    expect(rep.match(/repeats the slide's sentences instead of explaining them\. Write it again in your own words/g)).toHaveLength(3);
    expect(lesson.slides.map((s) => s.explanation)).toEqual(["Now in her own words.", "Now in her own words.", "Now in her own words.", "Explained.", "Explained.", "Explained."]);
  });
});

describe("L1: failures", () => {
  const RAMBLE = "Done.\n\nOk.\n\nStop.\n\nBye.";

  it("a part that fails is tried once more; the lesson is whole", async () => {
    const w = world(12);
    let failed = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lessonWriter = (c) => {
      if (!failed && slidesInPrompt(c.raw)[0] === w.pages[4]) {
        failed = true;
        throw new Error("529 overloaded");
      }
      return explainAll(c);
    };
    const lesson = await getLesson(w.topic());
    warn.mockRestore();
    expect(lessonCalls()).toHaveLength(4);
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("a part that fails twice fails the whole lesson: nothing stored, the failure marked, no repair", async () => {
    const w = world(12);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lessonWriter = (c) => {
      if (slidesInPrompt(c.raw)[0] === w.pages[4]) throw new Error("529 overloaded");
      return explainAll(c);
    };
    await expect(getLesson(w.topic())).rejects.toThrow("529 overloaded");
    warn.mockRestore();
    expect(w.topic().lesson_json).toBeNull();
    expect(recentFailure("lesson", w.topicId)).toBe(true);
    expect(lessonCalls().filter((c) => slidesInPrompt(c.raw)[0] === w.pages[4])).toHaveLength(2);
    expect(calls.some(isRepair)).toBe(false);
  });

  it("a failed rewrite keeps the stored slide-by-slide lesson she had (version 3), stored as it was", async () => {
    const long = (i: number, k: string) => `The ${k} fact of slide number ${i} is a long sentence about teeth`;
    const w = world(3, (i) => [long(i, "first"), long(i, "second")]);
    // a version-3 lesson that copies the slides: not current, so it is rewritten on open
    const old = { intro: "old", slides: w.pages.map((page_id, i) => ({ page_id, explanation: `${long(i, "first")}. ${long(i, "second")}.` })), key_points: [], connections: null, version: 3 };
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(old), w.topicId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    lessonWriter = () => {
      throw new Error("down");
    };
    const got = await getLesson(w.topic());
    warn.mockRestore();
    error.mockRestore();
    expect(got.intro).toBe("old");
    expect(lessonCalls()).toHaveLength(2);
    expect(JSON.parse(w.topic().lesson_json!)).toEqual(old);
    expect(recentFailure("lesson", w.topicId)).toBe(true);
  });

  it("a part cut off for length is tried again as two halves; the first half still writes the intro", async () => {
    const w = world(5);
    let cut = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lessonWriter = (c) => {
      if (!cut) {
        cut = true;
        throw new Error("The answer was cut off (too long). Try a smaller request.");
      }
      return explainAll(c);
    };
    const lesson = await getLesson(w.topic());
    warn.mockRestore();
    const ls = lessonCalls();
    expect(ls.map((c) => slidesInPrompt(c.raw))).toEqual([w.pages, pagesOf(w, 0, 3), pagesOf(w, 3, 5)]);
    expect(Object.keys(ls[1].schema.shape)).toContain("intro");
    expect(Object.keys(ls[2].schema.shape)).toEqual(["slides"]);
    expect(ls[2].content).not.toContain("The rest of the section");
    expect(ls[1].content).toContain("The rest of the section"); // the other half, for the key points
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
    expect(lesson.intro).toBe("What T is about.");
  });

  it("a single slide cut off for length is tried again with twice the room", async () => {
    const w = world(1);
    let cut = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lessonWriter = (c) => {
      if (!cut) {
        cut = true;
        throw new Error("The answer was cut off (too long). Try a smaller request.");
      }
      return explainAll(c);
    };
    await getLesson(w.topic());
    warn.mockRestore();
    expect(lessonCalls().map((c) => c.maxTokens)).toEqual([4700, 9400]);
  });

  it("filler is trimmed from every entry; an entry of nothing but filler counts as not written", async () => {
    const w = world(2);
    lessonWriter = (c) =>
      isRepair(c)
        ? { slides: [{ page_id: w.pages[1], explanation: `Written now.\n\n${RAMBLE}` }] }
        : { ...explainAll(c), slides: [{ page_id: w.pages[0], explanation: `Real text.\n\n${RAMBLE}` }, { page_id: w.pages[1], explanation: RAMBLE }] };
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.map((s) => s.explanation)).toEqual(["Real text.", "Written now."]);
    expect(slidesInPrompt(calls.find(isRepair)!.content)).toEqual([w.pages[1]]);
  });
});

describe("L1: what is stored and logged", () => {
  it("the stored lesson has exactly the old shape: no fact numbers, version 4", async () => {
    const w = world(7);
    await getLesson(w.topic());
    const stored = JSON.parse(w.topic().lesson_json!);
    expect(Object.keys(stored).sort()).toEqual(["connections", "intro", "key_points", "slides", "version"]);
    expect(stored.version).toBe(LESSON_VERSION);
    expect(LESSON_VERSION).toBe(4);
    for (const s of stored.slides) expect(Object.keys(s).sort()).toEqual(["explanation", "page_id"]);
  });

  it("the calls are logged as 'lesson' and 'lesson repair'", async () => {
    const w = world(2);
    lessonWriter = (c) => (isRepair(c) ? explainAll(c) : { ...explainAll(c), slides: [] });
    await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
  });

  it("caching only where the opening of the request is really sent again: from three parts on", async () => {
    const small = world(10);
    await getLesson(small.topic());
    expect(lessonCalls().every((c) => c.cache === false && typeof c.raw === "string")).toBe(true);
    calls.length = 0;
    const big = world(11);
    lessonWriter = (c) => (isRepair(c) ? explainAll(c) : { ...explainAll(c), slides: explainAll(c).slides.slice(1) });
    await getLesson(big.topic());
    const ls = lessonCalls();
    expect(ls.map((c) => c.purpose)).toEqual(["lesson", "lesson", "lesson", "lesson repair"]);
    for (const c of ls) {
      expect(c.cache).toBe(true);
      // the same first block every time: the section line
      expect((c.raw as { text: string }[])[0].text).toBe("Section: T\nabout T");
    }
  });
});

describe("L4: the lesson prompt states each rule once", () => {
  it("the system prompt carries the rules; the schema and the request carry none of them", async () => {
    const w = world(2);
    await getLesson(w.topic());
    const { system, content, schema } = calls[0];
    expect(system).toContain('say so in its entry ("★ you emphasized this")');
    expect(system).toContain("About 2 to 5 sentences per fact");
    expect(system).toMatch(/Explain, never copy/);
    expect(system).toMatch(/Bad, a copy: /);
    expect(system).toMatch(/Don't cite slide numbers/);
    expect(system).toMatch(/the words around them are yours/);
    expect(system).toMatch(/An entry ends when the slide is explained\. No closing words/);
    expect(system.match(/never copy/gi)).toHaveLength(1);
    const described = JSON.stringify(schema.shape.slides);
    expect(described).not.toMatch(/own words|never|copy/i);
    expect(content).not.toMatch(/own words|must be explained/i);
  });
});

describe("L2: the section quiz uses validateMcq and matches the judge by slot", () => {
  const question = (s: { n: number; page: number }, o: object = {}) => ({
    slot: s.n,
    question: `Question ${s.n} about P${s.page}?`,
    options: ["right", "w1", "w2", "w3"],
    correct_index: 0,
    correct_answer: "right",
    explanation: "because",
    option_notes: ["r", "a", "b", "c"],
    source_page_id: s.page,
    image_page_id: null,
    concept: "C",
    ...o,
  });

  it("a draft with three options, or whose answer text matches no option, is dropped; the slot is asked again", async () => {
    const w = world(2); // four facts: four questions, one call
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let round = 0;
    quizWriter = (slots) => {
      round++;
      return slots.map((s) =>
        round === 1 && s.n === 1 ? question(s, { options: ["right", "w1", "w2"] }) : round === 1 && s.n === 2 ? question(s, { correct_answer: "something else" }) : question(s),
      );
    };
    const quiz = await getSectionQuiz(w.topic());
    warn.mockRestore();
    const writes = calls.filter((c) => c.purpose === "section quiz");
    expect(writes).toHaveLength(2);
    expect([...writes[1].content.matchAll(/^Q(\d+):/gm)].map((m) => Number(m[1])).sort()).toEqual([1, 2]);
    expect(quiz).toHaveLength(4);
    expect(quiz.every((q: QuizQuestion) => q.options.length === 4 && q.options[q.correct_index] === "right")).toBe(true);
  });

  it("a draft whose source is not one of the section's slides is dropped", async () => {
    const w = world(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    quizWriter = (slots) => slots.map((s) => (s.n === 3 ? question(s, { source_page_id: 999999 }) : question(s)));
    const quiz = await getSectionQuiz(w.topic());
    warn.mockRestore();
    expect(quiz.map((q) => q.question)).not.toContain("Question 3 about P" + w.pages[1] + "?");
    expect(quiz).toHaveLength(3);
  });

  it("the judge's verdicts are matched by the slot number it echoes, in whatever order they come", async () => {
    const w = world(2);
    quizWriter = (slots) => slots.map((s) => question(s));
    judge = (listed) => [...listed].reverse().map((n) => ({ n, ok: n !== 2, picture: false, reason: "" }));
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz.map((q) => q.question)).not.toContain(`Question 2 about P${w.pages[0]}?`);
  });

  it("the judge is shown each question under its slot number (the repair round's slots too)", async () => {
    const w = world(3); // six facts: two halves of three
    let round = 0;
    quizWriter = (slots) => {
      round++;
      return slots.map((s) => (round <= 2 && s.n === 5 ? question(s, { options: ["a", "b"] }) : question(s)));
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getSectionQuiz(w.topic());
    warn.mockRestore();
    const judged = calls.filter((c) => c.purpose === "section quiz check").map((c) => [...c.content.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])));
    expect(judged).toEqual([[1, 2, 3, 4, 6], [5]]);
  });

  it("verdicts whose numbers don't line up one to one with the questions sent are ignored (questions kept) with a warning", async () => {
    const w = world(2);
    quizWriter = (slots) => slots.map((s) => question(s));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [
      (listed: number[]) => listed.map((n, i) => ({ n: i + 10, ok: false, picture: false, reason: "" })), // numbers not sent
      (listed: number[]) => listed.slice(1).map((n) => ({ n, ok: false, picture: false, reason: "" })), // one missing
      (listed: number[]) => [...listed, listed[0]].map((n) => ({ n, ok: false, picture: false, reason: "" })), // one twice
    ]) {
      calls.length = 0;
      db.prepare("UPDATE topics SET checks_json = NULL, checks_version = NULL WHERE id = ?").run(w.topicId);
      judge = bad;
      const quiz = await getSectionQuiz(w.topic());
      expect(quiz).toHaveLength(4);
      expect(calls.filter((c) => c.purpose === "section quiz")).toHaveLength(1); // nothing dropped, nothing refilled
    }
    expect(warn.mock.calls.filter((c) => /don't match/.test(String(c[0])))).toHaveLength(3);
    warn.mockRestore();
  });
});
