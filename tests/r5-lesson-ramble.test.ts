// A lesson writer that drifts into filler at the end of a long explanation ("Done. Ok. Stop. . . End of slide. Bye.")
// has that filler cut: from new lessons as they are written, and from stored lessons when they are served (no AI call).
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
import { getLesson, lessonText, LESSON_VERSION } from "@/lib/study";
import { RAMBLE_RUN, trimRamble } from "@/lib/lessonCoverage";
import { makeUser } from "./helpers";

/** The tail of the explanation in the student's screenshot. */
const RAMBLE = [
  "End.",
  "",
  "(Note: the boxes overlap only at the edges, such as 3 months.)",
  "",
  "Done.",
  "",
  "(Keep going.)",
  "",
  "Ok.",
  "",
  "Stop.",
  "",
  "Enough.",
  "",
  "Final.",
  "",
  "Fin.",
  "",
  ".",
  "",
  ".",
  "",
  "End of slide.",
  "",
  ".",
  "",
  "Thanks.",
  "",
  "Bye.",
].join("\n");
const GOOD =
  "Kidney injury is sorted by how fast it came on. **Acute kidney injury (AKI)** means the kidney failed within hours to days, so the cause is usually recent: a drug, dehydration, a blockage.\n\n" +
  "**Chronic kidney disease (CKD)** means the damage has been there for at least 3 months and will not come back on its own.\n\n" +
  "The two overlap only at the edges, such as right around the 3-month mark.";

const notesJson = (i: number, facts: string[]) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: false, emphasis_note: null,
    case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

function world(n = 2) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, 0, 1.5)")
        .run(doc, i + 1, notesJson(i, [`fact a${i}`])).lastInsertRowid,
    ),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, pages, topicId, topic };
}
type World = ReturnType<typeof world>;
const lessonOf = (w: World, text: (i: number) => string, extra: object = {}) => ({
  intro: "What this section is about.",
  slides: w.pages.map((page_id, i) => ({ page_id, explanation: text(i) })),
  key_points: ["k"],
  connections: null,
  ...extra,
});
const stored = (w: World, lesson: object) => db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), w.topicId);
const storedLesson = (w: World) => JSON.parse(w.topic().lesson_json!) as { slides: { page_id: number; explanation: string }[]; intro: string; version?: number };

beforeEach(() => {
  calls.length = 0;
  lessonCalls = 0;
  lessonWriter = () => ({});
});

describe("trimRamble", () => {
  it("cuts the screenshot's filler tail and keeps the explanation before it", () => {
    const r = trimRamble(`${GOOD}\n\n${RAMBLE}`);
    expect(r.trimmed).toBe(true);
    expect(r.text).toBe(GOOD);
  });

  it(`the cut starts at the first run of ${RAMBLE_RUN} filler lines, even with blank lines between them`, () => {
    const r = trimRamble(`${GOOD}\n\nDone.\n\n\nOk.\n\nStop.\n\nA real sentence that explains something afterwards is lost too.`);
    expect(r.text).toBe(GOOD);
  });

  it("one or two short lines in the middle stay; trailing ones go", () => {
    const mid = `${GOOD}\n\nIn short.\n\nThe kidney has two jobs: it filters, and it keeps the balance of salts and water in the blood.`;
    expect(trimRamble(mid)).toEqual({ text: mid, trimmed: false });
    expect(trimRamble(`${mid}\n\nDone.`)).toEqual({ text: mid, trimmed: true });
    expect(trimRamble(`${mid}\n\nDone.\n\nBye.`)).toEqual({ text: mid, trimmed: true });
  });

  it("headings, list items, table rows, quotes, lead-ins and lines with numbers are never filler", () => {
    const text = [
      "## Two kinds",
      "",
      "- AKI",
      "- CKD",
      "* another",
      "1. first",
      "2) second",
      "| a | b |",
      "> a quote",
      "Causes:",
      "3 months.",
      "Stage 5.",
      "The last sentence explains the slide in full and is kept.",
    ].join("\n");
    expect(trimRamble(text)).toEqual({ text, trimmed: false });
  });

  it("bold terms, glossaries and other short real lines are never filler, even three in a row", () => {
    const one = `${GOOD}\n\n**Pulp**\n\nThe soft tissue inside the tooth is the pulp, and it carries the nerve.`;
    expect(trimRamble(one).trimmed).toBe(false);
    const terms = `${GOOD}\n\n**Pulp**\n\n**Dentin**\n\n**Enamel**\n\nthis stays`;
    expect(trimRamble(terms)).toEqual({ text: terms, trimmed: false });
    const marker = `${GOOD}\n\n★ you emphasized this`;
    expect(trimRamble(marker)).toEqual({ text: marker, trimmed: false });
  });

  it("filler is known by its words: sign-offs in bold, in parentheses or in another case still go", () => {
    expect(trimRamble(`${GOOD}\n\n**Done**\n\n_Okay_\n\nTHAT'S ALL.`).text).toBe(GOOD);
    expect(trimRamble(`${GOOD}\n\nThat's all for this slide.`).text).toBe(GOOD);
    expect(trimRamble(`${GOOD}\n\nEnd of slide.\n\n(Keep going.)`).text).toBe(GOOD);
  });

  it("punctuation-only lines are filler; whitespace is trimmed at the end", () => {
    expect(trimRamble(`${GOOD}\n\n.\n\n.\n\n.`).text).toBe(GOOD);
    expect(trimRamble(`${GOOD}\n\n`)).toEqual({ text: GOOD, trimmed: false });
    expect(trimRamble(`${GOOD}   \n.\n`)).toEqual({ text: GOOD, trimmed: true });
  });

  it("all filler trims to nothing; a genuinely short explanation on its own stays; empty stays empty", () => {
    expect(trimRamble(RAMBLE)).toEqual({ text: "", trimmed: true });
    expect(trimRamble("Done.\n\nOk.\n\nBye.")).toEqual({ text: "", trimmed: true });
    expect(trimRamble("See the picture.")).toEqual({ text: "See the picture.", trimmed: false });
    expect(trimRamble("Done.")).toEqual({ text: "", trimmed: true });
    expect(trimRamble("")).toEqual({ text: "", trimmed: false });
  });

  it("code fences are left alone", () => {
    const text = `${GOOD}\n\n\`\`\`js\nx\n\`\`\``;
    expect(trimRamble(text)).toEqual({ text, trimmed: false });
  });
});

