import fs from "fs";
import path from "path";
import * as mupdf from "mupdf";
import { db, FILES_DIR, type PageRow } from "./db";
import { generate, mapLimit } from "./ai";
import { buildTopicMap } from "./topics";
import { NOTES_SYSTEM, SlideNotes } from "./notes";

export type { SlideNotes };

const IMAGE_WIDTH = 1400;

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

const running = new Map<number, Promise<void>>();

/** Send each unprocessed slide to Claude for notes. Safe to call again: resumes, or joins a run in progress. */
export function processDocument(docId: number): Promise<void> {
  let p = running.get(docId);
  if (!p) {
    p = runDocument(docId).finally(() => running.delete(docId));
    running.set(docId, p);
  }
  return p;
}

async function runDocument(docId: number) {
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
