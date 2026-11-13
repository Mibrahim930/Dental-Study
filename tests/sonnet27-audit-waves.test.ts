// QA pass on audit waves 1 and 2 (commits a06d26e, 8f00a47): chunked lessons with numbered facts, the study flow
// (lesson GET / shown / end), the section quiz validator and judge matching, and practice exams (chunking, double
// start, stale attempts). AI calls are mocked per purpose. Tests named "BUG:" fail because of a real defect (see the
// comment above each); "(documented)" ones pin odd-but-acceptable behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; raw: unknown; system: string; maxTokens?: number; cache?: boolean; schema: { shape: Record<string, unknown> } };
const calls: Call[] = [];
let lessonWriter: (call: Call) => unknown = () => ({});
let quizWriter: (slots: { n: number; page: number }[], call: Call) => unknown[] = () => [];
let judge: (listed: number[], call: Call) => unknown = (listed) => ({ verdicts: listed.map((n) => ({ n, ok: true, picture: false, reason: "" })) });
let currentUserId = 0;
const pr = vi.hoisted(() => ({
  calls: [] as { purpose: string; content: string; maxTokens?: number }[],
  failOn: new Map<number, string>(), // 1-based number of the practice call -> error text
  gate: null as Promise<void> | null,
  counter: 0,
}));

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: unknown; system: string; maxTokens?: number; cache?: boolean; schema: { shape: Record<string, unknown> } }) => {
    const call: Call = { purpose: opts.purpose, content: promptText(opts.content), raw: opts.content, system: opts.system, maxTokens: opts.maxTokens, cache: opts.cache, schema: opts.schema };
    if (opts.purpose === "practice questions" || opts.purpose === "case sets") {
      pr.calls.push(call);
      const n = pr.calls.length;
      if (pr.gate) await pr.gate;
      const failure = pr.failOn.get(n);
      if (failure) throw new Error(failure);
      // One answer per planned question ("Q4: slide P12 — …"), its number echoed; in case sets one case per "case N".
      const slots = [...call.content.matchAll(/^Q(\d+): slide P(\d+)(?: — case (\d+))?/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]), caseN: m[3] ? Number(m[3]) : null }));
      const q = (stem: string, slot: { n: number; page: number }) => ({
        slot: slot.n,
        stem,
        options: ["A1", "B2", "C3", "D4", "E5"],
        correct_index: 0,
        correct_answer: "A1",
        explanation: "e",
        option_notes: ["n1", "n2", "n3", "n4", "n5"],
        source_page_id: slot.page,
        concept: "Gen concept",
      });
      if (opts.purpose === "case sets") {
        return {
          cases: [...new Set(slots.map((s) => s.caseN))].map((caseN) => {
            const c = ++pr.counter;
            return {
              scenario: `scenario ${c}`,
              patient_box: { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" },
              image_page_id: null,
              questions: slots.filter((s) => s.caseN === caseN).map((s, i) => q(`case ${c} question ${i + 1}`, s)),
            };
          }),
        };
      }
      return { questions: slots.map((s) => ({ type: "recall", image_page_id: null, patient_box: null, ...q(`generated stem ${++pr.counter}`, s) })) };
    }
    calls.push(call);
    if (opts.purpose === "lesson" || opts.purpose === "lesson repair") {
      await new Promise((r) => setTimeout(r, 5));
      return claimAll(opts.content, await lessonWriter(call));
    }
    if (opts.purpose === "section quiz") {
      const slots = [...call.content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return { questions: quizWriter(slots, call) };
    }
    if (opts.purpose === "section quiz check") return judge([...call.content.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])), call);
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db, getMeta, setMeta, type Topic } from "@/lib/db";
import { FAILURE_COOLDOWN_MS, getLesson, getSectionQuiz, LESSON_VERSION, QUIZ_VERSION, recentFailure, type QuizQuestion } from "@/lib/study";
import { chunkSizes, INTERRUPTED_ATTEMPT, recoverStaleAttempts, startAttempt, writingAttempt } from "@/lib/practice";
import { recordQuizAnswer } from "@/lib/quizProgress";
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { POST as shownPOST } from "@/app/api/sessions/[id]/shown/route";
import { POST as endPOST } from "@/app/api/sessions/[id]/end/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as attemptsPOST } from "@/app/api/exams/[id]/attempts/route";
import { makeUser } from "./helpers";
import { claimAll, factIdsInPrompt, promptText, slidesInPrompt } from "./lessonClaims";

const notesJson = (i: number, facts: string[], o: { is_filler?: boolean; case_prompt?: string } = {}) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: false, emphasis_note: null,
    case_prompt: o.case_prompt ?? null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: !!o.is_filler,
  });

type Slide = { facts?: string[]; case_prompt?: string; is_filler?: boolean };
/** One exam; `topics` sections of n slides each (two facts per slide with their own code words unless `slide` says otherwise); one study session. */
function world(n: number, o: { slide?: (i: number) => Slide; topics?: number } = {}) {
  const userId = makeUser();
  currentUserId = userId;
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const insert = db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, 0, 1.5)");
  let pageNo = 0;
  const topicIds: number[] = [];
  const allPages: number[][] = [];
  for (let t = 0; t < (o.topics ?? 1); t++) {
    const pages = Array.from({ length: n }, (_, i) => {
      const s = o.slide?.(i) ?? {};
      pageNo++;
      return Number(insert.run(doc, pageNo, notesJson(i, s.facts ?? [`first fact t${t}k${i}a`, `second fact t${t}k${i}b`], s)).lastInsertRowid);
    });
    allPages.push(pages);
    topicIds.push(Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, 'about T', ?)").run(examId, t, t === 0 ? "T" : `T${t}`, JSON.stringify(pages)).lastInsertRowid));
  }
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, 0)").run(examId).lastInsertRowid);
  const topicRow = (id: number) => db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
  return { userId, examId, pages: allPages[0], allPages, topicId: topicIds[0], topicIds, sessionId, topic: () => topicRow(topicIds[0]), topicOf: topicRow };
}
type World = ReturnType<typeof world>;

const explainAll = (c: Call) => ({
  intro: "What T is about.",
  slides: slidesInPrompt(c.raw).map((page_id) => ({ page_id, explanation: `Explained ${page_id} in plain words.` })),
  key_points: ["★ one", "two"],
  connections: null,
});
const isRepair = (c: Call) => c.purpose === "lesson repair";
const lessonCalls = () => calls.filter((c) => c.purpose.startsWith("lesson"));
const storedLesson = (w: World) => (w.topic().lesson_json ? (JSON.parse(w.topic().lesson_json!) as { intro: string; slides: { page_id: number; explanation: string }[]; key_points: string[]; version: number }) : null);

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
const okVerdicts = (listed: number[]) => ({ verdicts: listed.map((n) => ({ n, ok: true, picture: false, reason: "" })) });

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const lessonGet = (sessionId: number, position: number, prefetch = false) =>
  lessonGET(new Request(`http://x/l?position=${position}${prefetch ? "&prefetch=1" : ""}`), ctx(sessionId));
