import { randomUUID } from "crypto";
import { z } from "zod";
import { db, examOwner, getMeta, setMeta, type PageRow, type Topic } from "./db";
import { generate, type Part } from "./ai";
import { credentials } from "./credentials";
import { parseNotes, type SlideNotes } from "./processing";
import { searchLibrary, topicConcepts, upsertConcept } from "./memory";
import { shuffle } from "./practicePlan";
import { validateMcq } from "./mcq";
import { ANGLE_TEXT, distinctFacts, normStem, planQuizByFacts, QUIZ_MAX, type Angle, type FactSlide } from "./quizPlan";
import { coveredFacts, FILLER_SCAN_VERSION, quotedFacts, trimRamble } from "./lessonCoverage";
import { clearTopicQuizAnswers, topicHasQuizAnswers } from "./quizProgress";
import { EXAM_STYLE, EXAM_STYLE_CHECK, NO_COVER_CHECK, NO_COVER_RULE } from "./examStyle";
import { reportedStems } from "./reportedQuestions";
import { markPictures, mentionsPicture, pictureFor, PICTURE_RULES } from "./questionImage";

/** A lesson as stored in topics.lesson_json (the writer's parts are put together into this). */
export const Lesson = z.object({
  intro: z.string(),
  slides: z.array(z.object({ page_id: z.number(), explanation: z.string() })),
  key_points: z.array(z.string()),
  connections: z.string().nullable(),
});
/** Stored lessons carry the version of the writer that made them (missing = 1); older ones are rewritten once on next open.
 *  3 = slide by slide: every slide's picture with its own explanation under it (earlier lessons were one continuous text).
 *  4 = explains in its own words; a lesson that copied the slides' sentences gets one repair. A version-3 lesson that
 *      already explains (few facts copied word for word) is kept, so the rewrite costs nothing where nothing would change.
 *      (Written in parts of a few slides since, with the same stored shape: nothing stored had to change.) */
export type Lesson = z.infer<typeof Lesson> & { version?: number };
export const LESSON_VERSION = 4;
/**
 * Share of the slides' (long enough) facts a lesson may repeat word for word. Above it a stored version-3 lesson is
 * rewritten, and a freshly written part has its copied slides asked again (in the one repair call) to be explained.
 */
const LESSON_QUOTED_MAX = 0.3;
/**
 * Whether a lesson copies the slides rather than explains them. A section with fewer than three facts long enough to
 * judge is never called a copier: one quoted list or classification (which the writer is told to give exactly) would
 * be a third or more of it on its own.
 */
const copiesSlides = (q: ReturnType<typeof quotedFacts>) => q.judged >= 3 && q.ratio > LESSON_QUOTED_MAX;
/**
 * A slide's notes with damage tolerated: unreadable notes count as none, and only the text entries of the fact and
 * annotation lists are kept. One damaged slide must not stop a whole lesson or quiz.
 */
export function slideNotes(p: Pick<PageRow, "notes_json">): SlideNotes | null {
  let n: SlideNotes | null;
  try {
    n = parseNotes(p);
  } catch {
    return null;
  }
  if (!n || typeof n !== "object" || Array.isArray(n)) return null;
  const texts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { ...n, key_facts: texts(n.key_facts), annotations: texts(n.annotations) };
}
/** The section's distinct facts, as the coverage and copy checks see them (each once; slides often repeat one). */
function sectionFacts(pages: PageRow[]): string[] {
  return [...new Map(pages.flatMap((p) => slideNotes(p)?.key_facts ?? []).map((f) => [normStem(f), f.trim()] as const)).entries()]
    .filter(([key, f]) => key && f)
    .map(([, f]) => f);
}
/** All the lesson's teaching text in one string (intro, then each slide's explanation), for the coverage check and tests. */
export function lessonText(lesson: Pick<Lesson, "intro" | "slides">): string {
  return [lesson.intro ?? "", ...(lesson.slides ?? []).map((s) => s?.explanation ?? "")].filter(Boolean).join("\n\n");
}
/** Below this share of facts found by the word check (coveredFacts) a finished lesson is logged; nothing else uses it. */
const LESSON_COVERAGE = 0.8;

/** Stored in topics.checks_version. Quizzes written by an older version are rewritten once on next open.
 *  3 = one question per distinct fact (5-25), per-option notes, quality-tier writer.
 *  4 = one question per distinct fact with no floor and no cap.
 *  5 = at most QUIZ_MAX questions: a denser section condenses several facts into one question (a version-3 or -4 quiz
 *      whose section has at most 25 facts, and at least 5 for version 3, was written the same way and is kept). */
export const QUIZ_VERSION = 5;

const SectionQuiz = z.object({
  questions: z.array(
    z.object({
      slot: z.number().describe("The Q number of the planned question this answers"),
      question: z.string(),
      options: z.array(z.string()).describe("4 answer choices, no letter prefixes"),
      correct_index: z.number().describe("0-based index of the correct option"),
      correct_answer: z.string().describe("The correct option, copied exactly as written in options"),
      explanation: z.string().describe("Why it's right and why the tempting wrong answer is wrong. Cite the slide as (Lecture, slide N)"),
      option_notes: z
        .array(z.string())
        .describe("One short sentence per option, in the same order as options: for the correct one why it is right, for each wrong one why it is wrong (what it confuses)"),
      source_page_id: z.number().describe("The [P…] id of the slide this question tests"),
      image_page_id: z
        .number()
        .nullable()
        .describe("Only when the question refers to a picture: the [P…] id of a slide marked [IMAGE] or [IMAGE-CASE] whose picture the student will see. Otherwise null"),
      concept: z.string().describe("The concept tested; use one of the listed concept names when one fits"),
    }),
  ),
});

const QuizCheck = z.object({
  verdicts: z.array(
    z.object({
      n: z.number().describe("The question's number, copied from the list"),
      ok: z.boolean().describe("True only if the keyed answer is stated or directly implied by the slides, no other option is also correct, and it doesn't repeat an earlier question"),
      picture: z
        .boolean()
        .describe("True if answering needs something the student must see: a picture, radiograph, diagram, chart, a slide named as such, or anything labeled, drawn, circled or pointed at"),
      reason: z.string().describe("One short line"),
    }),
  ),
});

/** One section-quiz question as stored in topics.checks_json. Positions in the array never change once written. */
export type QuizQuestion = {
  /** Stable id (highlights, reports). Old quizzes have none. */
  id?: string;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  /** One sentence per option (same order as options): why right / why wrong. Quizzes before version 3 have none. */
  option_notes?: string[];
  concept: string;
  source_page_id?: number | null;
  /** Slide whose picture is shown with the question (cropped to the clinical image when the notes marked one). */
  image_page_id?: number | null;
  kind?: Angle;
  /** Reported by the student: not shown again in this copy of the exam. */
  hidden?: boolean;
  report_note?: string | null;
};

