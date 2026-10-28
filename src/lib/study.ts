import { randomUUID } from "crypto";
import { z } from "zod";
import { db, examOwner, type PageRow, type Topic } from "./db";
import { generate } from "./ai";
import { credentials } from "./credentials";
import { parseNotes } from "./processing";
import { searchLibrary, topicConcepts, upsertConcept } from "./memory";
import { checkedAnswer, isValidChoice, shuffle } from "./practicePlan";
import { ANGLE_TEXT, normStem, planQuizByFacts, quizSize, type Angle, type FactSlide } from "./quizPlan";
import { coveredFacts } from "./lessonCoverage";
import { clearTopicQuizAnswers } from "./quizProgress";
import { EXAM_STYLE, EXAM_STYLE_CHECK, NO_COVER_CHECK, NO_COVER_RULE } from "./examStyle";
import { reportedStems } from "./reportedQuestions";
import { markPictures, mentionsPicture, pictureFor, PICTURE_RULES } from "./questionImage";

export const Lesson = z.object({
  intro: z.string().describe("One sentence, in plain words, saying what this section is about"),
  slides: z
    .array(
      z.object({
        page_id: z.number().describe("The slide's P number from the list"),
        explanation: z
          .string()
          .describe(
            "Markdown explanation of this one slide, shown under its picture. Covers every fact on the slide. Plain words first, then the term in **bold** (\"the nerve inside the tooth — the **pulp**\"); define each term the first time it appears; short paragraphs. As long as the slide needs; never summarise facts away. No slide citation: the slide is shown right above",
          ),
      }),
    )
    .describe(
      "The slides to learn from, one entry per slide, in the order given. Leave out only a slide with nothing to learn (title, outline, section divider, 'questions?', references, a bare picture with no facts). A slide that asks a question or presents a case is always kept, with the question answered from the slides",
    ),
  key_points: z
    .array(z.string())
    .describe("5-10 points to remember, in plain words. Start with what slides marked ★IMPORTANT emphasize, and begin those points with \"★ \""),
  connections: z
    .string()
    .nullable()
    .describe("How this ties to material from the student's earlier exams (cite them), or null if nothing relevant"),
});
/** Stored lessons carry the version of the writer that made them (missing = 1); older ones are rewritten once on next open.
 *  3 = slide by slide: every slide's picture with its own explanation under it (earlier lessons were one continuous text). */
export type Lesson = z.infer<typeof Lesson> & { version?: number };
export const LESSON_VERSION = 3;
/** All the lesson's teaching text in one string (intro, then each slide's explanation), for the coverage check and tests. */
export function lessonText(lesson: Pick<Lesson, "intro" | "slides">): string {
  return [lesson.intro ?? "", ...(lesson.slides ?? []).map((s) => s?.explanation ?? "")].filter(Boolean).join("\n\n");
}
/** Share of the slides' facts a lesson must mention; below this one repair call asks for the missing ones. */
const LESSON_COVERAGE = 0.8;

/** Stored in topics.checks_version. Quizzes written by an older version are rewritten once on next open.
 *  3 = one question per distinct fact (5-25), per-option notes, quality-tier writer.
 *  4 = one question per distinct fact with no floor and no cap (a version-3 quiz whose section has 5-25 facts was
 *      written the same way and is kept; see quizIsCurrent). */
export const QUIZ_VERSION = 4;

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
      n: z.number().describe("The question number"),
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