const post = (route: (r: Request, c: never) => Promise<Response>, id: number, body: unknown) => route(new Request("http://x/p", { method: "POST", body: JSON.stringify(body) }), ctx(id));
const shown = (sessionId: number, position: number) => post(shownPOST, sessionId, { position });
const end = (sessionId: number) => endPOST(new Request("http://x/e", { method: "POST" }), ctx(sessionId));
const startExam = (examId: number, body: unknown = {}) => attemptsPOST(new Request("http://x/a", { method: "POST", body: JSON.stringify(body) }), ctx(examId));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, tries = 400) {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
}
const count = (p: string) => calls.filter((c) => c.purpose === p).length;
const position = (w: World) => (db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(w.sessionId) as { p: number }).p;
const quizOf = (n: number, concept = (i: number) => `Concept ${i}`): QuizQuestion[] =>
  Array.from({ length: n }, (_, i) => ({ id: `q${i}`, question: `Question ${i}?`, options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: concept(i) }));
const storeQuiz = (topicId: number, qs: QuizQuestion[], version: number | null = QUIZ_VERSION) =>
  db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(JSON.stringify(qs), version, topicId);

let warn: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls.length = 0;
  lessonWriter = explainAll;
  quizWriter = (slots) => slots.map((s) => question(s));
  judge = okVerdicts;
  currentUserId = 0;
  pr.calls = [];
  pr.failOn.clear();
  pr.gate = null;
  pr.counter = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