export function topicPages(topic: Topic): (PageRow & { filename: string })[] {
  const ids = JSON.parse(topic.page_ids) as number[];
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT p.*, d.filename FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id IN (${ids
        .map(() => "?")
        .join(",")}) ORDER BY d.id, p.page_number`,
    )
    .all(...ids) as (PageRow & { filename: string })[];
}

/**
 * The slides' notes as the writers read them. With `factIds` (the lesson writer) each fact carries its number
 * ("- F7: …"), so the writer can say which facts an entry explains.
 */
export function slideNotesText(pages: (PageRow & { filename: string })[], factIds?: ReadonlyMap<number, readonly (number | null)[]>): string {
  return pages
    .map((p) => {
      const n = slideNotes(p);
      if (!n) return `[P${p.id}] ${p.filename} slide ${p.page_number}\n${p.text}`;
      return [
        `[P${p.id}] ${p.filename} slide ${p.page_number}: ${n.title}${n.emphasized ? ` ★IMPORTANT${n.emphasis_note ? ` (${n.emphasis_note})` : ""}` : ""}`,
        n.summary,
        n.image_description && `Image: ${n.image_description}`,
        // One line per fact (a fact with a line break inside could otherwise pose as a planned question in the prompt).
        ...n.key_facts.map((f, k) => {
          const id = factIds?.get(p.id)?.[k];
          return `- ${id != null ? `F${id}: ` : ""}${f.replace(/\s+/g, " ").trim()}`;
        }),
        ...n.annotations.map((a) => `Annotation: ${a}`),
        n.case_prompt && `Case: ${n.case_prompt}${n.case_answer ? ` → ${n.case_answer}` : ""}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

const inflight = new Map<number, Promise<Lesson>>();

/** Lessons are generated once per topic and cached; concurrent requests share one generation. */
/** The stored lesson is up to date (written by this version); older ones are rewritten once on next open. */
export const lessonIsCurrent = (topic: Pick<Topic, "lesson_json" | "page_ids">): boolean => {
  if (!topic.lesson_json) return false;
  try {
    const lesson = JSON.parse(topic.lesson_json) as Lesson;
    const v = lesson.version ?? 1;
    if (v >= LESSON_VERSION) return true;
    if (v !== 3) return false;
    // Slide by slide already; kept unless it mostly repeats the slides instead of explaining them.
    const pages = typeof topic.page_ids === "string" ? topicPages(topic as Topic) : [];
    return !copiesSlides(quotedFacts(lessonText(lesson), sectionFacts(pages)));
  } catch {
    return false;
  }
};

/** How long a failed lesson or quiz is left alone by automatic starts (prefetch, the quiz begun when a lesson shows). */
export const FAILURE_COOLDOWN_MS = 10 * 60_000;
type FailureKind = "lesson" | "quiz";
const failureKey = (kind: FailureKind, topicId: number) => `${kind}_fail:${topicId}`;

/**
 * Remember that writing a topic's lesson or quiz just failed (meta: the time, then a short reason). A failure that
 * will recur (the writer runs out of room, the key has no credit) is billed again on every try, so nothing starts it
 * again on its own for a while; the student's own open or "Try again" still does.
 */
function markFailure(kind: FailureKind, topicId: number, err: unknown) {
  const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].replace(/sk-[\w-]+/g, "[key]").slice(0, 120);
  setMeta(failureKey(kind, topicId), `${new Date().toISOString()} ${reason}`);
}

function clearFailure(kind: FailureKind, topicId: number) {
  db.prepare("DELETE FROM meta WHERE key = ?").run(failureKey(kind, topicId));
}

/** Writing this topic's lesson or quiz failed less than FAILURE_COOLDOWN_MS ago. */
export function recentFailure(kind: FailureKind, topicId: number): boolean {
  const at = Date.parse((getMeta(failureKey(kind, topicId)) ?? "").split(" ")[0]);
  return Number.isFinite(at) && Date.now() - at < FAILURE_COOLDOWN_MS;
}

export function getLesson(topic: Topic): Promise<Lesson> {
  if (lessonIsCurrent(topic)) {
    const clean = cleanStoredLesson(topic, topic.lesson_json!, JSON.parse(topic.lesson_json!) as Lesson);
    if (clean) return Promise.resolve(clean);
    // (the stored lesson was nothing but filler: written again below)
  }
  let p = inflight.get(topic.id);
  if (!p) {
    p = generateLesson(topic)
      .then((lesson) => {
        clearFailure("lesson", topic.id);
        return lesson;
      })
      .catch((err: unknown) => {
        markFailure("lesson", topic.id, err);
        // A rewrite that fails (the AI is down, the key is out of credit) doesn't take away the slide-by-slide
        // lesson she already had: that one is shown, and the rewrite is tried again on a later open.
        const old = storedSlideLesson(topic);
        const clean = old && cleanStoredLesson(topic, topic.lesson_json!, old);
        if (!clean) throw err;
        console.error(`Rewriting the lesson for topic ${topic.id} failed; showing the stored one`, err);
        return clean;
      })
      .finally(() => inflight.delete(topic.id));
    inflight.set(topic.id, p);
  }
  return p;
}

/** The stored lesson if it is already slide by slide (version 3 or later) and readable; else null. */
function storedSlideLesson(topic: Pick<Topic, "lesson_json">): Lesson | null {
  if (!topic.lesson_json) return null;
  try {
    const l = JSON.parse(topic.lesson_json) as Lesson;
    return l && typeof l === "object" && (l.version ?? 1) >= 3 && Array.isArray(l.slides) ? l : null;
  } catch {
    return null;
  }
}

/**
 * Keep only entries for the section's own slides with real text, one per slide (a slide given twice has its texts
 * joined), in slide order. Nothing else about the writer's output is trusted blindly.
 */
function tidyLesson(raw: Lesson, pages: PageRow[]): Lesson {
  const order = new Map(pages.map((p, i) => [p.id, i]));
  const byPage = new Map<number, string>();
  for (const s of Array.isArray(raw.slides) ? raw.slides : []) {
    if (!s || !order.has(s.page_id) || typeof s.explanation !== "string") continue;
    // A writer that drifts into "Done. Ok. Stop. Bye." at the end of a long explanation: that part goes. An entry
    // that was nothing but filler is dropped (the slide then counts as left out and gets a repair).
    const text = trimRamble(s.explanation).text.trim();
    if (!text) continue;
    byPage.set(s.page_id, byPage.has(s.page_id) ? `${byPage.get(s.page_id)}\n\n${text}` : text);
  }
  return {
    ...raw,
    intro: typeof raw.intro === "string" ? trimRamble(raw.intro).text.trim() : "",
    slides: [...byPage].sort((a, b) => order.get(a[0])! - order.get(b[0])!).map(([page_id, explanation]) => ({ page_id, explanation })),
    key_points: Array.isArray(raw.key_points) ? raw.key_points : [],
    connections: typeof raw.connections === "string" ? raw.connections : null,
  };
}

/**
 * A stored lesson with filler the writer drifted into (lessons written before the trim existed): the filler is cut
 * when the lesson is served and the clean lesson saved back, with no AI call. Returns the lesson to show.
 * `raw` is the stored JSON the lesson was read from: the clean one is saved only over that exact text, so a topic
 * read a while ago never overwrites a lesson written since; then the newer stored lesson is shown instead.
 */
function cleanStoredLesson(topic: Pick<Topic, "id">, raw: string, lesson: Lesson): Lesson | null {
  const c = cleanLesson(lesson);
  if (!c.changed) return lesson;
  const empty = c.dropped > 0 && c.lesson.slides.length === 0;
  const saved = db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ? AND lesson_json = ?").run(empty ? null : JSON.stringify(c.lesson), topic.id, raw).changes > 0;
  if (!saved) return freshStoredLesson(topic.id);
  console.warn(`Lesson for topic ${topic.id}: filler cut from the stored lesson (${c.trimmed} slide(s) trimmed, ${c.dropped} dropped)`);
  // Nothing but filler: there is no lesson here to show; it is written again on the next open.
  return empty ? null : c.lesson;
}

