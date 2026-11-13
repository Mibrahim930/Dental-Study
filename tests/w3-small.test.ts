// Wave 3, small fixes: where focus goes after a dialog closes, the quiz panel's scroll lock on wide screens, and a recap
// slide (only facts an earlier slide listed, no case) no longer failing a lesson the writer skipped it in.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; raw: unknown };
const calls: Call[] = [];
let lessonWriter: (call: Call) => unknown = () => ({});

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: unknown }) => {
    const call: Call = { purpose: opts.purpose, content: promptText(opts.content), raw: opts.content };
    calls.push(call);
    if (opts.purpose === "lesson" || opts.purpose === "lesson repair") return claimAll(opts.content, await lessonWriter(call));
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, type Topic } from "@/lib/db";
import { getLesson, recentFailure } from "@/lib/study";
import { focusAfterClose, pushDialog, removeDialog, shouldLockScroll, topDialogPanel } from "@/components/dialogStack";
import { makeUser } from "./helpers";
import { claimAll, promptText, slidesInPrompt } from "./lessonClaims";

// ---------------------------------------------------------------------------------------------------------------------
// 1. Focus after a dialog closes

/** A stand-in element: on the page or not, and what it contains. */
function el(name: string, connected = true, inside: El[] = []): El {
  const me: El = { name, isConnected: connected, contains: (other) => other === me || inside.some((i) => i.contains(other)) };
  return me;
}
type El = { name: string; isConnected: boolean; contains(other: El): boolean };

