import { z } from "zod";
import { db, examOwner, resetSectionQuiz, type PageRow } from "./db";
import { credentials } from "./credentials";
import { rebuildPlan } from "./planner";
import { generate } from "./ai";
import { parseNotes } from "./processing";
import { upsertConcept } from "./memory";
import { cleanTopics, matchTopics, placeNewTopics, sameSlides, type SlideRef } from "./topicMerge";

const TopicFields = {
  title: z.string(),
  summary: z.string().describe("2-3 sentences: what this topic covers and why it matters clinically"),
  page_ids: z.array(z.number()).describe("IDs of the slides (the P numbers) that belong to this topic"),
  emphasized: z.boolean().describe("True if the professor/student flagged slides in this topic as important"),
  concepts: z.array(z.string()).describe("3-8 canonical concept names covered by this topic"),
};

const TopicMap = z.object({ topics: z.array(z.object(TopicFields)) });

const NewTopics = z.object({
  topics: z.array(
    z.object({
      ...TopicFields,
      after_topic: z.number().describe("Number of the existing topic this new topic should come right after in study order; 0 = before topic 1"),
    }),
  ),
});

const RULES = `- Group slides into coherent topics (typically 5-15 slides each). Topics may combine slides from different lectures when they teach the same thing.
- Order topics for learning: foundations (biology, microbiology, anatomy) before pathology/diagnosis, before treatment, before prognosis.
- Every slide ID listed must appear in exactly one topic. Skip none.
- Concepts are short canonical names (e.g. "Symptomatic irreversible pulpitis", "Cvek pulpotomy", "Inferior alveolar nerve block").
  The student already has a concept list from earlier exams. When a concept means the same thing as an existing one, reuse the existing name exactly.`;

const SYSTEM = `You organize a dental student's lecture slides for one exam into a topic map they will study in order.
Rules:
${RULES}`;

const ADD_SYSTEM = `You add newly uploaded lecture slides to a dental student's existing topic map for one exam.
The existing topics stay exactly as they are (the student has already studied some of them). Put ONLY the new slides into NEW topics, and say where each new topic belongs in study order (after_topic).
Rules:
${RULES}`;

type PageForMap = PageRow & { filename: string };
type Mode = "auto" | "full";

const inflight = new Map<number, { p: Promise<void>; mode: Mode }>();

/**
 * Build or update an exam's topic map. Concurrent calls for the same exam share one run.
 * - "auto" (after lectures finish processing): with a map already there, existing topics are kept untouched and only
 *   slides not yet in any topic are organised into new topics. With no map yet, a full map is built.
 * - "full" (the Rebuild button): the AI re-maps every slide, but topics whose slides mostly match an old topic keep
 *   that topic (and its lesson, quiz, answers and study progress).
 */
export function buildTopicMap(examId: number, mode: Mode = "auto"): Promise<void> {
  const running = inflight.get(examId);
  // Same or weaker request while one runs: share it. A Rebuild asked during an automatic run runs right after it.
  if (running && (running.mode === "full" || mode === "auto")) return running.p;
  const p: Promise<void> = (running ? running.p.catch(() => {}) : Promise.resolve())
    .then(() => runTopicMap(examId, mode))
    .finally(() => {
      if (inflight.get(examId)?.p === p) inflight.delete(examId);
    });
  inflight.set(examId, { p, mode });
  return p;
}

type Existing = { id: number; position: number; title: string; summary: string; page_ids: string; emphasized: number };