/** The topic's stored lesson as it is now (null when there is none or it can't be read). */
function freshStoredLesson(topicId: number): Lesson | null {
  const row = db.prepare("SELECT lesson_json FROM topics WHERE id = ?").get(topicId) as { lesson_json: string | null } | undefined;
  if (!row?.lesson_json) return null;
  try {
    const l = JSON.parse(row.lesson_json) as Lesson;
    return l && typeof l === "object" && Array.isArray(l.slides) ? l : null;
  } catch {
    return null;
  }
}

/** Cut filler from a lesson's slide entries and intro (pure). `trimmed` entries kept shorter, `dropped` entries gone. */
export function cleanLesson(lesson: Lesson): { lesson: Lesson; changed: boolean; trimmed: number; dropped: number; intro: boolean } {
  let trimmed = 0;
  let dropped = 0;
  const slides = (Array.isArray(lesson.slides) ? lesson.slides : [])
    .map((s) => {
      if (!s || typeof s.explanation !== "string") return s;
      const t = trimRamble(s.explanation);
      if (!t.trimmed) return s;
      if (!t.text.trim()) {
        dropped++;
        return null;
      }
      trimmed++;
      return { ...s, explanation: t.text.trim() };
    })
    .filter((s): s is Lesson["slides"][number] => s != null);
  const intro = typeof lesson.intro === "string" ? trimRamble(lesson.intro) : null;
  const changed = trimmed > 0 || dropped > 0 || !!intro?.trimmed;
  return {
    lesson: changed ? { ...lesson, slides, intro: intro ? intro.text.trim() : lesson.intro } : lesson,
    changed,
    trimmed,
    dropped,
    intro: !!intro?.trimmed,
  };
}

export type LessonScanHit = { topicId: number; examId: number; exam: string; lecture: string | null; section: string; trimmed: number; dropped: number; intro: boolean };
export type LessonScan = { at: string; checked: number; found: LessonScanHit[] };
const LESSON_SCAN_KEY = "lesson_filler_scan";

/**
 * Check every stored lesson for filler the writer drifted into, clean the ones that have it (no AI call) and record
 * what was found (meta, for the Admin page). Runs from the Admin page; at start-up see scanLessonsForFillerOnce.
 */
export function scanLessonsForFiller(): LessonScan {
  const rows = db
    .prepare(
      `SELECT t.id, t.exam_id, t.title, t.lesson_json, e.name exam, d.filename lecture
       FROM topics t JOIN exams e ON e.id = t.exam_id LEFT JOIN documents d ON d.id = t.document_id
       WHERE t.lesson_json IS NOT NULL ORDER BY t.exam_id, t.position`,
    )
    .all() as { id: number; exam_id: number; title: string; lesson_json: string; exam: string; lecture: string | null }[];
  const found: LessonScanHit[] = [];
  // Saved only over the exact text that was read (as in cleanStoredLesson): a lesson written since is left alone.
  const save = db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ? AND lesson_json = ?");
  db.transaction(() => {
    for (const r of rows) {
      let lesson: Lesson;
      try {
        lesson = JSON.parse(r.lesson_json) as Lesson;
      } catch {
        continue;
      }
      if (!lesson || typeof lesson !== "object") continue;
      const c = cleanLesson(lesson);
      if (!c.changed) continue;
      // A lesson left with no slides at all was nothing but filler: cleared, so it is written again on the next open.
      if (save.run(c.dropped > 0 && c.lesson.slides.length === 0 ? null : JSON.stringify(c.lesson), r.id, r.lesson_json).changes === 0) continue;
      found.push({ topicId: r.id, examId: r.exam_id, exam: r.exam, lecture: r.lecture, section: r.title, trimmed: c.trimmed, dropped: c.dropped, intro: c.intro });
    }
  })();
  const scan: LessonScan = { at: new Date().toISOString(), checked: rows.length, found };
  // The record keeps every lesson ever found, so the Admin page still shows what happened after the clean-up itself
  // found nothing more.
  const prior = lastLessonScan();
  const history = [...(prior?.found ?? []).filter((h) => !found.some((f) => f.topicId === h.topicId)), ...found];
  setMeta(LESSON_SCAN_KEY, JSON.stringify({ ...scan, found: history }));
  return scan;
}

const FILLER_SCAN_DONE_KEY = "lesson_filler_scan_done";

/**
 * The start-up check: every stored lesson is scanned once per version of the filler trimmer (FILLER_SCAN_VERSION),
 * not on every start. Lessons written since are trimmed as they are written. Returns null when it had already run.
 */
export function scanLessonsForFillerOnce(): LessonScan | null {
  if (getMeta(FILLER_SCAN_DONE_KEY) === String(FILLER_SCAN_VERSION)) return null;
  const scan = scanLessonsForFiller();
  setMeta(FILLER_SCAN_DONE_KEY, String(FILLER_SCAN_VERSION));
  return scan;
}

/** The latest filler check: when, how many lessons, and every lesson ever found with filler (null before the first). */
export function lastLessonScan(): LessonScan | null {
  const raw = getMeta(LESSON_SCAN_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as LessonScan;
    return s && typeof s === "object" && Array.isArray(s.found) ? s : null;
  } catch {
    return null;
  }
}

/** A lesson is written at most this many slides per call: one slide can't run away with a whole section's output, and a cut-off costs one part. */
const LESSON_PART_MAX = 5;
/** Lesson parts written at the same time. */
const LESSON_PARALLEL = 2;
/**
 * Output room per slide in a lesson call (about 2-5 sentences per fact, plus the model's thinking, which counts toward
 * the limit), the room every call gets on top, and the extra for the call that also writes the intro and key points.
 * A five-slide part gets 8,500 (9,500 with the intro); one long section used to get 24,000 in one go.
 */
const LESSON_TOKENS_PER_SLIDE = 1200;
const LESSON_TOKENS_BASE = 2500;
const LESSON_TOKENS_OVERVIEW = 1000;

/** A section's slides in parts of at most LESSON_PART_MAX, in order and as even as possible (6 slides are 3 + 3, not 5 + 1). */
export function lessonParts<T>(items: T[]): T[][] {
  const n = Math.max(1, Math.ceil(items.length / LESSON_PART_MAX));
  const out: T[][] = [];
  for (let i = 0, start = 0; i < n; i++) {
    const size = Math.floor(items.length / n) + (i < items.length % n ? 1 : 0);
    out.push(items.slice(start, (start += size)));
  }
  return out;
}

/** One entry the lesson writer returns: a slide's explanation and the numbers of the facts it says it explains. */
const LessonEntry = z.object({
  page_id: z.number().describe("The slide's P number"),
  explanation: z.string().describe("The slide's explanation, in markdown"),
  facts: z.array(z.number()).describe("The F numbers of the facts this entry explains (7 for F7)"),
});
const LessonPart = z.object({ slides: z.array(LessonEntry).describe("One entry per slide to learn from, in the order given") });
/** The part that also writes what belongs to the whole section (the first; a section of up to five slides is one part). */
const LessonFirstPart = LessonPart.extend({
  intro: z.string().describe("One sentence, in plain words, saying what the whole section is about"),
  key_points: z
    .array(z.string())
    .describe('5-10 points to remember from the whole section, in plain words. Points from slides marked ★IMPORTANT come first and begin with "★ "'),
  connections: z.string().nullable().describe("How the section ties to the related slides from the student's earlier exams (cite them), or null if nothing relevant"),
});

