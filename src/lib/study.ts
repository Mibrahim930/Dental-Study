import { randomUUID } from "crypto";
import { z } from "zod";
import { db, examOwner, type Exam, type PageRow, type Topic } from "./db";
import { chatStream, generate, type ChatTurn } from "./ai";
import { credentials } from "./credentials";
import { parseNotes } from "./processing";
import { recentSummaries, searchLibrary, topicConcepts, upsertConcept, weakConcepts, glossaryText } from "./memory";
import { checkedAnswer, isValidChoice, shuffle } from "./practicePlan";
import { ANGLE_TEXT, normStem, planQuiz, type Angle } from "./quizPlan";
import { EXAM_STYLE, EXAM_STYLE_CHECK } from "./examStyle";
import { markPictures, mentionsPicture, pictureFor, PICTURE_RULES } from "./questionImage";

export const Lesson = z.object({
  explanation: z
    .string()
    .describe("Markdown teaching walkthrough of the topic, 200-450 words, clinically oriented, with **bold** key terms"),
  key_points: z
    .array(z.string())
    .describe("4-7 high-yield points to remember. Start with what slides marked ★IMPORTANT emphasize, and begin those points with \"★ \""),
  slides: z
    .array(z.object({ page_id: z.number(), caption: z.string() }))
    .describe("Up to 4 of the provided slides whose images are most worth looking at, with a caption saying what to notice"),
  connections: z
    .string()
    .nullable()
    .describe("How this ties to material from the student's earlier exams (cite them), or null if nothing relevant"),
});
export type Lesson = z.infer<typeof Lesson>;

/** Questions in a section quiz (fewer only if the AI couldn't write enough distinct, checked ones). */
export const QUIZ_SIZE = 20;
/** Stored in topics.checks_version. Quizzes written by an older version are rewritten once on next open. */
export const QUIZ_VERSION = 2;