async function runTopicMap(examId: number, mode: Mode) {
  db.prepare("UPDATE exams SET topic_status = 'building', topic_error = NULL WHERE id = ?").run(examId);
  try {
    const pages = db
      .prepare(
        `SELECT p.*, d.filename FROM pages p JOIN documents d ON d.id = p.document_id
         WHERE d.exam_id = ? AND p.status = 'done' ORDER BY d.id, p.page_number`,
      )
      .all(examId) as PageForMap[];
    if (pages.length === 0) throw new Error("No processed slides yet.");
    // Title, agenda and reference slides stay out of the study plan; everything else must land in a topic.
    const content = pages.filter((p) => {
      const n = parseNotes(p);
      return n && !n.is_filler;
    });
    const existing = db.prepare("SELECT id, position, title, summary, page_ids, emphasized FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Existing[];
    const userId = examOwner(examId);

    if (mode === "auto" && existing.length > 0) {
      const assigned = new Set(existing.flatMap((t) => JSON.parse(t.page_ids) as number[]));
      const fresh = content.filter((p) => !assigned.has(p.id));
      if (fresh.length > 0) await addTopics(examId, userId, existing, fresh);
    } else {
      await fullMap(examId, userId, existing, content);
    }
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(examId);
    rebuildPlan(userId); // new topics → new study tasks
  } catch (err) {
    db.prepare("UPDATE exams SET topic_status = 'error', topic_error = ? WHERE id = ?").run(String(err), examId);
  }
}

function slideLines(pages: PageForMap[]): string {
  const lines: string[] = [];
  let lecture = "";
  for (const p of pages) {
    const n = parseNotes(p)!;
    if (p.filename !== lecture) {
      lecture = p.filename;
      lines.push(`\n## Lecture: ${lecture}`);
    }
    lines.push(
      `[P${p.id}] slide ${p.page_number}: ${n.title}${n.emphasized ? " ★IMPORTANT" : ""} — ${n.summary}` +
        (n.case_prompt ? ` | case: ${n.case_prompt}` : "") +
        ` | concepts: ${n.concepts.join("; ")}`,
    );
  }
  return lines.join("\n");
}

const refs = (pages: PageForMap[]): SlideRef[] => pages.map((p) => ({ id: p.id, doc: p.document_id, n: p.page_number }));
const existingConcepts = (userId: number) =>
  (db.prepare("SELECT name FROM concepts WHERE user_id = ? ORDER BY name").all(userId) as { name: string }[]).map((c) => c.name);

/** Re-file practice questions without a topic (or whose topic is gone) under the topic that now holds their source slide. */
function refileQuestions(examId: number) {
  const topics = db.prepare("SELECT id, page_ids FROM topics WHERE exam_id = ?").all(examId) as { id: number; page_ids: string }[];
  const set = db.prepare("UPDATE questions SET topic_id = ? WHERE exam_id = ? AND topic_id IS NULL AND source_page_id = ?");
  for (const t of topics) for (const p of JSON.parse(t.page_ids) as number[]) set.run(t.id, examId, p);
}

/** New lectures on an existing map: only the new slides are organised, into new topics placed in study order. */
async function addTopics(examId: number, userId: number, existing: Existing[], fresh: PageForMap[]) {
  const out = await generate({
    creds: credentials(userId),
    purpose: "topic map",
    schema: NewTopics,
    system: ADD_SYSTEM,
    effort: "medium",
    maxTokens: 64000,
    content:
      `Existing concepts from earlier exams:\n${existingConcepts(userId).join("\n") || "(none yet)"}\n\n` +
      `Existing topics of this exam, in study order (keep them; do not list them):\n${existing.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}\n\n` +
      `New slides to organise (IDs in brackets):\n${slideLines(fresh)}`,
  });
  let topics = cleanTopics(out.topics, refs(fresh));
  if (topics.length === 0) {
    // The AI placed nothing usable: one topic per new lecture, so no slide is lost.
    const byDoc = new Map<number, PageForMap[]>();
    for (const p of fresh) byDoc.set(p.document_id, [...(byDoc.get(p.document_id) ?? []), p]);
    topics = [...byDoc.values()].map((ps) => ({
      title: ps[0].filename.replace(/\.pdf$/i, ""),
      summary: `Slides from ${ps[0].filename}.`,
      page_ids: ps.map((p) => p.id),
      emphasized: ps.some((p) => p.emphasized),
      concepts: [],
      after_topic: existing.length,
    }));
  }

  db.transaction(() => {
    const insert = db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, emphasized) VALUES (?, ?, ?, ?, ?, ?)");
    const link = db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");
    const order = placeNewTopics(
      existing.map((t) => t.id),
      topics.map((t) => ({ topic: t, after: t.after_topic })),
    );
    const setPos = db.prepare("UPDATE topics SET position = ? WHERE id = ?");
    // Positions are unique per exam in practice; move old topics out of the way first.
    existing.forEach((t) => setPos.run(-1 - t.position, t.id));
    order.forEach((o, position) => {
      if ("old" in o) return setPos.run(position, o.old);
      const t = o.fresh;
      const id = Number(insert.run(examId, position, t.title, t.summary, JSON.stringify(t.page_ids), t.emphasized ? 1 : 0).lastInsertRowid);
      for (const name of t.concepts) if (name.trim()) link.run(id, upsertConcept(userId, name));
    });
    refileQuestions(examId);
  })();
}