/**
 * The section's facts, numbered F1…Fn across the section in slide order. A fact a later slide repeats (slides often do)
 * keeps its first number, and an entry for any slide that lists it may explain it. A "fact" with no letters or digits
 * gets no number and isn't asked for.
 */
type NumberedFacts = {
  /** Per slide, the number of each of its key facts, in the notes' order (null: not counted). */
  ids: Map<number, (number | null)[]>;
  /** Per number: the fact's text and the slides that list it. */
  facts: Map<number, { text: string; pages: number[] }>;
};

function numberFacts(pages: PageRow[]): NumberedFacts {
  const byKey = new Map<string, number>();
  const ids = new Map<number, (number | null)[]>();
  const facts = new Map<number, { text: string; pages: number[] }>();
  for (const p of pages) {
    ids.set(
      p.id,
      (slideNotes(p)?.key_facts ?? []).map((f) => {
        const key = normStem(f);
        if (!key) return null;
        let id = byKey.get(key);
        if (id == null) {
          id = byKey.size + 1;
          byKey.set(key, id);
          facts.set(id, { text: f.trim(), pages: [] });
        }
        const on = facts.get(id)!.pages;
        if (!on.includes(p.id)) on.push(p.id);
        return id;
      }),
    );
  }
  return { ids, facts };
}

/** The numbers of one slide's facts (each once). */
const factsOn = (nf: NumberedFacts, pageId: number) => [...new Set((nf.ids.get(pageId) ?? []).filter((x): x is number => x != null))];
const factTexts = (nf: NumberedFacts, ids: number[]) => ids.map((id) => nf.facts.get(id)!.text);

/** A slide's entry while the lesson is being written: its text and the numbers of its own facts it explains. */
type Entry = { text: string; facts: Set<number> };

/**
 * The entries a call returned for its own slides, filler trimmed (an entry that was nothing but filler counts as not
 * written). Fact numbers that are not this slide's are ignored; "F7" is read as 7. A slide given twice has its texts
 * joined. Entries for slides the call wasn't given are dropped.
 */
function readEntries(slides: unknown, pages: PageRow[], nf: NumberedFacts): Map<number, Entry> {
  const mine = new Set(pages.map((p) => p.id));
  const out = new Map<number, Entry>();
  for (const s of Array.isArray(slides) ? slides : []) {
    if (!s || typeof s !== "object") continue;
    const { page_id, explanation, facts } = s as { page_id?: unknown; explanation?: unknown; facts?: unknown };
    if (typeof page_id !== "number" || !mine.has(page_id) || typeof explanation !== "string") continue;
    const text = trimRamble(explanation).text.trim();
    if (!text) continue;
    const own = new Set(factsOn(nf, page_id));
    const claimed = new Set<number>();
    for (const f of Array.isArray(facts) ? facts : []) {
      const n = typeof f === "number" ? f : typeof f === "string" ? Number(f.trim().replace(/^F/i, "")) : NaN;
      if (own.has(n)) claimed.add(n);
    }
    const had = out.get(page_id);
    out.set(page_id, had ? { text: `${had.text}\n\n${text}`, facts: new Set([...had.facts, ...claimed]) } : { text, facts: claimed });
  }
  return out;
}

/** The writer ran out of room (see generate). */
const cutOff = (err: unknown) => err instanceof Error && /cut off/i.test(err.message);

/**
 * Run `fn` over the items with at most `limit` at a time, results in item order. After one fails no new one starts,
 * and the first failure is thrown once those running have finished.
 */
async function inTurn<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const state: { failure?: { err: unknown } } = {};
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!state.failure && next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i]);
        } catch (err) {
          state.failure ??= { err };
        }
      }
    }),
  );
  if (state.failure) throw state.failure.err;
  return out;
}

type LessonCall = { pages: (PageRow & { filename: string })[]; first: boolean; part: number };

/**
 * Write a topic's lesson:
 * 1. The slides are written in parts of at most five (two calls at a time), each fact numbered F1…Fn; each entry says
 *    which numbers it explains. The first part also writes the intro, key points and connections, from a short list of
 *    the rest of the section (so a section of up to five slides is one call in all).
 * 2. A part whose call fails is tried once more (one cut off for length: split in two); if it fails again, the lesson
 *    fails as a whole and nothing is stored (a lesson with a hole must never pass for a finished one).
 * 3. Coverage is exact: a fact is explained when an entry of a slide that lists it says so. Slides with facts missing,
 *    slides with a fact of their own (first listed there) or a case that got no entry, and the copied slides of a part that mostly copies the slides go
 *    into one repair call asking only for those slides (re-asked once; a repair that gives nothing usable leaves the
 *    entry as it was).
 */