const SectionQuiz = z.object({
  questions: z.array(
    z.object({
      slot: z.number().describe("The Q number of the planned question this answers"),
      question: z.string(),
      options: z.array(z.string()).describe("4 answer choices, no letter prefixes"),
      correct_index: z.number().describe("0-based index of the correct option"),
      correct_answer: z.string().describe("The correct option, copied exactly as written in options"),
      explanation: z.string().describe("Why it's right and why the tempting wrong answer is wrong. Cite the slide as (Lecture, slide N)"),
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
        ...n.key_facts.map((f) => `- ${f}`),
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
export function getLesson(topic: Topic): Promise<Lesson> {
  if (topic.lesson_json) return Promise.resolve(JSON.parse(topic.lesson_json) as Lesson);
  let p = inflight.get(topic.id);
  if (!p) {
    p = generateLesson(topic).finally(() => inflight.delete(topic.id));
    inflight.set(topic.id, p);
  }
  return p;
}

async function generateLesson(topic: Topic): Promise<Lesson> {
  const pages = topicPages(topic);
  const concepts = topicConcepts(topic.id, topic.exam_id);
  const userId = examOwner(topic.exam_id);
  const earlier = searchLibrary(userId, `${topic.title} ${concepts.map((c) => c.name).join(" ")}`, 5, topic.exam_id);

  const lesson = await generate({
    creds: credentials(userId),
    purpose: "lesson",
    schema: Lesson,
    effort: "medium",
    maxTokens: 16000,
    system: `You are a dental school tutor writing one step of a guided study session.
Teach only from the student's slides provided (plus standard dental knowledge needed to connect them). Slides marked ★IMPORTANT or with annotations were emphasized by the professor: make sure they are covered.
Refer to slides as "Lecture name, slide N".`,
    content: [
      `Topic: ${topic.title}\n${topic.summary}`,
      `Concepts and the student's mastery so far: ${
        concepts.map((c) => `${c.name} (${c.mastery == null ? "untested" : Math.round(c.mastery * 100) + "%"})`).join(", ") ||
        "none"
      }`,
      `Slides:\n${slideNotesText(pages)}`,
      earlier.length
        ? `Related slides from the student's earlier exams:\n${earlier
            .map((h) => `- ${h.exam_name} / ${h.filename} slide ${h.page_number}: ${h.title} — ${h.snippet}`)
            .join("\n")}`
        : "No related material from earlier exams.",
    ].join("\n\n"),
  });
  const valid = new Set(pages.map((p) => p.id));
  lesson.slides = lesson.slides.filter((s) => valid.has(s.page_id)).slice(0, 4);
  db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), topic.id);
  return lesson;
}

const quizInflight = new Map<number, Promise<QuizQuestion[]>>();

/** The current quiz is up to date (written by this version); older ones are rewritten once. */
export const quizIsCurrent = (topic: Pick<Topic, "checks_json" | "checks_version">) => !!topic.checks_json && (topic.checks_version ?? 0) >= QUIZ_VERSION;

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
You are given a numbered list of planned questions: each names the slide it must test and its angle. Write exactly one question for each, and set slot to its Q number and source_page_id to that slide.
- Single best answer, 4 options. Exactly one option is defensibly correct from the slides.
- Use "EXCEPT"/"NOT" only when the angle says so. Don't test citations, authors, years or slide numbers.
- When one slide has several planned questions, each tests a different fact or takes a clearly different angle. Never write the same question twice.
- The explanation says why the answer is right and why the most tempting wrong answer is wrong, and cites the slide as (Lecture, slide N).
- ${PICTURE_RULES}

${EXAM_STYLE}`;

const JUDGE_SYSTEM = `You check quiz questions written for a dental student against their lecture slides. Be strict but fair.
For each question, ok = true only if: the keyed answer is stated on the slides or directly implied by them; no other option is also correct; the question is clear; and it does not repeat an earlier question in the list (same fact asked the same way).
A question marked "picture shown: slide P" shows the student that slide's picture (the whole slide unless the notes mark a clinical-image crop): mark it ok = false if the answer is printed on that slide in a way the student would simply read off.
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
  const slots = planQuiz(
    pages.map((p) => {
      const n = parseNotes(p);
      return { id: p.id, keyFacts: n?.key_facts.length ?? 0, emphasized: !!(n?.emphasized ?? p.emphasized), hasCase: !!(n?.case_prompt ?? p.has_case) };
    }),
    QUIZ_SIZE,
  );
  const judge = process.env.QUIZ_JUDGE !== "0";
  const context = [`Topic: ${topic.title}\n${topic.summary}`, `Concept names: ${concepts.map((c) => c.name).join("; ") || "none"}`, `Slides:\n${notes}`].join("\n\n");

  const write = async (wanted: number[], avoid: string[]): Promise<Draft[]> => {
    const list = wanted
      .map((i) => `Q${i + 1}: ${slots[i].page != null ? `slide P${slots[i].page}` : "the topic"} — ${ANGLE_TEXT[slots[i].angle]}`)
      .join("\n");
    const out = await generate({
      creds,
      purpose: "section quiz",
      schema: SectionQuiz,
      effort: "medium",
      maxTokens: 16000,
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
      const wantsPicture = q.image_page_id != null || mentionsPicture(q.question);
      const picture = wantsPicture ? pictureFor(pages, q.image_page_id, page) : null;
      if (wantsPicture && !picture) continue;
      drafts.push({
        slot,
        question: q.question,
        options: q.options,
        correct_index: correct,
        explanation: q.explanation,
        concept: q.concept,
        source_page_id: page,
        image_page_id: picture?.page_id ?? null,
        kind: slots[slot].angle,
      });
    }
    return drafts;
  };

  /** Drop what the checking pass rejects. If the check itself fails, keep everything rather than lose the quiz. */
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
      return drafts.filter((_, i) => !rejected.has(i));
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
  const halves = [all.slice(0, Math.ceil(all.length / 2)), all.slice(Math.ceil(all.length / 2))].filter((h) => h.length);
  const settled = await Promise.allSettled(halves.map((h) => write(h, [])));
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
      return { id: randomUUID().slice(0, 8), ...q, options: order.map((i) => q.options[i]), correct_index: order.indexOf(q.correct_index) };
    });
  if (questions.length === 0) throw new Error("Couldn't write the section quiz. Try again.");

  db.transaction(() => {
    // Replacing an older quiz: earlier answers point at the old positions, so detach them (rows stay for history).
    db.prepare("UPDATE session_checks SET check_index = NULL WHERE topic_id = ?").run(topic.id);
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(JSON.stringify(questions), QUIZ_VERSION, topic.id);
    // Concepts the quiz tests count toward this topic's mastery even when the AI named a new one.
    const link = db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");
    for (const name of new Set(questions.map((q) => q.concept?.trim()).filter(Boolean))) link.run(topic.id, upsertConcept(userId, name!));
  })();
  return questions;
}

/** Build the tutor's system prompt: what the AI "remembers" about this student and exam. */
function tutorSystem(examId: number, topic: Topic | undefined): string {
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(examId) as Exam;
  const topics = db.prepare("SELECT position, title FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as {
    position: number;
    title: string;
  }[];
  const weak = weakConcepts(exam.user_id, 8);
  const summaries = recentSummaries(exam.user_id, 4);
  return [
    `You are a friendly, precise dental school tutor helping a student prepare for "${exam.name}"${
      exam.exam_date ? ` on ${exam.exam_date}` : ""
    }.
Answer from the student's own lecture slides first and cite them as (Lecture, slide N). If you add knowledge beyond the slides, say so.
Keep answers focused and short unless asked to go deeper. Use markdown. When useful, end with one quick question to check understanding.`,
    `Exam topic map:\n${topics.map((t) => `${t.position + 1}. ${t.title}`).join("\n")}`,
    topic ? `The student is currently studying: ${topic.title}\n\n${slideNotesText(topicPages(topic))}` : "",
    weak.length
      ? `Concepts the student is weak on (any exam): ${weak.map((c) => `${c.name} ${Math.round(c.mastery * 100)}%`).join(", ")}`
      : "",
    summaries.length
      ? `Notes from recent study sessions:\n${summaries.map((s) => `- [${s.exam_name}] ${s.summary}`).join("\n")}`
      : "",
    `Abbreviations seen in the student's lectures: ${glossaryText(exam.user_id)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function tutorStream(sessionId: number, examId: number, topic: Topic | undefined, question: string) {
  const userId = examOwner(examId);
  const history = db
    .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id")
    .all(sessionId) as { role: "user" | "assistant"; content: string }[];
  const hits = searchLibrary(userId, question, 6);
  const retrieved = hits.length
    ? `\n\n<library_search>\n${hits
        .map((h) => `${h.exam_name} / ${h.filename} slide ${h.page_number}: ${h.title} — ${h.snippet}`)
        .join("\n")}\n</library_search>`
    : "";
  const messages: ChatTurn[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question + retrieved },
  ];
  return chatStream({ creds: credentials(userId), purpose: "tutor chat", system: tutorSystem(examId, topic), messages });
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