/** Map every slide again, keeping each old topic that a new topic mostly matches. */
async function fullMap(examId: number, userId: number, existing: Existing[], content: PageForMap[]) {
  if (content.length === 0) throw new Error("No slides with study content yet.");
  const map = await generate({
    creds: credentials(userId),
    purpose: "topic map",
    schema: TopicMap,
    system: SYSTEM,
    effort: "medium",
    maxTokens: 64000,
    content:
      `Existing concepts from earlier exams (${existingConcepts(userId).length}):\n${existingConcepts(userId).join("\n") || "(none yet)"}\n\n` +
      `Slides for this exam (IDs in brackets):\n${slideLines(content)}`,
  });
  const topics = cleanTopics(map.topics, refs(content));
  if (topics.length === 0) throw new Error("The topic map came back empty. Try Rebuild again.");
  const old = existing.map((t) => ({ ...t, pages: JSON.parse(t.page_ids) as number[] }));
  const matched = matchTopics(
    old.map((t) => ({ id: t.id, page_ids: t.pages })),
    topics,
  );

  db.transaction(() => {
    const keep = new Set(matched.values());
    // Topics that no longer exist: their questions are re-filed by source slide below; the rows go.
    for (const t of old) {
      if (keep.has(t.id)) continue;
      db.prepare("UPDATE questions SET topic_id = NULL WHERE topic_id = ?").run(t.id);
      db.prepare("DELETE FROM topics WHERE id = ?").run(t.id);
    }
    // Free up positions before renumbering.
    for (const id of keep) db.prepare("UPDATE topics SET position = -1 - position WHERE id = ?").run(id);
    const insert = db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, emphasized) VALUES (?, ?, ?, ?, ?, ?)");
    const link = db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");
    topics.forEach((t, position) => {
      const oldId = matched.get(position);
      let id: number;
      if (oldId != null) {
        const before = old.find((o) => o.id === oldId)!;
        id = oldId;
        if (sameSlides(before.pages, t.page_ids)) {
          // Unchanged: keep its name, lesson and quiz; only the place in the order may move.
          db.prepare("UPDATE topics SET position = ?, emphasized = ? WHERE id = ?").run(position, t.emphasized || before.emphasized ? 1 : 0, id);
        } else {
          // Same topic, slides changed: the lesson and quiz are rewritten from the new slides. Answers and progress stay.
          db.prepare("UPDATE topics SET position = ?, title = ?, summary = ?, page_ids = ?, emphasized = ?, lesson_json = NULL WHERE id = ?").run(
            position,
            t.title,
            t.summary,
            JSON.stringify(t.page_ids),
            t.emphasized ? 1 : 0,
            id,
          );
          resetSectionQuiz(id);
        }
      } else {
        id = Number(insert.run(examId, position, t.title, t.summary, JSON.stringify(t.page_ids), t.emphasized ? 1 : 0).lastInsertRowid);
      }
      for (const name of t.concepts) if (name.trim()) link.run(id, upsertConcept(userId, name));
    });
    // Questions whose source slide moved to a different topic follow it.
    const owner = new Map<number, number>();
    (db.prepare("SELECT id, page_ids FROM topics WHERE exam_id = ?").all(examId) as { id: number; page_ids: string }[]).forEach((t) =>
      (JSON.parse(t.page_ids) as number[]).forEach((p) => owner.set(p, t.id)),
    );
    const move = db.prepare("UPDATE questions SET topic_id = ? WHERE id = ?");
    for (const q of db.prepare("SELECT id, topic_id, source_page_id FROM questions WHERE exam_id = ? AND source_page_id IS NOT NULL").all(examId) as {
      id: number;
      topic_id: number | null;
      source_page_id: number;
    }[]) {
      const t = owner.get(q.source_page_id);
      if (t != null && t !== q.topic_id) move.run(t, q.id);
    }
    refileQuestions(examId);
    const count = topics.length;
    db.prepare("UPDATE study_sessions SET current_position = MIN(current_position, ?) WHERE exam_id = ?").run(Math.max(0, count - 1), examId);
  })();
}