async function generateLesson(topic: Topic): Promise<Lesson> {
  const pages = topicPages(topic);
  const concepts = topicConcepts(topic.id, topic.exam_id);
  const userId = examOwner(topic.exam_id);
  const earlier = searchLibrary(userId, `${topic.title} ${concepts.map((c) => c.name).join(" ")}`, 5, topic.exam_id);
  const creds = credentials(userId);
  const nf = numberFacts(pages);
  const parts = lessonParts(pages);

  // The system prompt and the section line open every call of this lesson. Marked for caching only when it is really
  // sent again within seconds: from the third part on (the first two run together, so neither can read what the other
  // writes). A lesson of one or two parts pays nothing extra; its repair, when there is one, is the only repeat.
  const cache = parts.length > 2;
  const header = `Section: ${topic.title}\n${topic.summary}`;
  const content = (body: string): Part[] | string =>
    cache
      ? [
          { type: "text", text: header },
          { type: "text", text: body },
        ]
      : `${header}\n\n${body}`;
  const mastery = `Concepts and the student's mastery so far: ${
    concepts.map((c) => `${c.name} (${c.mastery == null ? "untested" : Math.round(c.mastery * 100) + "%"})`).join(", ") || "none"
  }`;
  const titleOf = (p: PageRow) => slideNotes(p)?.title?.trim() || `slide ${p.page_number}`;

  const write = async (call: LessonCall, room = 1) => {
    const own = new Set(call.pages.map((p) => p.id));
    const rest = pages.filter((p) => !own.has(p.id));
    const body = [
      parts.length > 1
        ? `This is part ${call.part + 1} of ${parts.length} of the section.${
            call.part > 0 ? ` Earlier parts covered:\n${parts.slice(0, call.part).map((ps, i) => `- Part ${i + 1}: ${ps.map(titleOf).join("; ")}`).join("\n")}` : ""
          }`
        : "",
      mastery,
      `Slides:\n${slideNotesText(call.pages, nf.ids)}`,
      call.first && rest.length
        ? `The rest of the section, only for the intro and key points (its slides are explained in other parts):\n${rest
            .map((p) => {
              const n = slideNotes(p);
              return `- ${titleOf(p)}${n?.emphasized ? " ★IMPORTANT" : ""}${n?.key_facts.length ? `: ${n.key_facts.map((f) => f.replace(/\s+/g, " ").trim()).join("; ")}` : ""}`;
            })
            .join("\n")}`
        : "",
      call.first
        ? earlier.length
          ? `Related slides from the student's earlier exams:\n${earlier.map((h) => `- ${h.exam_name} / ${h.filename} slide ${h.page_number}: ${h.title} — ${h.snippet}`).join("\n")}`
          : "No related material from earlier exams."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const out = (await generate({
      creds,
      purpose: "lesson",
      ref: `topic:${topic.id}`,
      schema: call.first ? LessonFirstPart : LessonPart,
      effort: "medium",
      maxTokens: (LESSON_TOKENS_PER_SLIDE * call.pages.length + LESSON_TOKENS_BASE + (call.first ? LESSON_TOKENS_OVERVIEW : 0)) * room,
      system: LESSON_SYSTEM,
      content: content(body),
      cache,
    })) as Partial<z.infer<typeof LessonFirstPart>> | null;
    // (generate throws on a reply it can't read; this only guards against nothing at all)
    if (!out || typeof out !== "object") throw new Error("The lesson writer returned nothing.");
    return { pages: call.pages, entries: readEntries(out.slides, call.pages, nf), overview: call.first ? out : null };
  };

  // Each part is tried once more when it fails; one cut off for length is tried again as two halves (a single slide:
  // with twice the room). Only a part that fails twice fails the lesson.
  const written = (
    await inTurn(parts, LESSON_PARALLEL, async (ps) => {
      const call: LessonCall = { pages: ps, first: ps === parts[0], part: parts.indexOf(ps) };
      try {
        return [await write(call)];
      } catch (err) {
        console.warn(`Lesson for topic ${topic.id}: part ${call.part + 1} of ${parts.length} failed; trying it once more`, err);
        if (cutOff(err) && ps.length > 1) {
          const half = Math.ceil(ps.length / 2);
          return [await write({ ...call, pages: ps.slice(0, half) }), await write({ ...call, pages: ps.slice(half), first: false })];
        }
        return [await write(call, cutOff(err) ? 2 : 1)];
      }
    })
  ).flat();

  const entries = new Map<number, Entry>();
  for (const w of written) for (const [id, e] of w.entries) entries.set(id, e);
  const overview = written.find((w) => w.overview)?.overview ?? null;

  // A part that mostly copies the slides (as the stored version-3 lessons are judged): its slides whose entry repeats
  // one of their own facts word for word are asked again, to be explained.
  const copied = new Set<number>();
  for (const w of written) {
    const own = [...new Set(w.pages.flatMap((p) => factsOn(nf, p.id)))];
    if (!copiesSlides(quotedFacts([...w.entries.values()].map((e) => e.text).join("\n\n"), factTexts(nf, own)))) continue;
    for (const p of w.pages) {
      const e = entries.get(p.id);
      if (e && quotedFacts(e.text, factTexts(nf, factsOn(nf, p.id))).quoted.length > 0) copied.add(p.id);
    }
  }
  const explained = () => new Set([...entries.values()].flatMap((e) => [...e.facts]));
  // A missing fact is asked for under the first slide that lists it.
  const missingOn = (pageId: number, done: Set<number>) => factsOn(nf, pageId).filter((id) => !done.has(id) && nf.facts.get(id)!.pages[0] === pageId);
  // A slide that must get its own entry (else it is asked for in the repair, and still missing fails the lesson): one
  // that poses a case or question (she should see it answered), or one with at least one fact first listed on it. A
  // recap slide whose every fact an earlier slide already listed has nothing of its own to explain: the writer may skip
  // it (an entry it does give is kept).
  const mustAppear = (p: PageRow) => {
    const n = slideNotes(p);
    if (!n || n.is_filler) return false;
    if (typeof n.case_prompt === "string" && n.case_prompt.trim()) return true;
    return factsOn(nf, p.id).some((id) => nf.facts.get(id)!.pages[0] === p.id);
  };

  type Fix = { page: (typeof pages)[number]; mode: "write" | "add" | "rewrite"; facts: number[] };
  const done = explained();
  const fixes: Fix[] = [];
  for (const p of pages) {
    const e = entries.get(p.id);
    if (!e) {
      if (mustAppear(p)) fixes.push({ page: p, mode: "write", facts: factsOn(nf, p.id) });
    } else if (copied.has(p.id)) fixes.push({ page: p, mode: "rewrite", facts: factsOn(nf, p.id) });
    else {
      const missing = missingOn(p.id, done);
      if (missing.length) fixes.push({ page: p, mode: "add", facts: missing });
    }
  }

  if (fixes.length > 0) {
    const F = (ids: number[]) => ids.map((id) => `F${id}`).join(", ");
    const todo = (f: Fix) => {
      const e = entries.get(f.page.id);
      const so = e ? `\nIts entry so far (between the lines):\n"""\n${e.text}\n"""` : "";
      if (f.mode === "write")
        return `To do: this slide got no entry. Write it${f.facts.length ? `, explaining ${F(f.facts)}` : ""}${slideNotes(f.page)?.case_prompt ? ", and answer its case from the slides" : ""}.`;
      if (f.mode === "rewrite")
        return `To do: the entry repeats the slide's sentences instead of explaining them. Write it again in your own words, explaining ${F(f.facts)}.${so}`;
      return `To do: explain ${F(f.facts)}, which the entry leaves out. Write only the new part: it is added after the entry as it is, so don't repeat what is there.${so}`;
    };
    // Re-asked once, in calls of at most five slides (almost always one call). A repair call that fails or gives
    // nothing usable for a slide leaves that slide's entry as it was.
    await inTurn(lessonParts(fixes), LESSON_PARALLEL, async (batch) => {
      try {
        const out = await generate({
          creds,
          purpose: "lesson repair",
          ref: `topic:${topic.id}`,
          schema: LessonPart,
          effort: "medium",
          maxTokens: LESSON_TOKENS_PER_SLIDE * batch.length + LESSON_TOKENS_BASE,
          system: LESSON_SYSTEM,
          content: content(
            `Some entries of this lesson need work. Return one entry for each slide below, doing only what its "To do" says.\n\n${batch
              .map((f) => `${slideNotesText([f.page], nf.ids)}\n${todo(f)}`)
              .join("\n\n")}`,
          ),
          cache,
        });
        const got = readEntries(out?.slides, batch.map((f) => f.page), nf);
        for (const f of batch) {
          const g = got.get(f.page.id);
          const had = entries.get(f.page.id);
          if (!g) continue;
          if (!had || f.mode === "write") entries.set(f.page.id, g);
          else if (f.mode === "add") entries.set(f.page.id, { text: `${had.text}\n\n${g.text}`, facts: new Set([...had.facts, ...g.facts]) });
          // A rewrite stands when it explains at least what the copy did.
          else if (g.facts.size >= had.facts.size) entries.set(f.page.id, g);
        }
      } catch (err) {
        console.error(`Lesson repair for topic ${topic.id} failed; keeping the entries as they were`, err);
      }
    });
  }

  const lesson = tidyLesson(
    {
      intro: typeof overview?.intro === "string" ? overview.intro : "",
      slides: pages.filter((p) => entries.has(p.id)).map((p) => ({ page_id: p.id, explanation: entries.get(p.id)!.text })),
      key_points: Array.isArray(overview?.key_points) ? overview.key_points.filter((k): k is string => typeof k === "string") : [],
      connections: typeof overview?.connections === "string" ? overview.connections : null,
    },
    pages,
  );
  // A lesson with a hole must never pass for a finished one: when a slide that must appear (new facts or a case) still
  // has no entry (the repair failed, or came back empty), nothing is stored. The failure marker is set by getLesson and the next
  // open she asks for tries again.
  const stored = new Set(lesson.slides.map((s) => s.page_id));
  const holes = pages.filter((p) => mustAppear(p) && !stored.has(p.id));
  if (holes.length > 0) throw new Error(`The lesson came back without ${holes.length} of its slides. Try again in a moment.`);
  // Logged only: what is still unexplained after the repair, with the old word check's share for comparison.
  const after = explained();
  const unexplained = [...nf.facts.keys()].filter((id) => !after.has(id)).length;
  const words = coveredFacts(lessonText(lesson), sectionFacts(pages)).ratio;
  if (unexplained > 0 || words < LESSON_COVERAGE)
    console.warn(`Lesson for topic ${topic.id}: ${unexplained} of ${nf.facts.size} fact(s) not marked explained; word check ${Math.round(words * 100)}%`);
  lesson.version = LESSON_VERSION;
  db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), topic.id);
  return lesson;
}

