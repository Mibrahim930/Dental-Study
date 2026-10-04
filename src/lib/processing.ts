import fs from "fs";
import path from "path";
import * as mupdf from "mupdf";
import { z } from "zod";
import { db, FILES_DIR, type PageRow } from "./db";
import { generate, mapLimit } from "./ai";
import { buildTopicMap } from "./topics";

const IMAGE_WIDTH = 1400;

export const SlideNotes = z.object({
  title: z.string().describe("Short title for the slide"),
  summary: z.string().describe("1-2 sentence plain-language summary of what this slide teaches"),
  image_description: z
    .string()
    .nullable()
    .describe("What the radiographs / photos / histology / diagrams show and what to notice. null if no meaningful image"),
  key_facts: z.array(z.string()).describe("Testable facts from this slide, each one self-contained"),
  annotations: z
    .array(z.string())
    .describe("Notes the student or professor added on top of the slide: typed notes, handwriting, circled/highlighted text. Transcribe them"),
  emphasized: z
    .boolean()
    .describe("True if the slide or its annotations flag this as important/high-yield/'will be on the exam'"),
  case_prompt: z
    .string()
    .nullable()
    .describe("If the slide presents a patient case or image and asks for diagnosis/treatment, the question it asks. Otherwise null"),
  case_answer: z.string().nullable().describe("The answer to case_prompt if shown on the slide, spelled out. Otherwise null"),
  case_image_box: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable()
    .describe(
      "When case_prompt is set: the region (fractions 0-1 of slide width/height, origin top-left) that contains ONLY the clinical images (radiographs/photos), excluding the question text and any label that reveals the answer. Otherwise null",
    ),
  abbreviations: z.array(z.object({ abbr: z.string(), meaning: z.string() })),
  concepts: z.array(z.string()).describe("2-5 short canonical dental concept names this slide covers"),
  is_filler: z.boolean().describe("True for title, agenda, objectives-only, references, or thank-you slides"),
});
export type SlideNotes = z.infer<typeof SlideNotes>;

const NOTES_SYSTEM = `You are turning a dental school lecture slide into study notes for a dental student.
You get the rendered slide image plus the slide's extracted text layer.
Much of the meaning is in the images (radiographs, clinical photos, histology) and in small labels such as diagnosis abbreviations, so read the image carefully.
The PDF may contain the student's own annotations (typed notes at the top of the slide or handwriting on it); transcribe them into "annotations".
Spell out dental abbreviations (e.g. SIP = symptomatic irreversible pulpitis, PN = pulp necrosis, AAA = acute apical abscess) using standard AAE terminology.
Stay faithful to the slide. Do not add facts that are not on the slide or directly implied by it.`;

/** Save an uploaded PDF, render every page to an image, then process slides in the background. */
export async function addDocument(examId: number, filename: string, bytes: Buffer): Promise<number> {
  const info = db
    .prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, ?, 'processing')")
    .run(examId, filename);
  const docId = Number(info.lastInsertRowid);
  const dir = path.join(FILES_DIR, `doc-${docId}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "original.pdf"), bytes);

  try {
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const count = doc.countPages();
    const insert = db.prepare(
      "INSERT INTO pages (document_id, page_number, text, image_path, aspect) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      const scale = IMAGE_WIDTH / (x1 - x0);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      const rel = path.join(`doc-${docId}`, `p${i + 1}.jpg`);
      fs.writeFileSync(path.join(FILES_DIR, rel), pix.asJPEG(80));
      const text = page.toStructuredText("preserve-whitespace").asText().trim();
      insert.run(docId, i + 1, text, rel, (x1 - x0) / (y1 - y0));
    }
    db.prepare("UPDATE documents SET page_count = ? WHERE id = ?").run(count, docId);
  } catch (err) {
    db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run(String(err), docId);
    throw err;
  }

  void processDocument(docId);
  return docId;
}

const running = new Set<number>();

/** Send each unprocessed slide to Claude for notes. Safe to call again to resume. */
export async function processDocument(docId: number) {
  if (running.has(docId)) return;
  running.add(docId);
  try {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as
      | { filename: string; exam_id: number }
      | undefined;
    if (!doc) return;
    db.prepare("UPDATE documents SET status = 'processing', error = NULL WHERE id = ?").run(docId);
    const pages = db
      .prepare("SELECT * FROM pages WHERE document_id = ? AND status != 'done' ORDER BY page_number")
      .all(docId) as PageRow[];

    await mapLimit(pages, 4, async (page) => {
      try {
        const notes = await noteSlide(doc.filename, page);
        savePageNotes(page, notes);
      } catch (err) {
        db.prepare("UPDATE pages SET status = 'error', error = ? WHERE id = ?").run(String(err), page.id);
      }
    });

    const failed = db
      .prepare("SELECT COUNT(*) n FROM pages WHERE document_id = ? AND status != 'done'")
      .get(docId) as { n: number };
    if (failed.n > 0) {
      db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run(
        `${failed.n} slide(s) could not be processed. Use "Retry" to try them again.`,
        docId,
      );
      return;
    }
    db.prepare("UPDATE documents SET status = 'done' WHERE id = ?").run(docId);

    // When the last lecture for this exam finishes, (re)build the topic map automatically.
    const pending = db
      .prepare("SELECT COUNT(*) n FROM documents WHERE exam_id = ? AND status IN ('pending','processing')")
      .get(doc.exam_id) as { n: number };
    if (pending.n === 0) void buildTopicMap(doc.exam_id);
  } finally {
    running.delete(docId);
  }
}

async function noteSlide(lecture: string, page: PageRow): Promise<SlideNotes> {
  const image = fs.readFileSync(path.join(FILES_DIR, page.image_path)).toString("base64");
  return generate({
    schema: SlideNotes,
    system: NOTES_SYSTEM,
    effort: "low",
    maxTokens: 8000,
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      {
        type: "text",
        text: `Lecture: ${lecture}\nSlide ${page.page_number}\n\nExtracted text layer:\n${page.text || "(none)"}`,
      },
    ],
  });
}

function savePageNotes(page: PageRow, notes: SlideNotes) {
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE pages SET status = 'done', error = NULL, title = ?, notes_json = ?, emphasized = ?, has_case = ? WHERE id = ?",
    ).run(notes.title, JSON.stringify(notes), notes.emphasized ? 1 : 0, notes.case_prompt ? 1 : 0, page.id);
    db.prepare("DELETE FROM pages_fts WHERE page_id = ?").run(page.id);
    db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)").run(
      page.id,
      notes.title,
      [notes.summary, notes.image_description, ...notes.key_facts, ...notes.annotations, notes.case_prompt, notes.case_answer, page.text]
        .filter(Boolean)
        .join("\n"),
    );
    const gloss = db.prepare("INSERT OR IGNORE INTO glossary (abbr, meaning) VALUES (?, ?)");
    for (const a of notes.abbreviations) gloss.run(a.abbr.trim(), a.meaning.trim());
  });
  tx();
}

/** On server start, resume any lecture that was mid-processing when the app stopped. */
export function resumeUnfinished() {
  const docs = db.prepare("SELECT id FROM documents WHERE status = 'processing'").all() as { id: number }[];
  for (const d of docs) void processDocument(d.id);
  db.prepare("UPDATE exams SET topic_status = 'none' WHERE topic_status = 'building'").run();
}

export function parseNotes(page: Pick<PageRow, "notes_json">): SlideNotes | null {
  return page.notes_json ? (JSON.parse(page.notes_json) as SlideNotes) : null;
}