describe("new lessons", () => {
  it("the writer is told an entry ends with the last fact", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, () => GOOD);
    await getLesson(w.topic());
    expect(calls[0].system).toMatch(/An entry ends when the slide is explained\. No closing words/);
  });

  it("filler at the end of an explanation (and of the intro) is cut before the lesson is stored", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, (i) => (i === 0 ? `${GOOD} fact a0\n\n${RAMBLE}` : `${GOOD} fact a1`), { intro: "What this is about.\n\nDone.\n\nOk.\n\nBye." });
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(lesson.slides[0].explanation).toBe(`${GOOD} fact a0`);
    expect(lesson.intro).toBe("What this is about.");
    expect(lessonText(lesson)).not.toMatch(/Bye|Keep going|End of slide/);
    expect(storedLesson(w).slides[0].explanation).toBe(`${GOOD} fact a0`);
  });

  it("an entry that is nothing but filler counts as a slide left out: the repair asks for it", async () => {
    const w = world();
    lessonWriter = (n) => (n === 1 ? lessonOf(w, (i) => (i === 0 ? RAMBLE : `${GOOD} fact a1`)) : lessonOf(w, (i) => `${GOOD} fact a${i}`));
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    expect(calls[1].content).toContain(`- [P${w.pages[0]}] L1.pdf slide 1`);
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
  });
});

describe("stored lessons", () => {
  it("a stored current lesson with filler is served clean and saved clean, with no AI call", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, (i) => (i === 0 ? `${GOOD}\n\n${RAMBLE}` : GOOD)), version: LESSON_VERSION });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lesson = await getLesson(w.topic());
    warn.mockRestore();
    expect(calls).toHaveLength(0);
    expect(lesson.slides[0].explanation).toBe(GOOD);
    expect(lesson.slides[1].explanation).toBe(GOOD);
    expect(storedLesson(w).slides[0].explanation).toBe(GOOD);
    expect(storedLesson(w).version).toBe(LESSON_VERSION);
    // a second open changes nothing more
    const again = await getLesson(w.topic());
    expect(again).toEqual(lesson);
  });

  it("a stored lesson without filler is served as is (not rewritten in the database)", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, () => GOOD), version: LESSON_VERSION });
    const before = w.topic().lesson_json;
    await getLesson(w.topic());
    expect(w.topic().lesson_json).toBe(before);
  });

  it("a stored version-3 lesson that explains (kept) still has its filler cut on open", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, (i) => (i === 1 ? `${GOOD}\n\nThanks.\n\nBye.\n\n.` : GOOD)), version: 3 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lesson = await getLesson(w.topic());
    warn.mockRestore();
    expect(calls).toHaveLength(0);
    expect(lesson.slides[1].explanation).toBe(GOOD);
    expect(storedLesson(w).version).toBe(3);
  });

  it("a stored slide that was nothing but filler is dropped from what is shown", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, (i) => (i === 0 ? RAMBLE : GOOD)), version: LESSON_VERSION });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lesson = await getLesson(w.topic());
    warn.mockRestore();
    expect(lesson.slides.map((s) => s.page_id)).toEqual([w.pages[1]]);
  });

  it("odd stored shapes (no slides array, non-string explanations) don't throw", async () => {
    const w = world();
    stored(w, { intro: "I", slides: [{ page_id: w.pages[0], explanation: 5 }, null], key_points: [], connections: null, version: LESSON_VERSION });
    const lesson = await getLesson(w.topic());
    expect(lesson.intro).toBe("I");
    stored(w, { intro: 7, slides: "nope", key_points: [], connections: null, version: LESSON_VERSION });
    await expect(getLesson(w.topic())).resolves.toBeTruthy();
  });
});