const LESSON_SYSTEM = `You are a dental school tutor writing a guided study lesson for a student who finds her lecture slides dense.
She sees each slide's picture with your explanation of it underneath, one slide after another, in lecture order. She can read the slide herself: your job is to make her understand it, not to repeat it.
A section's lesson may be written in parts of a few slides each. You get one part's slides, with each slide's facts numbered (F1, F2, …) across the section.
- Teach only from the slides given (plus the standard dental knowledge needed to connect them).
- One entry per slide, with the slide's P number and the F numbers of the facts it explains. Explain every numbered fact of a slide in that slide's entry: if a slide lists six things, explain all six. Leave out only a slide with nothing to learn: a title, outline, section divider, "questions?" or references slide, or a bare picture with no facts. A slide that asks a question or presents a case always gets an entry that answers it from the slides.
- Explain, never copy. Do not repeat a slide's sentences in the same words; quote a line only to point at it ("where it says…"). For each fact say what it means, why it is so (the mechanism or the reason behind it), and what it matters for (what she would notice or do with a patient, or what an exam would ask). Add a short example or comparison when it helps.
  Bad, a copy: "Cystatin C-based estimates for GFR are believed to be less influenced by muscle mass or diet than creatinine-based estimates."
  Good, an explanation: "Creatinine comes from muscle, so a bodybuilder, a frail elderly patient or someone who eats a lot of meat gets a misleading creatinine number. **Cystatin C** is made by every cell at a steady rate and does not change with muscle or diet, so a kidney-function estimate (**GFR**) built on it is more trustworthy in those patients."
- About 2 to 5 sentences per fact: enough to make it clear, and no more.
- Plain words first, then the term in **bold**: "the nerve and blood vessels inside the tooth — the **pulp**". Define every term the first time it appears. Short sentences, short paragraphs, one idea at a time.
- Numbers, ranges, names and classifications are given exactly as the slides give them; the words around them are yours.
- Don't cite slide numbers: the slide is right above its explanation. Point at what is on it when that helps ("the arrow", "the left radiograph").
- A slide marked ★IMPORTANT, or with annotations, is one the student marked as important in her own notes: say so in its entry ("★ you emphasized this").
- A slide that continues the one before, or something an earlier part covered, says so ("this continues…") and explains only what it adds.
- An entry ends when the slide is explained. No closing words ("Done", "End of slide", "Thanks"), no filler lines, nothing after the last fact.`;

const quizInflight = new Map<number, Promise<QuizQuestion[]>>();

/** The facts the section's slides list, the way the quiz planner sees them. */
function factSlides(pages: ReturnType<typeof topicPages>): FactSlide[] {
  return pages.map((p) => {
    const n = slideNotes(p);
    const facts = n?.key_facts ?? [];
    return { id: p.id, keyFacts: facts.length, emphasized: !!(n?.emphasized ?? p.emphasized), hasCase: !!(n?.case_prompt ?? p.has_case), facts };
  });
}

/**
 * The current quiz is up to date; older ones are rewritten once on next open. A quiz written by version 3 or 4 is
 * kept when its section has at most 25 distinct facts (and at least 5 for version 3): those versions wrote exactly one
 * question per fact there too. Only sections that were padded to 5 (repeated questions), cut at 25 (material left
 * out) or left uncapped (48 questions) are rewritten, so the rewrite costs nothing where nothing would change.
 */
export function quizIsCurrent(topic: Pick<Topic, "checks_json" | "checks_version" | "page_ids">): boolean {
  if (!topic.checks_json) return false;
  const v = topic.checks_version ?? 0;
  if (v >= QUIZ_VERSION) return true;
  if (v !== 3 && v !== 4) return false;
  const n = distinctFacts(factSlides(topicPages(topic as Topic)));
  return n <= QUIZ_MAX && (v === 4 || n >= 5);
}

/**
 * The stored quiz has to be written (again): there is none, or it is out of date and nobody has answered it. An out of
 * date quiz with answers is kept as it is: rewriting it would wipe those answers and the misses her lecture review is
 * built from. Only "Write new questions" replaces it.
 */
export function quizNeedsWriting(topic: Pick<Topic, "id" | "checks_json" | "checks_version" | "page_ids">): boolean {
  return !topic.checks_json || (!quizIsCurrent(topic) && !topicHasQuizAnswers(topic.id));
}

/** The section quiz after a lesson: written once per topic and cached, like the lesson. */
export function getSectionQuiz(topic: Topic): Promise<QuizQuestion[]> {
  if (!quizNeedsWriting(topic)) return Promise.resolve(JSON.parse(topic.checks_json!) as QuizQuestion[]);
  let p = quizInflight.get(topic.id);
  if (!p) {
    p = generateSectionQuiz(topic)
      .then((questions) => {
        clearFailure("quiz", topic.id);
        return questions;
      })
      .catch((err: unknown) => {
        markFailure("quiz", topic.id, err);
        throw err;
      })
      .finally(() => quizInflight.delete(topic.id));
    quizInflight.set(topic.id, p);
  }
  return p;
}

const QUIZ_SYSTEM = `You write end-of-section quiz questions for a dental student's guided study session, based strictly on their lecture slides.
You are given a numbered list of planned questions: each names the slide it must test, usually the exact fact it must test, and its angle. Write exactly one question for each, and set slot to its Q number and source_page_id to that slide.
- A question with a listed fact tests exactly that fact and nothing else. A question without one tests its slide from the given angle without repeating a fact another question already tests. Never ask the same fact twice in different words.
- A question with several listed facts tests them together in ONE question: a list ("which of the following is NOT…", "all of the following EXCEPT…"), a comparison, or a short vignette that can only be answered by knowing each of them; each wrong option should turn on one of those facts. Never split them into separate questions.
- Single best answer, 4 options. Exactly one option is defensibly correct from the slides.
- Use "EXCEPT"/"NOT" only when the angle says so. Don't test citations, authors, years or slide numbers.
- ${NO_COVER_RULE}
- The explanation says why the answer is right and why the most tempting wrong answer is wrong, and cites the slide as (Lecture, slide N).
- option_notes: one short sentence per option, in the same order as options — for the right one why it is right, for each wrong one exactly why it is wrong (which fact or condition it mixes up).
- ${PICTURE_RULES}

${EXAM_STYLE}`;

const JUDGE_SYSTEM = `You check quiz questions written for a dental student against their lecture slides. Be strict but fair.
For each question, n is the number the question is listed under. ok = true only if: the keyed answer is stated on the slides or directly implied by them; no other option is also correct; the question is clear; and it does not repeat an earlier question in the list (same fact asked the same way).
A question marked "picture shown: slide P" shows the student that slide's picture (the whole slide unless the notes mark a clinical-image crop): mark it ok = false if the answer is printed on that slide in a way the student would simply read off.
Also say, for every question, whether answering it needs something the student has to see (picture = true): a picture, radiograph, diagram, chart or graph, a slide referred to as such ("on slide 12", "the slide's diagram"), or anything labeled, drawn, circled, shaded or pointed at. A question with no "picture shown" that needs one will be given its slide's picture or dropped, so be honest rather than lenient.
${NO_COVER_CHECK}
${EXAM_STYLE_CHECK}`;