export function slideNotesText(pages: (PageRow & { filename: string })[]): string {
  return pages
    .map((p) => {
      const n = parseNotes(p);
      if (!n) return `[P${p.id}] ${p.filename} slide ${p.page_number}\n${p.text}`;
      return [
        `[P${p.id}] ${p.filename} slide ${p.page_number}: ${n.title}${n.emphasized ? ` ★IMPORTANT${n.emphasis_note ? ` (${n.emphasis_note})` : ""}` : ""}`,
        n.summary,
        n.image_description && `Image: ${n.image_description}`,
        // One line per fact (a fact with a line break inside could otherwise pose as a planned question in the prompt).
        ...n.key_facts.map((f) => `- ${f.replace(/\s+/g, " ").trim()}`),
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
export const lessonIsCurrent = (topic: Pick<Topic, "lesson_json">): boolean => {
  if (!topic.lesson_json) return false;
  try {
    return ((JSON.parse(topic.lesson_json) as Lesson).version ?? 1) >= LESSON_VERSION;
  } catch {
    return false;
  }
};

export function getLesson(topic: Topic): Promise<Lesson> {
  if (lessonIsCurrent(topic)) return Promise.resolve(JSON.parse(topic.lesson_json!) as Lesson);
  let p = inflight.get(topic.id);
  if (!p) {
    p = generateLesson(topic).finally(() => inflight.delete(topic.id));
    inflight.set(topic.id, p);
  }
  return p;
}

/**
 * Keep only entries for the section's own slides with real text, one per slide (a slide given twice has its texts
 * joined), in slide order. Nothing else about the writer's output is trusted blindly.
 */
function tidyLesson(raw: Lesson, pages: PageRow[]): Lesson {
  const order = new Map(pages.map((p, i) => [p.id, i]));
  const byPage = new Map<number, string>();
  for (const s of Array.isArray(raw.slides) ? raw.slides : []) {
    if (!s || !order.has(s.page_id) || typeof s.explanation !== "string" || !s.explanation.trim()) continue;
    const text = s.explanation.trim();
    byPage.set(s.page_id, byPage.has(s.page_id) ? `${byPage.get(s.page_id)}\n\n${text}` : text);
  }
  return {
    ...raw,
    intro: typeof raw.intro === "string" ? raw.intro.trim() : "",
    slides: [...byPage].sort((a, b) => order.get(a[0])! - order.get(b[0])!).map(([page_id, explanation]) => ({ page_id, explanation })),
    key_points: Array.isArray(raw.key_points) ? raw.key_points : [],
    connections: typeof raw.connections === "string" ? raw.connections : null,
  };
}

async function generateLesson(topic: Topic): Promise<Lesson> {
  const pages = topicPages(topic);
  const concepts = topicConcepts(topic.id, topic.exam_id);
  const userId = examOwner(topic.exam_id);
  const earlier = searchLibrary(userId, `${topic.title} ${concepts.map((c) => c.name).join(" ")}`, 5, topic.exam_id);

  const creds = credentials(userId);
  const content = [
    `Section: ${topic.title}\n${topic.summary}`,
    `Concepts and the student's mastery so far: ${
      concepts.map((c) => `${c.name} (${c.mastery == null ? "untested" : Math.round(c.mastery * 100) + "%"})`).join(", ") || "none"
    }`,
    `Slides (in order; every fact listed under a slide must appear in that slide's explanation):\n${slideNotesText(pages)}`,
    earlier.length
      ? `Related slides from the student's earlier exams:\n${earlier.map((h) => `- ${h.exam_name} / ${h.filename} slide ${h.page_number}: ${h.title} — ${h.snippet}`).join("\n")}`
      : "No related material from earlier exams.",
  ].join("\n\n");
  const ask = async (extra: string) =>
    tidyLesson(
      await generate({
        creds,
        purpose: extra ? "lesson repair" : "lesson",
        schema: Lesson,
        effort: "medium",
        maxTokens: 24000,
        system: LESSON_SYSTEM,
        content: extra ? `${content}\n\n${extra}` : content,
      }),
      pages,
    );

  // Every fact on every slide should be in the lesson, and every slide with facts should have its own entry. When too
  // many facts are missing or a slide with facts was left out, one repair call asks for them.
  // Each distinct fact once (slides often repeat one), so coverage isn't counted twice and a repair doesn't ask twice.
  const facts = [...new Map(pages.flatMap((p) => parseNotes(p)?.key_facts ?? []).map((f) => [normStem(f), f.trim()] as const)).entries()]
    .filter(([key, f]) => key && f)
    .map(([, f]) => f);
  // A slide that must get its own entry: one with facts, or one that poses a case or question (she should see it
  // answered). Title, agenda and reference slides never do (they don't reach a section anyway).
  const mustAppear = pages.filter((p) => {
    const n = parseNotes(p);
    // The same test as `facts` above: a "fact" with no letters or digits doesn't count.
    return !!n && !n.is_filler && ((n.key_facts ?? []).some((f) => normStem(f)) || !!n.case_prompt?.trim());
  });
  const leftOut = (l: Lesson) => mustAppear.filter((p) => !l.slides.some((s) => s.page_id === p.id));
  let lesson = await ask("");
  let cover = coveredFacts(lessonText(lesson), facts);
  let left = leftOut(lesson);
  if ((facts.length > 0 && cover.ratio < LESSON_COVERAGE) || left.length > 0) {
    try {
      const again = await ask(
        [
          "Your previous lesson left things out. Write the whole lesson again, keeping everything that was there and adding what is missing:",
          left.length
            ? `These slides have facts or a question but got no entry; add one for each:\n${left.map((p) => `- [P${p.id}] ${p.filename} slide ${p.page_number}`).join("\n")}`
            : "",
          cover.missing.length ? `These facts from the slides are missing; add each one under its slide:\n${cover.missing.map((f) => `- ${f}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const cover2 = coveredFacts(lessonText(again), facts);
      const left2 = leftOut(again);
      if (cover2.ratio >= cover.ratio && left2.length <= left.length) {
        lesson = again;
        cover = cover2;
        left = left2;
      }
    } catch (err) {
      console.error(`Lesson repair for topic ${topic.id} failed; keeping the first lesson`, err);
    }
  }
  lesson.version = LESSON_VERSION;
  db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), topic.id);
  return lesson;
}

const LESSON_SYSTEM = `You are a dental school tutor writing one section of a guided study session, for a student who finds the slides dense.
The student sees each slide's picture with your explanation of it underneath, one slide after another, in lecture order.
Teach only from the student's slides provided (plus standard dental knowledge needed to connect them).
- One entry per slide, in the order given, with the slide's P number. Explain every fact on a slide under that slide: the lesson is a complete, simpler version of the lecture, not a summary. Nothing a slide says may be left out; if a slide lists six things, explain all six. If a slide only continues the one before, say so and explain what it adds.
- Leave out only a slide with nothing to learn: a title, outline, section divider, "questions?" or references slide, or a bare picture with no facts. Always keep a slide that asks a question or presents a case, and answer it from the slides.
- Say it in plain words first, then give the term in **bold**: "the nerve and blood vessels inside the tooth — the **pulp**". Define every term the first time it appears. Short sentences, short paragraphs, one idea at a time. The intro is one sentence saying what the section is about.
- Don't cite slide numbers: the slide is right above its explanation. Point at what is on it when that helps ("the arrow", "the left radiograph").
- Slides marked ★IMPORTANT or with annotations were emphasized by the professor: say so in that slide's explanation ("★ the professor stressed this") and put them first in the key points.
- Numbers, ranges, names and classifications are given exactly as the slides give them.`;

const quizInflight = new Map<number, Promise<QuizQuestion[]>>();

/** The facts the section's slides list, the way the quiz planner sees them. */
function factSlides(pages: ReturnType<typeof topicPages>): FactSlide[] {
  return pages.map((p) => {
    const n = parseNotes(p);
    const facts = n?.key_facts ?? [];
    return { id: p.id, keyFacts: facts.length, emphasized: !!(n?.emphasized ?? p.emphasized), hasCase: !!(n?.case_prompt ?? p.has_case), facts };
  });
}

/**
 * The current quiz is up to date; older ones are rewritten once on next open. A version-3 quiz is kept when its
 * section has 5 to 25 distinct facts: version 3 wrote exactly one question per fact there too. Only sections that
 * were padded to 5 (repeated questions) or cut at 25 (material left out) are rewritten, so the rewrite costs
 * nothing where nothing would change.
 */
export function quizIsCurrent(topic: Pick<Topic, "checks_json" | "checks_version" | "page_ids">): boolean {
  if (!topic.checks_json) return false;
  const v = topic.checks_version ?? 0;
  if (v >= QUIZ_VERSION) return true;
  if (v !== 3) return false;
  const n = quizSize(factSlides(topicPages(topic as Topic)));
  return n >= 5 && n <= 25;
}

/** The section quiz after a lesson: written once per topic and cached, like the lesson. */
export function getSectionQuiz(topic: Topic): Promise<QuizQuestion[]> {
  if (quizIsCurrent(topic)) return Promise.resolve(JSON.parse(topic.checks_json!) as QuizQuestion[]);
  let p = quizInflight.get(topic.id);
  if (!p) {
    p = generateSectionQuiz(topic).finally(() => quizInflight.delete(topic.id));
    quizInflight.set(topic.id, p);
  }
  return p;
}

const QUIZ_SYSTEM = `You write end-of-section quiz questions for a dental student's guided study session, based strictly on their lecture slides.
You are given a numbered list of planned questions: each names the slide it must test, usually the exact fact it must test, and its angle. Write exactly one question for each, and set slot to its Q number and source_page_id to that slide.
- A question with a listed fact tests exactly that fact and nothing else. A question without one tests its slide from the given angle without repeating a fact another question already tests. Never ask the same fact twice in different words.
- Single best answer, 4 options. Exactly one option is defensibly correct from the slides.
- Use "EXCEPT"/"NOT" only when the angle says so. Don't test citations, authors, years or slide numbers.
- ${NO_COVER_RULE}
- The explanation says why the answer is right and why the most tempting wrong answer is wrong, and cites the slide as (Lecture, slide N).
- option_notes: one short sentence per option, in the same order as options — for the right one why it is right, for each wrong one exactly why it is wrong (which fact or condition it mixes up).
- ${PICTURE_RULES}

${EXAM_STYLE}`;

const JUDGE_SYSTEM = `You check quiz questions written for a dental student against their lecture slides. Be strict but fair.
For each question, ok = true only if: the keyed answer is stated on the slides or directly implied by them; no other option is also correct; the question is clear; and it does not repeat an earlier question in the list (same fact asked the same way).
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
        return `Q${i + 1}: ${where}${s.fact ? ` — fact: "${s.fact.replace(/\s+/g, " ").replace(/"/g, "'")}"` : ""} — ${ANGLE_TEXT[s.angle]}`;
      })
      .join("\n");
    const out = await generate({
      creds,
      purpose: "section quiz",
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
      const correct = checkedAnswer(q.options, q.correct_index, q.correct_answer);
      if (!isValidChoice(q.options, correct)) continue;
      // The question must test one of this topic's slides (any slide works when the topic has none).
      const page = valid.size === 0 ? null : valid.has(q.source_page_id) ? q.source_page_id : null;
      if (valid.size > 0 && page == null) continue;
      // A question that talks about a picture must have one to show (the slide it names, or the slide it tests).
      // "generous": a question that merely gets its slide attached loses nothing; a picture question without one is the complaint.
      const wantsPicture = q.image_page_id != null || mentionsPicture(q.question, "generous");
      const picture = wantsPicture ? pictureFor(pages, q.image_page_id, page, q.question) : null;
      if (wantsPicture && !picture) continue;
      drafts.push({
        slot,
        question: q.question,
        options: q.options,
        correct_index: correct,
        explanation: q.explanation,
        // Per-option notes are kept only when there is exactly one per option; a good question isn't lost over them.
        ...(Array.isArray(q.option_notes) && q.option_notes.length === q.options.length && q.option_notes.every((n) => typeof n === "string" && n.trim())
          ? { option_notes: q.option_notes.map((n) => n.trim()) }
          : {}),
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
        schema: QuizCheck,
        effort: "low",
        maxTokens: 8000,
        system: JUDGE_SYSTEM,
        content: `Slides:\n${notes}\n\nQuestions:\n${drafts
          .map(
            (d, i) =>
              `${i + 1}. ${d.question}\n${d.options.map((o, k) => `   ${String.fromCharCode(65 + k)}. ${o}`).join("\n")}\n   Keyed answer: ${String.fromCharCode(65 + d.correct_index)}${
                d.source_page_id != null ? ` (slide P${d.source_page_id})` : ""
              }${d.image_page_id != null ? ` (picture shown: slide P${d.image_page_id})` : ""}`,
          )
          .join("\n\n")}`,
      });
      const rejected = new Set(out.verdicts.filter((v) => v.ok === false).map((v) => v.n - 1));
      const needsPicture = new Set(out.verdicts.filter((v) => v.picture === true).map((v) => v.n - 1));
      const out2: Draft[] = [];
      for (const [i, d] of drafts.entries()) {
        if (rejected.has(i)) continue;
        if (d.image_page_id == null && needsPicture.has(i)) {
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
  const seen = new Set<string>();
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
  // Questions students reported on this section (own copy or a class copy) are named so the writer steers clear of them.
  const reported = reportedStems(topic.id);
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
      const repaired = (await write(missing, [...kept.values()].map((d) => d.question.slice(0, 160)))).filter((d) => !seen.has(normStem(d.question)));
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

const SessionSummary = z.object({
  summary: z.string().describe("2-4 short sentences: what was covered, what the student struggled with, what to do next"),
});

export async function summarizeSession(sessionId: number) {
  const session = db.prepare("SELECT * FROM study_sessions WHERE id = ?").get(sessionId) as {
    exam_id: number;
    current_position: number;
  };
  const checks = db
    .prepare(
      "SELECT t.title, sc.question, sc.correct FROM session_checks sc JOIN topics t ON t.id = sc.topic_id WHERE sc.session_id = ?",
    )
    .all(sessionId) as { title: string; question: string; correct: number }[];
  const questions = db
    .prepare("SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id")
    .all(sessionId) as { content: string }[];
  const topics = db
    .prepare("SELECT position, title FROM topics WHERE exam_id = ? ORDER BY position")
    .all(session.exam_id) as { position: number; title: string }[];

  let summary = "Session ended with no activity.";
  if (checks.length || questions.length) {
    const out = await generate({
      creds: credentials(examOwner(session.exam_id)),
      purpose: "session summary",
      schema: SessionSummary,
      effort: "low",
      maxTokens: 4000,
      system: "Summarize a dental student's study session as a note their tutor will read before the next session.",
      content: [
        `Topics in this exam: ${topics.map((t) => `${t.position + 1}. ${t.title}`).join("; ")}`,
        `Student stopped at topic ${session.current_position + 1}.`,
        `Quick-check results:\n${checks.map((c) => `- [${c.title}] ${c.correct ? "✓" : "✗"} ${c.question}`).join("\n") || "none"}`,
        `Questions the student asked the tutor:\n${questions.map((q) => `- ${q.content}`).join("\n") || "none"}`,
      ].join("\n\n"),
    });
    summary = out.summary;
  }
  db.prepare("UPDATE study_sessions SET summary = ?, ended_at = datetime('now') WHERE id = ?").run(summary, sessionId);
}