describe("focus after a dialog closes", () => {
  const main = el("main");

  it("the element that opened it, while it's still on the page", () => {
    const opener = el("opener");
    expect(focusAfterClose({ opener, fallback: el("fallback"), under: null, main, lost: true })).toEqual({ to: opener, temporary: false });
    // even when something else holds focus by now (as before)
    expect(focusAfterClose({ opener, fallback: null, under: null, main, lost: false })?.to).toBe(opener);
  });

  it("opener gone: returnFocus; that gone too: the page's <main>, made focusable only for that moment", () => {
    const fallback = el("resume button");
    expect(focusAfterClose({ opener: el("old", false), fallback, under: null, main, lost: true })).toEqual({ to: fallback, temporary: false });
    expect(focusAfterClose({ opener: el("old", false), fallback: el("gone", false), under: null, main, lost: true })).toEqual({ to: main, temporary: true });
    expect(focusAfterClose({ opener: null, fallback: null, under: null, main, lost: true })).toEqual({ to: main, temporary: true });
    expect(focusAfterClose({ opener: null, fallback: null, under: null, main: null, lost: true })).toBeNull();
  });

  it("opener gone but the page already moved focus somewhere on purpose: left where it is", () => {
    expect(focusAfterClose({ opener: el("old", false), fallback: el("fallback"), under: null, main, lost: false })).toBeNull();
  });

  it("closing over another dialog (Report over the quiz panel): focus stays inside the one still open", () => {
    const label = el("Question 2 of 5");
    const outside = el("lesson button");
    const panel = el("quiz panel", true, [label]);
    // the reported question's Report button is gone: the label it was given, inside the panel
    expect(focusAfterClose({ opener: el("report", false), fallback: label, under: panel, main, lost: true })?.to).toBe(label);
    // nothing given (or what was given is outside the panel): the panel itself, never <main> behind it
    expect(focusAfterClose({ opener: el("report", false), fallback: null, under: panel, main, lost: true })?.to).toBe(panel);
    expect(focusAfterClose({ opener: outside, fallback: outside, under: panel, main, lost: true })?.to).toBe(panel);
  });

  it("the stack knows each open dialog's panel, so the one under a closing dialog can take focus", () => {
    const a = Symbol("panel");
    const b = Symbol("report");
    const pa = {} as HTMLElement;
    const pb = {} as HTMLElement;
    pushDialog(a, pa);
    pushDialog(b, pb);
    expect(topDialogPanel()).toBe(pb);
    removeDialog(b);
    expect(topDialogPanel()).toBe(pa);
    removeDialog(a);
    expect(topDialogPanel()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Scroll lock

describe("scroll lock setting", () => {
  it("true locks and false doesn't, at any width; 'narrow' locks only on a phone-sized screen", () => {
    expect(shouldLockScroll(true, false)).toBe(true);
    expect(shouldLockScroll(true, true)).toBe(true);
    expect(shouldLockScroll(false, true)).toBe(false);
    expect(shouldLockScroll("narrow", true)).toBe(true);
    expect(shouldLockScroll("narrow", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Recap slides in a lesson

const notesJson = (i: number, facts: string[], o: { case_prompt?: string } = {}) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: false, emphasis_note: null,
    case_prompt: o.case_prompt ?? null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

/** One topic over the given slides (each slide's facts, and a case on some). */
function world(slides: { facts: string[]; case_prompt?: string }[]) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const insert = db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, 0, 1.5)");
  const pages = slides.map((s, i) => Number(insert.run(doc, i + 1, notesJson(i, s.facts, { case_prompt: s.case_prompt })).lastInsertRowid));
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 'about T', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { pages, topicId, topic };
}

/** A writer that explains every slide it was given except `skip` (claimAll then claims all their facts). */
const writerSkipping = (skip: number) => (c: Call) => ({
  intro: "What T is about.",
  slides: slidesInPrompt(c.raw)
    .filter((id) => id !== skip)
    .map((page_id) => ({ page_id, explanation: `Explained ${page_id} in plain words.` })),
  key_points: ["one", "two"],
  connections: null,
});
const isRepair = (c: Call) => c.purpose === "lesson repair";

const A = "enamel is the hardest tissue k1";
const B = "dentin lies under the enamel k2";
const C = "pulp holds the nerves k3";

beforeEach(() => {
  calls.length = 0;
});

describe("a recap slide may be left out of a lesson", () => {
  it("a last slide that only repeats earlier facts, skipped by the writer: the lesson is stored complete, no repair, no failure", async () => {
    const w = world([{ facts: [A] }, { facts: [B, C] }, { facts: [A, C] }]);
    lessonWriter = writerSkipping(w.pages[2]);
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(lesson.slides.map((s) => s.page_id)).toEqual([w.pages[0], w.pages[1]]);
    expect(JSON.parse(w.topic().lesson_json!).slides).toHaveLength(2);
    expect(recentFailure("lesson", w.topicId)).toBe(false);
  });

  it("a recap slide the writer does explain keeps its entry", async () => {
    const w = world([{ facts: [A] }, { facts: [A] }]);
    lessonWriter = writerSkipping(-1);
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("the same recap slide with a case still must appear: asked for in the repair, and the lesson fails if it stays missing", async () => {
    const w = world([{ facts: [A] }, { facts: [B] }, { facts: [A, B], case_prompt: "Which layer is hit first?" }]);
    lessonWriter = writerSkipping(w.pages[2]);
    await expect(getLesson(w.topic())).rejects.toThrow(/without 1 of its slides/);
    const rep = calls.find(isRepair)!;
    expect(slidesInPrompt(rep.raw)).toEqual([w.pages[2]]);
    expect(rep.content).toContain("answer its case from the slides");
    expect(w.topic().lesson_json).toBeNull();
    expect(recentFailure("lesson", w.topicId)).toBe(true);
  });

  it("a slide with one new fact among repeats must appear: the repair asks for it, and a repair that writes it completes the lesson", async () => {
    const w = world([{ facts: [A] }, { facts: [B] }, { facts: [A, B, C] }]);
    lessonWriter = (c) => (isRepair(c) ? writerSkipping(-1)(c) : writerSkipping(w.pages[2])(c));
    const lesson = await getLesson(w.topic());
    const rep = calls.find(isRepair)!;
    expect(slidesInPrompt(rep.raw)).toEqual([w.pages[2]]);
    expect(rep.content).toContain("To do: this slide got no entry. Write it, explaining F1, F2, F3.");
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("a slide with one new fact among repeats that stays missing fails the lesson", async () => {
    const w = world([{ facts: [A] }, { facts: [A, C] }]);
    lessonWriter = writerSkipping(w.pages[1]);
    await expect(getLesson(w.topic())).rejects.toThrow(/without 1 of its slides/);
    expect(recentFailure("lesson", w.topicId)).toBe(true);
  });
});