type Draft = Omit<QuizQuestion, "id" | "hidden" | "report_note"> & { slot: number };

/**
 * Write a topic's section quiz (QUIZ_SIZE questions):
 * 1. Plan which slide each question tests and from what angle (every slide covered when there's room; see quizPlan).
 * 2. Two AI calls of half the plan each, run together.
 * 3. Keep questions whose answer key checks out, that cite one of the topic's slides, and aren't duplicates.
 * 4. A second AI pass checks each one against the slides (QUIZ_JUDGE=0 turns it off) and drops the doubtful.
 * 5. One repair call for the slots left empty (checked the same way). If it still falls short, the quiz is shorter.
 * Replacing an older quiz detaches the answers given to it (they stay for history, summaries and mastery).
 */
async function generateSectionQuiz(topic: Topic): Promise<QuizQuestion[]> {
  const userId = examOwner(topic.exam_id);
  const creds = credentials(userId);
  const concepts = topicConcepts(topic.id, topic.exam_id);
  const pages = topicPages(topic);
  const notes = markPictures(slideNotesText(pages), pages);
  const valid = new Set(pages.map((p) => p.id));
  // One question per distinct fact on the section's slides (no floor, no cap), never the same fact twice.
  const slots = planQuizByFacts(factSlides(pages));
  const judge = process.env.QUIZ_JUDGE !== "0";
  const context = [`Section: ${topic.title}\n${topic.summary}`, `Concept names: ${concepts.map((c) => c.name).join("; ") || "none"}`, `Slides:\n${notes}`].join("\n\n");

  const write = async (wanted: number[], avoid: string[]): Promise<Draft[]> => {
    const list = wanted
      .map((i) => {
        const s = slots[i];
        const where = s.page != null ? `slide P${s.page}` : "the section";
        const tidy = (f: string) => `"${f.replace(/\s+/g, " ").replace(/"/g, "'")}"`;
        const pages = s.pages && s.pages.length > 1 ? `slides ${s.pages.map((p) => `P${p}`).join(", ")}` : where;
        const facts = s.facts.length > 1 ? ` — facts: ${s.facts.map(tidy).join("; ")} (one question that needs all of them)` : s.fact ? ` — fact: ${tidy(s.fact)}` : "";
        return `Q${i + 1}: ${pages}${facts} — ${ANGLE_TEXT[s.angle]}`;
      })
      .join("\n");
    const out = await generate({
      creds,
      purpose: "section quiz",
      ref: `topic:${topic.id}`,
      schema: SectionQuiz,
      effort: "medium",
      maxTokens: 20000,
      tier: "quality",
      system: QUIZ_SYSTEM,
      content: `${context}\n\nWrite exactly these ${wanted.length} questions:\n${list}${
        avoid.length ? `\n\nQuestions already in this quiz. Don't repeat them or ask the same fact again:\n${avoid.map((s) => `- ${s}`).join("\n")}` : ""
      }`,
    });
    // Match each answer to its planned slot (by Q number; failing that, the first open slot for the same slide).
    const open = new Set(wanted);
    const drafts: Draft[] = [];
    for (const q of out.questions) {
      const bySlot = Number.isInteger(q.slot) && open.has(q.slot - 1) ? q.slot - 1 : null;
      const slot = bySlot ?? wanted.find((i) => open.has(i) && slots[i].page === q.source_page_id) ?? wanted.find((i) => open.has(i));
      if (slot == null) break;
      open.delete(slot);
      // The shared check (lib/mcq): exactly four options, the answer text agrees with the index, and the question tests
      // one of this topic's slides (any slide works when the topic has none). Options are shuffled when the quiz is saved.
      const v = validateMcq(q, { optionCount: 4, validPageIds: valid, requireSource: true, shuffle: false });
      if (typeof v === "string") {
        console.warn(`Section quiz for topic ${topic.id}: Q${slot + 1} dropped (${v})`);
        continue;
      }
      const page = v.source_page_id;
      // A question that talks about a picture must have one to show (the slide it names, or the slide it tests).
      // "generous": a question that merely gets its slide attached loses nothing; a picture question without one is the complaint.
      const wantsPicture = q.image_page_id != null || mentionsPicture(v.stem, "generous");
      const picture = wantsPicture ? pictureFor(pages, q.image_page_id, page, v.stem) : null;
      if (wantsPicture && !picture) continue;
      drafts.push({
        slot,
        question: v.stem,
        options: v.options,
        correct_index: v.correct_index,
        explanation: q.explanation,
        // Per-option notes are kept only when there is exactly one per option; a good question isn't lost over them.
        ...(v.option_notes ? { option_notes: v.option_notes } : {}),
        concept: q.concept,
        source_page_id: page,
        image_page_id: picture?.page_id ?? null,
        kind: slots[slot].angle,
      });
    }
    return drafts;
  };

  /**
   * Drop what the checking pass rejects. The checker also says which questions need a picture: one that has none
   * (its wording slipped past mentionsPicture) gets its slide's picture, or goes. If the check itself fails, keep
   * everything rather than lose the quiz.
   */
  const check = async (drafts: Draft[]): Promise<Draft[]> => {
    if (!judge || drafts.length === 0) return drafts;
    try {
      const out = await generate({
        creds,
        purpose: "section quiz check",
        ref: `topic:${topic.id}`,
        schema: QuizCheck,
        effort: "low",
        maxTokens: 8000,
        system: JUDGE_SYSTEM,
        content: `Slides:\n${notes}\n\nQuestions:\n${drafts
          .map(
            (d) =>
              `${d.slot + 1}. ${d.question}\n${d.options.map((o, k) => `   ${String.fromCharCode(65 + k)}. ${o}`).join("\n")}\n   Keyed answer: ${String.fromCharCode(65 + d.correct_index)}${
                d.source_page_id != null ? ` (slide P${d.source_page_id})` : ""
              }${d.image_page_id != null ? ` (picture shown: slide P${d.image_page_id})` : ""}`,
          )
          .join("\n\n")}`,
      });
      // Each verdict names the question by the number it was listed under (its slot). Unless the numbers come back
      // exactly one per question sent, which verdict belongs to which question can't be trusted: all are kept unjudged.
      const verdicts = Array.isArray(out?.verdicts) ? out.verdicts : [];
      const sent = new Set(drafts.map((d) => d.slot + 1));
      const named = new Set(verdicts.map((v) => v?.n));
      if (verdicts.length !== drafts.length || named.size !== sent.size || ![...sent].every((n) => named.has(n))) {
        console.warn(`Section quiz check for topic ${topic.id}: the verdicts don't match the ${drafts.length} question(s) sent; keeping them unjudged`);
        return drafts;
      }
      const rejected = new Set(verdicts.filter((v) => v.ok === false).map((v) => v.n - 1));
      const needsPicture = new Set(verdicts.filter((v) => v.picture === true).map((v) => v.n - 1));
      const out2: Draft[] = [];
      for (const d of drafts) {
        if (rejected.has(d.slot)) continue;
        if (d.image_page_id == null && needsPicture.has(d.slot)) {
          const picture = pictureFor(pages, null, d.source_page_id, d.question);
          if (!picture) continue;
          out2.push({ ...d, image_page_id: picture.page_id });
        } else out2.push(d);
      }
      return out2;
    } catch (err) {
      console.error(`Section quiz check failed for topic ${topic.id}; keeping the questions`, err);
      return drafts;
    }
  };

  const kept = new Map<number, Draft>();
  // Questions students reported on this section (own copy or a class copy): the writer is told to steer clear of
  // them, and one that comes back anyway is dropped like a duplicate.
  const reported = reportedStems(topic.id);
  const seen = new Set<string>(reported.map(normStem).filter(Boolean));
  const keep = (drafts: Draft[]) => {
    for (const d of drafts) {
      const key = normStem(d.question);
      if (!key || seen.has(key) || kept.has(d.slot)) continue;
      seen.add(key);
      kept.set(d.slot, d);
    }
  };

  const all = slots.map((_, i) => i);
  // Two writer calls run side by side for a quiz of any size; a small one (up to 4 questions) is one call.
  const halves = all.length <= 4 ? [all] : [all.slice(0, Math.ceil(all.length / 2)), all.slice(Math.ceil(all.length / 2))];
  const settled = await Promise.allSettled(halves.map((h) => write(h, reported)));
  const first = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (first.length === 0 && settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  // Check the dedupe first so the checking pass doesn't see the same question twice.
  const firstDistinct: Draft[] = [];
  {
    const s = new Set<string>();
    for (const d of first) if (!s.has(normStem(d.question)) && (s.add(normStem(d.question)), true)) firstDistinct.push(d);
  }
  keep(await check(firstDistinct));

  // One repair call for empty slots: slides that lost their only question first, then the rest.
  const coveredPages = new Set([...kept.values()].map((d) => d.source_page_id));
  const missing = all.filter((i) => !kept.has(i)).sort((a, b) => Number(coveredPages.has(slots[a].page)) - Number(coveredPages.has(slots[b].page)) || a - b);
  if (missing.length > 0) {
    try {
      const repaired = (await write(missing, [...[...kept.values()].map((d) => d.question.slice(0, 160)), ...reported])).filter((d) => !seen.has(normStem(d.question)));
      keep(await check(repaired));
    } catch (err) {
      console.error(`Section quiz repair failed for topic ${topic.id}`, err);
    }
  }

  const questions: QuizQuestion[] = [...kept.values()]
    .sort((a, b) => a.slot - b.slot)
    .map((d) => {
      const { slot, ...q } = d;
      void slot;
      // Shuffle options so the correct answer isn't biased to one position.
      const order = shuffle(q.options.map((_, i) => i));
      return {
        id: randomUUID().slice(0, 8),
        ...q,
        options: order.map((i) => q.options[i]),
        correct_index: order.indexOf(q.correct_index),
        ...(q.option_notes ? { option_notes: order.map((i) => q.option_notes![i]) } : {}),
      };
    });
  if (questions.length === 0) throw new Error("Couldn't write the section quiz. Try again.");

  db.transaction(() => {
    // Replacing an older quiz: earlier answers point at the old positions, so detach them (rows stay for history),
    // and the per-student progress on the old questions is cleared.
    db.prepare("UPDATE session_checks SET check_index = NULL WHERE topic_id = ?").run(topic.id);
    clearTopicQuizAnswers(topic.id);
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(JSON.stringify(questions), QUIZ_VERSION, topic.id);
    // Concepts the quiz tests count toward this topic's mastery even when the AI named a new one.
    const link = db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");
    for (const name of new Set(questions.map((q) => q.concept?.trim()).filter(Boolean))) link.run(topic.id, upsertConcept(userId, name!));
  })();
  return questions;
}