let release: (() => void) | null = null;
afterEach(async () => {
  release?.();
  release = null;
  pr.gate = null;
  await new Promise((r) => setTimeout(r, 15));
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------- lessons

describe("lessons: cost", () => {
  it.each([
    [1, 1],
    [5, 1],
    [6, 2],
    [10, 2],
    [11, 3],
    [25, 5],
    [26, 6],
    [27, 6],
  ])("a perfect writer, %i slides: exactly %i call(s), no repair, every slide stored in order", async (n, parts) => {
    const w = world(n);
    await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(Array(parts).fill("lesson"));
    expect(calls.every((c) => slidesInPrompt(c.raw).length <= 5)).toBe(true);
    expect(storedLesson(w)!.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("27 slides: facts numbered F1…F54 with no gap or repeat across the six parts; two calls at a time", async () => {
    const w = world(27);
    await getLesson(w.topic());
    const seen = lessonCalls().flatMap((c) => [...factIdsInPrompt(c.raw).values()].flat());
    expect(seen).toEqual(Array.from({ length: 54 }, (_, i) => i + 1));
  });

  it("a fact the slides repeat keeps one number and is asked for once", async () => {
    const w = world(3, { slide: (i) => ({ facts: ["the shared fact about enamel rods", `own fact ${i} here`] }) });
    await getLesson(w.topic());
    const ids = factIdsInPrompt(calls[0].raw);
    expect(ids.get(w.pages[0])).toEqual([1, 2]);
    expect(ids.get(w.pages[1])).toEqual([1, 3]);
    expect(ids.get(w.pages[2])).toEqual([1, 4]);
    expect(calls).toHaveLength(1);
  });
});

describe("lessons: what the writer gets wrong", () => {
  it("entries for another part's slides are ignored even when both parts write them: each slide keeps its own part's text and nothing is repaired", async () => {
    const w = world(6);
    lessonWriter = (c) => {
      const mine = slidesInPrompt(c.raw);
      return { ...explainAll(c), slides: w.pages.map((page_id) => ({ page_id, explanation: `by part starting ${mine[0]}` })) };
    };
    await getLesson(w.topic());
    const l = storedLesson(w)!;
    expect(l.slides.map((s) => s.explanation)).toEqual([...w.pages.slice(0, 3).map(() => `by part starting ${w.pages[0]}`), ...w.pages.slice(3).map(() => `by part starting ${w.pages[3]}`)]);
    expect(calls.some(isRepair)).toBe(false);
  });

  it("two entries for one slide inside a part are joined, and both entries' facts count", async () => {
    const w = world(1);
    lessonWriter = () => ({
      intro: "i",
      slides: [
        { page_id: w.pages[0], explanation: "first half", facts: [1] },
        { page_id: w.pages[0], explanation: "second half", facts: [2] },
      ],
      key_points: [],
      connections: null,
    });
    await getLesson(w.topic());
    expect(storedLesson(w)!.slides[0].explanation).toBe("first half\n\nsecond half");
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
  });

  it("fact numbers that are negative, huge, fractional, blank, null, objects or words claim nothing; ' F2 ' counts", async () => {
    const w = world(1);
    lessonWriter = (c) =>
      isRepair(c)
        ? { slides: [{ page_id: w.pages[0], explanation: "F1 now." }] }
        : { intro: "i", slides: [{ page_id: w.pages[0], explanation: "Pulp text.", facts: [-1, 1e21, 2.5, "abc", "", "F-1", null, {}, [1], true, " F2 "] }], key_points: [], connections: null };
    await getLesson(w.topic());
    const rep = calls.find(isRepair)!.content;
    expect(rep).toContain("explain F1, which the entry leaves out");
    expect(rep).not.toContain("F2,");
    expect(storedLesson(w)!.slides[0].explanation).toBe("Pulp text.\n\nF1 now.");
  });

  it("a part that returns an empty slides array: its slides go to ONE repair (not one call per slide) and the lesson is whole", async () => {
    const w = world(12);
    lessonWriter = (c) => (isRepair(c) ? explainAll(c) : slidesInPrompt(c.raw)[0] === w.pages[4] ? { ...explainAll(c), slides: [] } : explainAll(c));
    await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson", "lesson", "lesson repair"]);
    expect(slidesInPrompt(calls[3].raw)).toEqual(w.pages.slice(4, 8));
    expect(storedLesson(w)!.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("parts finishing out of order: the stored slides are in slide order and the intro of the (slowest) first part is kept", async () => {
    const w = world(12);
    lessonWriter = async (c) => {
      if (slidesInPrompt(c.raw)[0] === w.pages[0]) await new Promise((r) => setTimeout(r, 60));
      return explainAll(c);
    };
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
    expect(lesson.intro).toBe("What T is about.");
    expect(storedLesson(w)!.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("entries returned in reverse order inside a part are stored in slide order", async () => {
    const w = world(4);
    lessonWriter = (c) => ({ ...explainAll(c), slides: explainAll(c).slides.reverse() });
    await getLesson(w.topic());
    expect(storedLesson(w)!.slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("a repair that returns entries for slides it was not asked about changes only the slide it was asked about", async () => {
    const w = world(3);
    lessonWriter = (c) =>
      isRepair(c)
        ? { slides: w.pages.map((page_id, i) => ({ page_id, explanation: `REPAIR ${i}` })) }
        : { ...explainAll(c), slides: w.pages.map((page_id, i) => ({ page_id, explanation: `Entry ${i}.`, ...(i === 1 ? { facts: [3] } : {}) })) };
    await getLesson(w.topic());
    expect(slidesInPrompt(calls.find(isRepair)!.raw)).toEqual([w.pages[1]]);
    expect(storedLesson(w)!.slides.map((s) => s.explanation)).toEqual(["Entry 0.", "Entry 1.\n\nREPAIR 1", "Entry 2."]);
  });

  it("a repair that throws for a slide whose entry only lacks a fact keeps the entry and still stores the lesson", async () => {
    const w = world(2);
    lessonWriter = (c) => {
      if (isRepair(c)) throw new Error("529 overloaded");
      return { ...explainAll(c), slides: w.pages.map((page_id, i) => ({ page_id, explanation: `Entry ${i}.`, ...(i === 1 ? { facts: [3] } : {}) })) };
    };
    await getLesson(w.topic());
    expect(calls.filter(isRepair)).toHaveLength(1); // not retried
    expect(storedLesson(w)!.slides.map((s) => s.explanation)).toEqual(["Entry 0.", "Entry 1."]);
    expect(recentFailure("lesson", w.topicId)).toBe(false);
  });

  // BUG: input: a 3-slide section whose writer gives no entry for slide 2 (a hole) and whose repair call throws (529).
  // Output: getLesson resolves and stores a version-4 lesson with only 2 of the 3 slides; lessonIsCurrent then treats
  // it as finished forever, no failure marker is set and nothing ever writes slide 2 (the "lesson with a hole must never
  // pass for a finished one" rule only holds for a part that fails, not for a failed repair). src/lib/study.ts:719-721
  // (the repair's catch keeps going) and :725-741 (the lesson is saved without checking every slide with facts has an entry).
  // Student: a section that silently skips a slide with facts, and the quiz still asks about those facts.
  it("a repair that throws for a slide with no entry must not leave a stored lesson without that slide", async () => {
    const w = world(3);
    lessonWriter = (c) => {
      if (isRepair(c)) throw new Error("529 overloaded");
      return { ...explainAll(c), slides: explainAll(c).slides.filter((s) => s.page_id !== w.pages[2]) };
    };
    await getLesson(w.topic()).catch(() => null);
    const stored = storedLesson(w);
    expect(stored === null || stored.slides.some((s) => s.page_id === w.pages[2])).toBe(true);
  });

  // BUG: input: the writer returns slides: [] for every part and the repair returns slides: [] too (or only filler).
  // Output: a version-4 lesson with intro and key points and ZERO slides is stored and served from then on; no marker.
  // src/lib/study.ts:725-741 (no acceptance check after the repair). Student: an empty slide-by-slide lesson she cannot
  // retry except by an explicit rewrite; the cost of the calls is spent and the failure is cached as a success.
  it("a lesson whose parts and repair gave no usable entry must not be stored as a finished lesson", async () => {
    const w = world(4);
    lessonWriter = (c) => ({ ...explainAll(c), slides: [] });
    await getLesson(w.topic()).catch(() => null);
    const stored = storedLesson(w);
    expect(stored === null || stored.slides.length > 0).toBe(true);
  });

  it("a section with no facts anywhere and no cases needs no entries and no repair, even when the writer gives none", async () => {
    const w = world(3, { slide: () => ({ facts: [] }) });
    lessonWriter = (c) => ({ ...explainAll(c), slides: [] });
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(lesson.slides).toEqual([]);
    expect(storedLesson(w)!.version).toBe(LESSON_VERSION);
  });

  it("a section of filler slides (even with facts listed) is never repaired for lack of entries", async () => {
    const w = world(7, { slide: (i) => ({ is_filler: true, facts: [`filler fact ${i}`] }) });
    lessonWriter = (c) => ({ ...explainAll(c), slides: [] });
    await getLesson(w.topic());
    expect(calls.filter(isRepair)).toHaveLength(0);
    expect(lessonCalls()).toHaveLength(2);
  });

  it("a case-only slide whose entry is blank counts as not written: repaired with 'answer its case'", async () => {
    const w = world(3, { slide: (i) => (i === 1 ? { facts: [], case_prompt: "Which tooth is this?" } : {}) });
    lessonWriter = (c) =>
      isRepair(c) ? { slides: [{ page_id: w.pages[1], explanation: "It is the molar." }] } : { ...explainAll(c), slides: explainAll(c).slides.map((s) => (s.page_id === w.pages[1] ? { ...s, explanation: "   \n " } : s)) };
    await getLesson(w.topic());
    const rep = calls.find(isRepair)!.content;
    expect(slidesInPrompt(rep)).toEqual([w.pages[1]]);
    expect(rep).toContain("answer its case from the slides");
    expect(storedLesson(w)!.slides.map((s) => s.explanation)[1]).toBe("It is the molar.");
  });

  it("a repair for more than five slides is split into calls of at most five", async () => {
    const w = world(12);
    lessonWriter = (c) => (isRepair(c) ? explainAll(c) : { ...explainAll(c), slides: [] });
    await getLesson(w.topic());
    const reps = calls.filter(isRepair);
    expect(reps.map((c) => slidesInPrompt(c.raw).length)).toEqual([4, 4, 4]);
    expect(reps.every((c) => (c.maxTokens ?? 0) <= 1200 * 5 + 2500)).toBe(true);
    expect(storedLesson(w)!.slides).toHaveLength(12);
  });
});

describe("lessons: failures", () => {
  it("the first part failing twice while the others succeed: rejects, nothing stored, marker set, no repair, bounded spend", async () => {
    const w = world(12);
    lessonWriter = (c) => {
      if (slidesInPrompt(c.raw)[0] === w.pages[0]) throw new Error("529 overloaded");
      return explainAll(c);
    };
    await expect(getLesson(w.topic())).rejects.toThrow("529 overloaded");
    expect(w.topic().lesson_json).toBeNull();
    expect(recentFailure("lesson", w.topicId)).toBe(true);
    expect(getMeta(`lesson_fail:${w.topicId}`)).toMatch(/529 overloaded$/);
    expect(calls.some(isRepair)).toBe(false);
    expect(lessonCalls().length).toBeLessThanOrEqual(4); // part 1 twice, parts 2 and 3 once at most
  });

  it("the LAST part failing twice also stores nothing", async () => {
    const w = world(12);
    lessonWriter = (c) => {
      if (slidesInPrompt(c.raw)[0] === w.pages[8]) throw new Error("boom");
      return explainAll(c);
    };
    await expect(getLesson(w.topic())).rejects.toThrow("boom");
    expect(w.topic().lesson_json).toBeNull();
  });

  it("a part that fails once and then works is accepted; a part that is cut off twice is not retried a third time", async () => {
    const w = world(12);
    let first = true;
    lessonWriter = (c) => {
      if (slidesInPrompt(c.raw)[0] === w.pages[4]) {
        if (first) {
          first = false;
          throw new Error("The answer was cut off (too long). Try a smaller request.");
        }
        if (slidesInPrompt(c.raw).length > 2) throw new Error("The answer was cut off (too long). Try a smaller request.");
      }
      return explainAll(c);
    };
    // the 4-slide part is cut off, then its first half (2 slides) works and the second half works
    await getLesson(w.topic());
    expect(storedLesson(w)!.slides).toHaveLength(12);
    calls.length = 0;
    const w2 = world(12);
    lessonWriter = (c) => {
      if (slidesInPrompt(c.raw)[0] === w2.pages[4]) throw new Error("The answer was cut off (too long). Try a smaller request.");
      return explainAll(c);
    };
    await expect(getLesson(w2.topic())).rejects.toThrow(/cut off/);
    // the failing part: whole, then two halves: the first half fails and the second half is never asked
    expect(lessonCalls().filter((c) => slidesInPrompt(c.raw)[0] === w2.pages[4])).toHaveLength(2);
    expect(w2.topic().lesson_json).toBeNull();
  });

  it("a stored version-3 lesson survives a failing SECOND part, is returned, and a direct retry calls the writer again despite the marker", async () => {
    const long = (i: number, k: string) => `The ${k} fact of slide number ${i} is a long sentence about teeth`;
    const w = world(12, { slide: (i) => ({ facts: [long(i, "first"), long(i, "second")] }) });
    const old = { intro: "old", slides: w.pages.map((page_id, i) => ({ page_id, explanation: `${long(i, "first")}. ${long(i, "second")}.` })), key_points: [], connections: null, version: 3 };
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(old), w.topicId);
    lessonWriter = (c) => {
      if (slidesInPrompt(c.raw)[0] === w.pages[4]) throw new Error("down");
      return explainAll(c);
    };
    const got = await getLesson(w.topic());
    expect(got.intro).toBe("old");
    expect(JSON.parse(w.topic().lesson_json!)).toEqual(old);
    expect(recentFailure("lesson", w.topicId)).toBe(true);
    // the page's prefetch leaves it alone; her own open tries again
    calls.length = 0;
    expect((await lessonGet(w.sessionId, 0, true)).status).toBe(204);
    expect(calls).toHaveLength(0);
    expect((await lessonGet(w.sessionId, 0)).status).toBe(200);
    expect(lessonCalls().length).toBeGreaterThan(0);
  });

  it("two concurrent getLesson calls (and a third after) share one generation and the same lesson", async () => {
    const w = world(6);
    const t = w.topic();
    const [a, b] = await Promise.all([getLesson(t), getLesson(t)]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(2); // two parts, once
    const c = await getLesson(w.topic());
    expect(c.intro).toBe(a.intro);
    expect(calls).toHaveLength(2);
  });

  it("concurrent callers of a failing lesson all fail with the one generation's error (writer called twice per part, not per caller)", async () => {
    const w = world(1);
    lessonWriter = () => {
      throw new Error("529 overloaded");
    };
    const t = w.topic();
    const results = await Promise.allSettled([getLesson(t), getLesson(t), getLesson(t)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(lessonCalls()).toHaveLength(2);
  });

  // (documented) A topic object read BEFORE a generation finished is stale: handing it to getLesson afterwards writes the
  // lesson again (and pays again). The routes read the topic and call getLesson with no await between, so they can't hit it.
  it("(documented) getLesson(stale topic row) after the lesson was written writes it again", async () => {
    const w = world(1);
    const stale = w.topic();
    await getLesson(stale);
    expect(calls).toHaveLength(1);
    await getLesson(stale);
    expect(calls).toHaveLength(2);
  });

  it("a prefetch racing her direct open shares one generation; neither is paid twice", async () => {
    const w = world(6);
    const [pre, direct] = await Promise.all([lessonGet(w.sessionId, 0, true), lessonGet(w.sessionId, 0)]);
    expect([pre.status, direct.status]).toEqual([200, 200]);
    expect(lessonCalls()).toHaveLength(2);
  });

  it("under a fresh marker a racing prefetch answers 204 at once while her direct open writes the lesson once", async () => {
    const w = world(1);
    setMeta(`lesson_fail:${w.topicId}`, `${new Date().toISOString()} earlier failure`);
    const [pre, direct] = await Promise.all([lessonGet(w.sessionId, 0, true), lessonGet(w.sessionId, 0)]);
    expect(pre.status).toBe(204);
    expect(direct.status).toBe(200);
    expect(lessonCalls()).toHaveLength(1);
    expect(getMeta(`lesson_fail:${w.topicId}`)).toBeNull();
  });

  it("a failing direct open and a prefetch started at the same time join one generation: writer called twice, both answer 502", async () => {
    const w = world(1);
    lessonWriter = () => {
      throw new Error("529 overloaded");
    };
    const [a, b] = await Promise.all([lessonGet(w.sessionId, 0), lessonGet(w.sessionId, 0, true)]);
    expect([a.status, b.status]).toEqual([502, 502]);
    expect(lessonCalls()).toHaveLength(2);
  });

  it("a failure marker belongs to its topic only, and a good lesson clears it", async () => {
    const w = world(1, { topics: 2 });
    setMeta(`lesson_fail:${w.topicIds[1]}`, `${new Date().toISOString()} x`);
    expect(recentFailure("lesson", w.topicIds[0])).toBe(false);
    expect((await lessonGet(w.sessionId, 0, true)).status).toBe(200);
    expect((await lessonGet(w.sessionId, 1, true)).status).toBe(204);
    expect((await lessonGet(w.sessionId, 1)).status).toBe(200);
    expect(getMeta(`lesson_fail:${w.topicIds[1]}`)).toBeNull();
  });

  it("the marker keeps a one-line reason without anything that looks like a key", async () => {
    const w = world(1);
    lessonWriter = () => {
      throw new Error(`401 invalid x-api-key sk-ant-api03-AbC_123-xyz rejected${"\n"}second line ${"y".repeat(300)}`);
    };
    await getLesson(w.topic()).catch(() => null);
    const marker = getMeta(`lesson_fail:${w.topicId}`)!;
    expect(marker).toContain("[key]");
    expect(marker).not.toContain("sk-ant");
    expect(marker).not.toContain("second line");
    expect(marker.split(" ").slice(1).join(" ").length).toBeLessThanOrEqual(120);
  });
});

describe("failure marker cool-down", () => {
  const id = 987654;
  const at = (msAgo: number, rest = "r") => `${new Date(Date.now() - msAgo).toISOString()} ${rest}`;

  it("is on for just under ten minutes and off from just over", () => {
    setMeta(`lesson_fail:${id}`, at(FAILURE_COOLDOWN_MS - 3000));
    expect(recentFailure("lesson", id)).toBe(true);
    setMeta(`lesson_fail:${id}`, at(FAILURE_COOLDOWN_MS + 1000));
    expect(recentFailure("lesson", id)).toBe(false);
    expect(FAILURE_COOLDOWN_MS).toBe(600_000);
  });

  it("lesson and quiz markers are separate; a missing or garbled marker is not a failure", () => {
    setMeta(`quiz_fail:${id}`, at(1000));
    expect(recentFailure("lesson", id)).toBe(false);
    expect(recentFailure("quiz", id)).toBe(true);
    for (const junk of ["", "garbage", "not-a-date reason", "   ", "null x"]) {
      setMeta(`lesson_fail:${id}`, junk);
      expect(recentFailure("lesson", id)).toBe(false);
    }
    db.prepare("DELETE FROM meta WHERE key LIKE ?").run(`%_fail:${id}`);
    expect(recentFailure("quiz", id)).toBe(false);
  });

  // (documented) A marker dated in the future (clock moved back) holds the automatic starts back until real time catches up.
  it("(documented) a marker timestamped in the future counts as recent", () => {
    setMeta(`lesson_fail:${id}`, at(-3_600_000));
    expect(recentFailure("lesson", id)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------ quiz

describe("section quiz: validation and the judge", () => {
  it("a draft whose answer text disagrees with its index, repeats an option, has no source slide, or has a non-text option is dropped; the repair refills exactly those slots", async () => {
    const w = world(2); // four questions, one call
    let round = 0;
    quizWriter = (slots) => {
      round++;
      return slots.map((s) => {
        if (round > 1) return question(s);
        if (s.n === 1) return question(s, { correct_index: 1 }); // text says "right" (index 0)
        if (s.n === 2) return question(s, { options: ["same", "SAME ", "w2", "w3"], correct_answer: undefined });
        if (s.n === 3) return question(s, { source_page_id: null });
        return question(s, { options: ["right", 2, "w2", "w3"] });
      });
    };
    const quiz = await getSectionQuiz(w.topic());
    const writes = calls.filter((c) => c.purpose === "section quiz");
    expect(writes).toHaveLength(2);
    expect([...writes[1].content.matchAll(/^Q(\d+):/gm)].map((m) => Number(m[1])).sort()).toEqual([1, 2, 3, 4]);
    expect(quiz).toHaveLength(4);
    expect(quiz.every((q) => q.options.length === 4 && q.options[q.correct_index] === "right")).toBe(true);
  });

  it("answer text that differs only in case or punctuation is accepted", async () => {
    const w = world(2);
    quizWriter = (slots) => slots.map((s) => question(s, { correct_answer: "RIGHT." }));
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz).toHaveLength(4);
    expect(count("section quiz")).toBe(1);
  });

  it("slot numbers as strings or repeated, and extra questions beyond the plan, still give one question per planned slot", async () => {
    const w = world(2);
    quizWriter = (slots) => [...slots.map((s) => question(s, { slot: String(s.n) })), question({ n: 9, page: slots[0].page }, { slot: 1, question: "An extra question?" })];
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz).toHaveLength(4);
    expect(new Set(quiz.map((q) => q.question)).size).toBe(4);
    expect(quiz.map((q) => q.question)).not.toContain("An extra question?");
  });

  it("the same stem written for every slot keeps one and the repair writes the rest", async () => {
    const w = world(2);
    let round = 0;
    quizWriter = (slots) => {
      round++;
      return slots.map((s) => question(s, round === 1 ? { question: "Same question?" } : {}));
    };
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz).toHaveLength(4);
    expect(quiz.map((q) => q.question).filter((q) => q === "Same question?")).toHaveLength(1);
    expect(count("section quiz")).toBe(2);
  });

  it("judge verdicts with the right numbers drop only the rejected question, and the repair refills it with a second judging", async () => {
    const w = world(2);
    let rounds = 0;
    judge = (listed) => {
      rounds++;
      return { verdicts: listed.map((n) => ({ n, ok: !(rounds === 1 && n === 2), picture: false, reason: "" })) };
    };
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz).toHaveLength(4);
    const writes = calls.filter((c) => c.purpose === "section quiz");
    expect([...writes[1].content.matchAll(/^Q(\d+):/gm)].map((m) => Number(m[1]))).toEqual([2]);
    expect(count("section quiz check")).toBe(2);
  });

  it.each([
    ["numbers as strings", (l: number[]) => ({ verdicts: l.map((n) => ({ n: String(n), ok: false, picture: false, reason: "" })) })],
    ["an extra number", (l: number[]) => ({ verdicts: [...l, 99].map((n) => ({ n, ok: false, picture: false, reason: "" })) })],
    ["one number repeated and one missing", (l: number[]) => ({ verdicts: l.map((_, i) => ({ n: l[Math.min(i, 1)], ok: false, picture: false, reason: "" })) })],
    ["no verdicts", () => ({ verdicts: [] })],
    ["verdicts missing", () => ({})],
    ["null verdicts", (l: number[]) => ({ verdicts: l.map(() => null) })],
  ])("(documented) judge returns %s: ignored, every question kept, nothing refilled", async (_name, bad) => {
    const w = world(2);
    judge = bad as typeof judge;
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz).toHaveLength(4);
    expect(count("section quiz")).toBe(1);
    expect(warn.mock.calls.some((c: unknown[]) => /verdicts don't match/.test(String(c[0])))).toBe(true);
  });

  it("a judge call that throws keeps every question", async () => {
    const w = world(2);
    judge = () => {
      throw new Error("judge down");
    };
    expect(await getSectionQuiz(w.topic())).toHaveLength(4);
  });

  it("a judge that rejects every question every time leaves no quiz: rejects, marks the failure, stores nothing", async () => {
    const w = world(2);
    judge = (l) => ({ verdicts: l.map((n) => ({ n, ok: false, picture: false, reason: "" })) });
    await expect(getSectionQuiz(w.topic())).rejects.toThrow(/Couldn't write the section quiz/);
    expect(w.topic().checks_json).toBeNull();
    expect(recentFailure("quiz", w.topicId)).toBe(true);
    expect(count("section quiz")).toBe(2); // plan once, repair once, no more
  });

  it("a section of one slide with one fact is one question and one write call", async () => {
    const w = world(1, { slide: () => ({ facts: ["only fact about the pulp chamber"] }) });
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz).toHaveLength(1);
    expect(count("section quiz")).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------------- study flow

describe("study flow: shown", () => {
  it("three simultaneous shown for one section: one quiz generation (two half writes, one judging)", async () => {
    const w = world(3);
    const rs = await Promise.all([shown(w.sessionId, 0), shown(w.sessionId, 0), shown(w.sessionId, 0)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    await until(() => !!w.topic().checks_json);
    expect(w.topic().checks_version).toBe(QUIZ_VERSION);
    expect(count("section quiz")).toBe(2);
    expect(count("section quiz check")).toBe(1);
  });

  it("shown beyond the last section is 404 and changes nothing; negative, fractional, missing and infinite positions are 400", async () => {
    const w = world(2, { topics: 2 });
    expect((await shown(w.sessionId, 2)).status).toBe(404);
    expect((await shown(w.sessionId, 2 ** 53)).status).toBe(404);
    for (const bad of [-1, 0.5, null, "0", [0], undefined]) expect((await post(shownPOST, w.sessionId, { position: bad })).status).toBe(400);
    expect((await post(shownPOST, w.sessionId, "x")).status).toBe(400);
    expect(position(w)).toBe(0);
    await tick();
    expect(calls).toHaveLength(0);
    expect(getMeta(`session_shown:${w.sessionId}`)).toBeNull();
  });

  it("skipping ahead without showing writes nothing; only the sections whose lesson was shown get a quiz", async () => {
    const w = world(2, { topics: 3 });
    await shown(w.sessionId, 2);
    await until(() => !!w.topicOf(w.topicIds[2]).checks_json);
    expect(w.topicOf(w.topicIds[0]).checks_json).toBeNull();
    expect(w.topicOf(w.topicIds[1]).checks_json).toBeNull();
    expect(position(w)).toBe(2);
  });

  it("a shown section whose quiz fails is marked, answers 200, and a second shown inside the cool-down starts nothing", async () => {
    const w = world(2);
    quizWriter = () => {
      throw new Error("529 overloaded");
    };
    expect((await shown(w.sessionId, 0)).status).toBe(200);
    await until(() => recentFailure("quiz", w.topicId));
    const before = count("section quiz");
    await shown(w.sessionId, 0);
    await tick();
    expect(count("section quiz")).toBe(before);
  });

  // Fixed: a stray "shown" for an ended session used to move the position, start a paid quiz and leave a record behind.
  it("shown on an ended session does nothing: no quiz, no move, no record left behind", async () => {
    const w = world(2, { topics: 2 });
    await shown(w.sessionId, 0);
    await until(() => !!w.topic().checks_json);
    const first = (await (await end(w.sessionId)).json()) as { summary: string };
    expect(getMeta(`session_shown:${w.sessionId}`)).toBeNull();
    calls.length = 0;
    expect((await shown(w.sessionId, 1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(count("section quiz")).toBe(0);
    expect(w.topicOf(w.topicIds[1]).checks_json).toBeNull();
    expect(position(w)).toBe(0);
    expect(getMeta(`session_shown:${w.sessionId}`)).toBeNull();
    expect(((await (await end(w.sessionId)).json()) as { summary: string }).summary).toBe(first.summary);
  });

  it("an out-of-date quiz that she answered is not rewritten by shown, GET or getSectionQuiz", async () => {
    const w = world(3);
    storeQuiz(w.topicId, quizOf(4), 3);
    recordQuizAnswer(w.userId, w.topicId, 0, 1, false);
    await shown(w.sessionId, 0);
    await getSectionQuiz(w.topic());
    await tick();
    expect(calls).toHaveLength(0);
    expect(w.topic().checks_version).toBe(3);
  });
});

describe("study flow: end note", () => {
  it("zero activity: says so, ends the session once, makes no AI call", async () => {
    const w = world(2);
    const { summary } = (await (await end(w.sessionId)).json()) as { summary: string };
    expect(summary).toBe("You didn't open any section in this session.");
    expect(calls).toHaveLength(0);
    const row = db.prepare("SELECT ended_at, summary FROM study_sessions WHERE id = ?").get(w.sessionId) as { ended_at: string | null; summary: string | null };
    expect(row.ended_at).not.toBeNull();
    expect(row.summary).toBe(summary);
  });

  it("only wrong answers: 0 of N and the concepts, most missed first, at most three", async () => {
    const w = world(2);
    storeQuiz(w.topicId, quizOf(6, (i) => ["Alpha", "Alpha", "Beta", "Beta", "Gamma", "Delta"][i]));
    await shown(w.sessionId, 0);
    await until(() => true);
    for (let i = 0; i < 6; i++) expect((await post(checkPOST, w.sessionId, { topicId: w.topicId, index: i, chosen: 1 })).status).toBe(200);
    const { summary } = (await (await end(w.sessionId)).json()) as { summary: string };
    expect(summary).toBe("You covered one section: T. You got 0 of 6 section-quiz questions right. Worth another look: Alpha, Beta and Gamma.");
  });

  it("one answer is 'question' not 'questions'; answers without a shown record still count their section", async () => {
    const w = world(2);
    storeQuiz(w.topicId, quizOf(2));
    await post(checkPOST, w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 });
    const { summary } = (await (await end(w.sessionId)).json()) as { summary: string };
    expect(summary).toBe("You covered one section: T. You got 1 of 1 section-quiz question right.");
  });

  it("six sections shown: 'S, S1, S2 and 3 more'", async () => {
    const w = world(1, { topics: 6 });
    for (let t = 0; t < 6; t++) await shown(w.sessionId, t);
    const { summary } = (await (await end(w.sessionId)).json()) as { summary: string };
    expect(summary).toBe("You covered 6 sections: T, T1, T2 and 3 more.");
    await until(() => w.topicIds.every((id) => !!w.topicOf(id).checks_json));
  });

  it("pressed twice at once, and again later: one note, one ended_at, no AI call", async () => {
    const w = world(2);
    await shown(w.sessionId, 0);
    await until(() => !!w.topic().checks_json);
    calls.length = 0;
    const [a, b] = await Promise.all([end(w.sessionId), end(w.sessionId)]);
    const sa = ((await a.json()) as { summary: string }).summary;
    expect(((await b.json()) as { summary: string }).summary).toBe(sa);
    const ended = (db.prepare("SELECT ended_at FROM study_sessions WHERE id = ?").get(w.sessionId) as { ended_at: string }).ended_at;
    await tick();
    expect(((await (await end(w.sessionId)).json()) as { summary: string }).summary).toBe(sa);
    expect((db.prepare("SELECT ended_at FROM study_sessions WHERE id = ?").get(w.sessionId) as { ended_at: string }).ended_at).toBe(ended);
    expect(calls).toHaveLength(0);
  });

  it("a section deleted after it was shown is left out of the note; with nothing else the note says no section was opened", async () => {
    const w = world(2, { topics: 2 });
    await shown(w.sessionId, 0);
    await shown(w.sessionId, 1);
    await until(() => w.topicIds.every((id) => !!w.topicOf(id).checks_json));
    db.prepare("DELETE FROM topics WHERE id = ?").run(w.topicIds[0]);
    expect(((await (await end(w.sessionId)).json()) as { summary: string }).summary).toBe("You covered one section: T1.");
    const w2 = world(2);
    storeQuiz(w2.topicId, quizOf(2));
    await shown(w2.sessionId, 0);
    await post(checkPOST, w2.sessionId, { topicId: w2.topicId, index: 0, chosen: 1 });
    db.prepare("DELETE FROM topics WHERE id = ?").run(w2.topicId);
    expect(((await (await end(w2.sessionId)).json()) as { summary: string }).summary).toBe("You didn't open any section in this session.");
  });

  it("a session id that does not exist or belongs to someone else is 404 and a missing one never throws", async () => {
    const w = world(1);
    currentUserId = makeUser();
    expect((await end(w.sessionId)).status).toBe(404);
    expect((await end(987654321)).status).toBe(404);
    expect(errorLog).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------------- practice

/** One section of 50 slides with two facts each: 100 facts, room for a 100-question exam planned one per fact. */
function practiceWorld() {
  const w = world(50);
  return { ...w };
}
async function ready(attemptId: number) {
  for (let i = 0; i < 4000; i++) {
    const a = db.prepare("SELECT status, error, time_limit_sec FROM attempts WHERE id = ?").get(attemptId) as { status: string; error: string | null; time_limit_sec: number | null };
    if (a.status !== "generating") return a;
    await new Promise((r) => setTimeout(r, 3));
  }
  throw new Error("stuck generating");
}
const members = (attemptId: number) =>
  db.prepare("SELECT q.id, q.stem, q.case_id FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ? ORDER BY q.id").all(attemptId) as { id: number; stem: string; case_id: number | null }[];
const askedIn = (c: { content: string }) => Number(/Write (\d+) /.exec(c.content)?.[1]);
const attemptRows = (examId: number) => (db.prepare("SELECT COUNT(*) n FROM attempts WHERE exam_id = ?").get(examId) as { n: number }).n;

describe("practice: a 100-question request on one topic", () => {
  it("nine calls of 12 or 11, four at a time, 100 questions delivered, output room under the cap", async () => {
    const w = practiceWorld();
    const id = startAttempt(w.examId, { size: 100, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(pr.calls).toHaveLength(9);
    expect(pr.calls.map(askedIn)).toEqual(chunkSizes(100, 12));
    expect(pr.calls.every((c) => askedIn(c) <= 12 && (c.maxTokens ?? 0) < 32000)).toBe(true);
    expect(pr.calls.some((c) => c.content.includes("already written for this practice exam"))).toBe(false);
    expect(members(id)).toHaveLength(100);
  });

  it("call 3 of 9 failing with an overload: one follow-up call writes its questions; 100, ready", async () => {
    const w = practiceWorld();
    pr.failOn.set(3, "overloaded_error 529");
    const id = startAttempt(w.examId, { size: 100, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(pr.calls).toHaveLength(10);
    expect(members(id)).toHaveLength(100);
  });

  // Was (documented): a key problem on turn 3 stopped the rest with no word that questions were missing. Now the calls
  // run four at a time: calls 1, 2 and 4 finish, nothing more is asked, and the exam is short for "key" (it finishes
  // itself once her key is fixed).
  it("call 3 of 9 failing on her key: no later call; ready with the 34 questions of calls 1, 2 and 4, timer fitted, short for 'key'", async () => {
    const w = practiceWorld();
    pr.failOn.set(3, "Your credit balance is too low to access the API");
    const id = startAttempt(w.examId, { size: 100, mode: "timed", style: "recall", adaptive: false });
    const done = await ready(id);
    expect(done.status).toBe("ready");
    expect(done.error).toBeNull();
    expect(pr.calls).toHaveLength(4);
    expect(members(id)).toHaveLength(34);
    expect(done.time_limit_sec).toBe(34 * 72);
    expect((db.prepare("SELECT short_reason FROM attempts WHERE id = ?").get(id) as { short_reason: string }).short_reason).toBe("key");
  });

  it("a key problem on every call already running fails the exam with the provider's own words; nothing more is asked", async () => {
    const w = practiceWorld();
    [1, 2, 3, 4].forEach((n) => pr.failOn.set(n, "Your credit balance is too low to access the API"));
    const id = startAttempt(w.examId, { size: 100, mode: "tutor", style: "recall", adaptive: false });
    const done = await ready(id);
    expect(done.status).toBe("error");
    expect(done.error).toMatch(/credit balance/);
    expect(pr.calls).toHaveLength(4);
  });

  it("the route clamps a 100,000-question request to 100 and a 1-question one to 5", async () => {
    const w = practiceWorld();
    const id = ((await (await startExam(w.examId, { size: 100000, style: "recall" })).json()) as { id: number }).id;
    await ready(id);
    expect(pr.calls.reduce((a, c) => a + askedIn(c), 0)).toBe(100);
    const w2 = practiceWorld();
    const id2 = ((await (await startExam(w2.examId, { size: 1, style: "recall" })).json()) as { id: number }).id;
    await ready(id2);
    expect(members(id2)).toHaveLength(5);
  });

  it("100 in the case-set style is 25 cases written 3 at a time, none asking for more than 3", async () => {
    const w = practiceWorld();
    const id = startAttempt(w.examId, { size: 100, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(pr.calls.every((c) => c.purpose === "case sets" && askedIn(c) <= 3)).toBe(true);
    expect(pr.calls.map(askedIn)).toEqual(chunkSizes(25, 3));
    expect(new Set(members(id).map((m) => m.case_id)).size).toBe(25);
  });
});

describe("practice: double start", () => {
  const hold = () => {
    pr.gate = new Promise<void>((r) => (release = r));
  };

  it("five simultaneous taps on Start make one attempt and one AI call", async () => {
    const w = practiceWorld();
    hold();
    const ids = await Promise.all(Array.from({ length: 5 }, async () => ((await (await startExam(w.examId, { size: 10, style: "recall" })).json()) as { id: number }).id));
    expect(new Set(ids).size).toBe(1);
    expect(attemptRows(w.examId)).toBe(1);
    release!();
    await ready(ids[0]);
    expect(pr.calls).toHaveLength(1);
  });

  it("another student posting to my exam gets 404 and creates and reveals nothing; their own exam gets their own attempt", async () => {
    const mine = practiceWorld();
    const theirs = practiceWorld();
    hold();
    currentUserId = mine.userId;
    const a = ((await (await startExam(mine.examId)).json()) as { id: number }).id;
    currentUserId = theirs.userId;
    const res = await startExam(mine.examId);
    expect(res.status).toBe(404);
    expect(attemptRows(mine.examId)).toBe(1);
    const b = ((await (await startExam(theirs.examId)).json()) as { id: number }).id;
    expect(b).not.toBe(a);
    expect(writingAttempt(theirs.userId, mine.examId)).toBeNull();
    release!();
    await ready(a);
    await ready(b);
  });

  it("the same student starting two different exams at once gets two attempts", async () => {
    const one = practiceWorld();
    const two = practiceWorld();
    db.prepare("UPDATE exams SET user_id = ? WHERE id = ?").run(one.userId, two.examId);
    currentUserId = one.userId;
    hold();
    const a = ((await (await startExam(one.examId, { size: 5 })).json()) as { id: number }).id;
    const b = ((await (await startExam(two.examId, { size: 5 })).json()) as { id: number }).id;
    expect(b).not.toBe(a);
    expect(writingAttempt(one.userId, one.examId)).toBe(a);
    expect(writingAttempt(one.userId, two.examId)).toBe(b);
    release!();
    await ready(a);
    await ready(b);
  });

  // (documented) "Same exam, still writing, under two minutes" is the only test: a second Start with a different size,
  // style, mode or scope inside that window gets the FIRST exam back, not the one she just asked for.
  it("(documented) a second Start with different settings inside the window returns the first exam as it was", async () => {
    const w = practiceWorld();
    hold();
    const a = ((await (await startExam(w.examId, { size: 5, style: "recall", mode: "tutor" })).json()) as { id: number }).id;
    const b = ((await (await startExam(w.examId, { size: 100, style: "caseset", mode: "timed" })).json()) as { id: number }).id;
    expect(b).toBe(a);
    expect((db.prepare("SELECT mode FROM attempts WHERE id = ?").get(a) as { mode: string }).mode).toBe("tutor");
    release!();
    await ready(a);
  });

  it("an exam that failed does not block a new start", async () => {
    const w = practiceWorld();
    pr.failOn.set(1, "Your credit balance is too low");
    const a = ((await (await startExam(w.examId, { size: 5, style: "recall" })).json()) as { id: number }).id;
    expect((await ready(a)).status).toBe("error");
    pr.failOn.clear();
    const b = ((await (await startExam(w.examId, { size: 5, style: "recall" })).json()) as { id: number }).id;
    expect(b).not.toBe(a);
    expect((await ready(b)).status).toBe("ready");
  });

  // Fixed: the window was two minutes, shorter than a 100-question exam takes to write; it is ten now.
  it("a tap on Start a few minutes in, while the first exam is still being written, gets the same exam; only after ten minutes a new one", async () => {
    const w = practiceWorld();
    hold();
    const a = ((await (await startExam(w.examId, { size: 5, style: "recall" })).json()) as { id: number }).id;
    db.prepare("UPDATE attempts SET started_at = datetime('now', '-3 minutes') WHERE id = ?").run(a);
    expect(((await (await startExam(w.examId, { size: 5, style: "recall" })).json()) as { id: number }).id).toBe(a);
    db.prepare("UPDATE attempts SET started_at = datetime('now', '-11 minutes') WHERE id = ?").run(a);
    const b = ((await (await startExam(w.examId, { size: 5, style: "recall" })).json()) as { id: number }).id;
    expect(b).not.toBe(a);
    release!();
    await ready(a);
    await ready(b);
    expect(pr.calls).toHaveLength(2);
  });
});

describe("practice: stale attempts at boot", () => {
  const add = (examId: number, status: string, age: string) =>
    Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, started_at) VALUES (?, 'tutor', ?, datetime('now', ?))").run(examId, status, age).lastInsertRowid);
  const row = (id: number) => db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(id) as { status: string; error: string | null };

  it("299 seconds old stays; 301 seconds old fails; ready, finished and error attempts of any age are untouched; a second call changes nothing", () => {
    const w = practiceWorld();
    recoverStaleAttempts();
    const young = add(w.examId, "generating", "-299 seconds");
    const old = add(w.examId, "generating", "-301 seconds");
    const ancientReady = add(w.examId, "ready", "-2 days");
    const ancientDone = add(w.examId, "finished", "-2 days");
    const ancientError = add(w.examId, "error", "-2 days");
    expect(recoverStaleAttempts()).toEqual({ recovered: 0, failed: 1 });
    expect(row(young)).toEqual({ status: "generating", error: null });
    expect(row(old)).toEqual({ status: "error", error: INTERRUPTED_ATTEMPT });
    expect(row(ancientReady).status).toBe("ready");
    expect(row(ancientDone).status).toBe("finished");
    expect(row(ancientError)).toEqual({ status: "error", error: null });
    expect(recoverStaleAttempts()).toEqual({ recovered: 0, failed: 0 });
  });

  it("a stale attempt no longer counts as 'being written' for a second tap once the boot sweep marked it failed", () => {
    const w = practiceWorld();
    // Six minutes old: inside the ten-minute reuse window, but past the five minutes after which a restart's sweep fails it.
    const old = add(w.examId, "generating", "-6 minutes");
    expect(writingAttempt(w.userId, w.examId)).toBe(old);
    recoverStaleAttempts();
    expect(writingAttempt(w.userId, w.examId)).toBeNull();
    expect(row(old).status).toBe("error");
  });

  it("the ten-minute reuse window: 599 seconds reuses, 601 seconds does not", () => {
    const w = practiceWorld();
    const a = add(w.examId, "generating", "-599 seconds");
    expect(writingAttempt(w.userId, w.examId)).toBe(a);
    db.prepare("UPDATE attempts SET started_at = datetime('now', '-601 seconds') WHERE id = ?").run(a);
    expect(writingAttempt(w.userId, w.examId)).toBeNull();
  });

  it("a stale attempt with questions already attached is only marked error, never emptied", () => {
    const w = practiceWorld();
    const id = add(w.examId, "generating", "-10 minutes");
    const q = Number(db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e')").run(w.examId, w.topicId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 0)").run(id, q);
    recoverStaleAttempts();
    expect(members(id)).toHaveLength(1);
  });
});
