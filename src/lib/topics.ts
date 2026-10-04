import { z } from "zod";
import { db, type PageRow } from "./db";
import { generate } from "./ai";
import { parseNotes } from "./processing";
import { upsertConcept } from "./memory";

const TopicMap = z.object({
  topics: z.array(
    z.object({
      title: z.string(),
      summary: z.string().describe("2-3 sentences: what this topic covers and why it matters clinically"),
      page_ids: z.array(z.number()).describe("IDs of the slides (the P numbers) that belong to this topic"),
      emphasized: z.boolean().describe("True if the professor/student flagged slides in this topic as important"),
      concepts: z.array(z.string()).describe("3-8 canonical concept names covered by this topic"),
    }),
  ),
});

const SYSTEM = `You organize a dental student's lecture slides for one exam into a topic map they will study in order.
Rules:
- Group slides into coherent topics (typically 5-15 slides each). Topics may combine slides from different lectures when they teach the same thing.
- Order topics for learning: foundations (biology, microbiology, anatomy) before pathology/diagnosis, before treatment, before prognosis.
- Every slide ID listed must appear in exactly one topic. Skip none.
- Concepts are short canonical names (e.g. "Symptomatic irreversible pulpitis", "Cvek pulpotomy", "Inferior alveolar nerve block").
  The student already has a concept list from earlier exams. When a concept means the same thing as an existing one, reuse the existing name exactly.`;

type PageForMap = PageRow & { filename: string };

export async function buildTopicMap(examId: number) {
  db.prepare("UPDATE exams SET topic_status = 'building', topic_error = NULL WHERE id = ?").run(examId);
  try {
    const pages = db
      .prepare(
        `SELECT p.*, d.filename FROM pages p JOIN documents d ON d.id = p.document_id
         WHERE d.exam_id = ? AND p.status = 'done' ORDER BY d.id, p.page_number`,
      )
      .all(examId) as PageForMap[];
    if (pages.length === 0) throw new Error("No processed slides yet.");

    const lines: string[] = [];
    let lecture = "";
    for (const p of pages) {
      const n = parseNotes(p);
      if (!n || n.is_filler) continue;
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
    const existing = (db.prepare("SELECT name FROM concepts ORDER BY name").all() as { name: string }[]).map(
      (c) => c.name,
    );

    const map = await generate({
      schema: TopicMap,
      system: SYSTEM,
      effort: "medium",
      maxTokens: 64000,
      content:
        `Existing concepts from earlier exams (${existing.length}):\n${existing.join("\n") || "(none yet)"}\n\n` +
        `Slides for this exam (IDs in brackets):\n${lines.join("\n")}`,
    });

    const validIds = new Set(pages.map((p) => p.id));
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM topics WHERE exam_id = ?").run(examId);
      const insertTopic = db.prepare(
        "INSERT INTO topics (exam_id, position, title, summary, page_ids, emphasized) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const link = db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");
      let position = 0;
      map.topics.forEach((t) => {
        const ids = t.page_ids.filter((id) => validIds.has(id));
        if (ids.length === 0) return;
        const topicId = Number(
          insertTopic.run(examId, position++, t.title, t.summary, JSON.stringify(ids), t.emphasized ? 1 : 0).lastInsertRowid,
        );
        for (const name of t.concepts) link.run(topicId, upsertConcept(name));
      });
      db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(examId);
    });
    tx();
  } catch (err) {
    db.prepare("UPDATE exams SET topic_status = 'error', topic_error = ? WHERE id = ?").run(String(err), examId);
  }
}