const shownKey = (sessionId: number) => `session_shown:${sessionId}`;

/** A section's lesson was on screen in this study session: it counts as covered in the note written at the end. */
export function recordShown(sessionId: number, topicId: number) {
  const raw = getMeta(shownKey(sessionId));
  let ids: number[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is number => Number.isInteger(x));
  } catch {
    // a damaged record starts again
  }
  if (!ids.includes(topicId)) setMeta(shownKey(sessionId), JSON.stringify([...ids, topicId]));
}

/** "A, B and C" (a long list ends "and N more"). */
function listed(items: string[], max = 4): string {
  const shown = items.length > max ? [...items.slice(0, max - 1), `${items.length - max + 1} more`] : items;
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * End a study session with a short note to the student, built from what she did (no AI call, so it is instant and
 * free): the sections whose lesson she saw or whose quiz she answered, her section-quiz score in this session, and the
 * concepts she missed most. Ending an ended session gives the same note again. Returns the note.
 */
export function endSession(sessionId: number): string {
  const session = db.prepare("SELECT exam_id, summary, ended_at FROM study_sessions WHERE id = ?").get(sessionId) as
    | { exam_id: number; summary: string | null; ended_at: string | null }
    | undefined;
  if (!session) return "";
  if (session.ended_at && session.summary) return session.summary;

  const answers = db
    .prepare("SELECT topic_id, check_index, correct FROM session_checks WHERE session_id = ? ORDER BY id")
    .all(sessionId) as { topic_id: number; check_index: number | null; correct: number }[];
  let shown: number[] = [];
  try {
    const parsed: unknown = JSON.parse(getMeta(shownKey(sessionId)) ?? "[]");
    if (Array.isArray(parsed)) shown = parsed.filter((x): x is number => Number.isInteger(x));
  } catch {
    // nothing recorded
  }
  const covered = new Set([...shown, ...answers.map((a) => a.topic_id)]);
  const topics = (db.prepare("SELECT id, title, checks_json FROM topics WHERE exam_id = ? ORDER BY position").all(session.exam_id) as {
    id: number;
    title: string;
    checks_json: string | null;
  }[]).filter((t) => covered.has(t.id));

  // The concept of each missed question, looked up in its section's quiz (an answer to a replaced quiz has no position).
  const quizzes = new Map<number, QuizQuestion[]>();
  for (const t of topics) {
    try {
      const qs: unknown = t.checks_json ? JSON.parse(t.checks_json) : [];
      quizzes.set(t.id, Array.isArray(qs) ? (qs as QuizQuestion[]) : []);
    } catch {
      quizzes.set(t.id, []);
    }
  }
  const missed = new Map<string, number>();
  for (const a of answers) {
    if (a.correct || a.check_index == null) continue;
    const concept = quizzes.get(a.topic_id)?.[a.check_index]?.concept;
    if (typeof concept === "string" && concept.trim()) missed.set(concept.trim(), (missed.get(concept.trim()) ?? 0) + 1);
  }
  const most = [...missed].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
  const right = answers.filter((a) => a.correct).length;

  const lines: string[] = [];
  if (topics.length === 0) lines.push("You didn't open any section in this session.");
  else lines.push(`You covered ${topics.length === 1 ? "one section" : `${topics.length} sections`}: ${listed(topics.map((t) => t.title))}.`);
  if (answers.length > 0) lines.push(`You got ${right} of ${answers.length} section-quiz ${answers.length === 1 ? "question" : "questions"} right.`);
  if (most.length > 0) lines.push(`Worth another look: ${listed(most)}.`);
  const summary = lines.join(" ");
  db.transaction(() => {
    db.prepare("UPDATE study_sessions SET summary = ?, ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?").run(summary, sessionId);
    db.prepare("DELETE FROM meta WHERE key = ?").run(shownKey(sessionId));
  })();
  return summary;
}
