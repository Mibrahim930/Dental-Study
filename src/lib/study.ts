import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { db, getExam, type PageRow, type Topic } from "./db";
import { anthropic, generate, MODEL } from "./ai";
import { parseNotes } from "./processing";
import { recentSummaries, searchLibrary, topicConcepts, weakConcepts, glossaryText } from "./memory";

export const Lesson = z.object({
  explanation: z
    .string()
    .describe("Markdown teaching walkthrough of the topic, 200-450 words, clinically oriented, with **bold** key terms"),
  key_points: z.array(z.string()).describe("4-7 high-yield points to remember"),
  slides: z
    .array(z.object({ page_id: z.number(), caption: z.string() }))
    .describe("Up to 4 of the provided slides whose images are most worth looking at, with a caption saying what to notice"),
  checks: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.string()).describe("4 answer choices"),
        correct_index: z.number().describe("0-based index of the correct option"),
        explanation: z.string(),
      }),
    )
    .describe("2 quick check questions"),
  connections: z
    .string()
    .nullable()
    .describe("How this ties to material from the student's earlier exams (cite them), or null if nothing relevant"),
});
export type Lesson = z.infer<typeof Lesson>;

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
        `[P${p.id}] ${p.filename} slide ${p.page_number}: ${n.title}${n.emphasized ? " ★IMPORTANT" : ""}`,
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
  const earlier = searchLibrary(`${topic.title} ${concepts.map((c) => c.name).join(" ")}`, 5, topic.exam_id);

  const lesson = await generate({
    schema: Lesson,
    effort: "medium",
    maxTokens: 16000,
    system: `You are a dental school tutor writing one step of a guided study session.
Teach only from the student's slides provided (plus standard dental knowledge needed to connect them). Slides marked ★IMPORTANT or with annotations were emphasized by the professor: make sure they are covered.
Refer to slides as "Lecture name, slide N". Check questions should test understanding, not trivia.`,
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

/** Build the tutor's system prompt: what the AI "remembers" about this student and exam. */
function tutorSystem(examId: number, topic: Topic | undefined): string {
  const exam = getExam(examId)!;
  const topics = db.prepare("SELECT position, title FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as {
    position: number;
    title: string;
  }[];
  const weak = weakConcepts(8);
  const summaries = recentSummaries(4);
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
    `Abbreviations seen in the student's lectures: ${glossaryText()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function tutorStream(sessionId: number, examId: number, topic: Topic | undefined, question: string) {
  const history = db
    .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id")
    .all(sessionId) as { role: "user" | "assistant"; content: string }[];
  const hits = searchLibrary(question, 6);
  const retrieved = hits.length
    ? `\n\n<library_search>\n${hits
        .map((h) => `${h.exam_name} / ${h.filename} slide ${h.page_number}: ${h.title} — ${h.snippet}`)
        .join("\n")}\n</library_search>`
    : "";
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question + retrieved },
  ];
  return anthropic.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    system: tutorSystem(examId, topic),
    messages,
    output_config: { effort: "low" },
  });
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
