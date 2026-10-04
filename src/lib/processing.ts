import fs from "fs";
import path from "path";
import { db, FILES_DIR, type PageRow } from "./db";
import { batchResults, createBatch, generate, mapLimit } from "./ai";
import { credentials, type Credentials } from "./credentials";
import { buildTopicMap } from "./topics";
import { NOTES_SYSTEM, SlideNotes } from "./notes";
import { openPdf, renderPage } from "./pdf";

export type { SlideNotes };

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
    const doc = openPdf(bytes);
    const count = doc.countPages();
    const insert = db.prepare(
      "INSERT INTO pages (document_id, page_number, text, image_path, aspect) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < count; i++) {
      const { jpeg, text, aspect } = renderPage(doc, i);
      const rel = path.join(`doc-${docId}`, `p${i + 1}.jpg`);
      fs.writeFileSync(path.join(FILES_DIR, rel), jpeg);
      insert.run(docId, i + 1, text, rel, aspect);
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

/**
 * Read every unprocessed slide of a lecture. Safe to call again: resumes, or joins a run in progress.
 * Claude users go through the Batch API (half price, finishes within minutes to an hour; see pollBatches).
 * ChatGPT users are processed slide by slide.
 */
export function processDocument(docId: number): Promise<void> {
  let p = running.get(docId);
  if (!p) {
    p = runDocument(docId).finally(() => running.delete(docId));
    running.set(docId, p);
  }
  return p;
}

type DocInfo = { id: number; filename: string; exam_id: number; batch_id: string | null; user_id: number | null };

function docInfo(docId: number): DocInfo | undefined {
  return db
    .prepare("SELECT d.id, d.filename, d.exam_id, d.batch_id, e.user_id FROM documents d JOIN exams e ON e.id = d.exam_id WHERE d.id = ?")
    .get(docId) as DocInfo | undefined;
}

function pendingPages(docId: number): PageRow[] {
  return db.prepare("SELECT * FROM pages WHERE document_id = ? AND status != 'done' ORDER BY page_number").all(docId) as PageRow[];
}

function failDoc(docId: number, error: string) {
  db.prepare("UPDATE documents SET status = 'error', error = ?, batch_id = NULL WHERE id = ?").run(error, docId);
}

async function runDocument(docId: number) {
  const doc = docInfo(docId);
  if (!doc) return;
  if (!doc.user_id) return failDoc(docId, "This lecture has no owner yet. Sign in to claim it.");
  let creds: Credentials;
  try {
    creds = credentials(doc.user_id);
  } catch (err) {
    return failDoc(docId, String(err instanceof Error ? err.message : err));
  }
  db.prepare("UPDATE documents SET status = 'processing', error = NULL WHERE id = ?").run(docId);
  if (doc.batch_id) return; // a batch is already running; pollBatches() will finish it

  const pages = pendingPages(docId);
  if (creds.provider === "anthropic" && pages.length > 3) {
    try {
      const batchId = await createBatch(
        creds,
        SlideNotes,
        pages.map((p) => ({ customId: String(p.id), ...slideRequest(doc.filename, p) })),
      );
      db.prepare("UPDATE documents SET batch_id = ? WHERE id = ?").run(batchId, docId);
      return;
    } catch (err) {
      console.error(`Batch create failed for document ${docId}; processing directly`, err);
    }
  }
  await processDirectly(creds, doc, pages);
  finishDocument(doc);
}

async function processDirectly(creds: Credentials, doc: DocInfo, pages: PageRow[]) {
  await mapLimit(pages, 4, async (page) => {
    try {
      const req = slideRequest(doc.filename, page);
      const notes = await generate({ creds, purpose: "read slides", schema: SlideNotes, ...req });
      savePageNotes(creds.userId, page, notes);
    } catch (err) {
      db.prepare("UPDATE pages SET status = 'error', error = ? WHERE id = ?").run(String(err), page.id);
    }
  });
}

function finishDocument(doc: DocInfo) {
  const failed = (db.prepare("SELECT COUNT(*) n FROM pages WHERE document_id = ? AND status != 'done'").get(doc.id) as { n: number }).n;
  if (failed > 0) return failDoc(doc.id, `${failed} slide(s) could not be processed. Use "Retry" to try them again.`);
  db.prepare("UPDATE documents SET status = 'done', batch_id = NULL WHERE id = ?").run(doc.id);

  // When the last lecture for this exam finishes, (re)build the topic map automatically.
  const pending = db
    .prepare("SELECT COUNT(*) n FROM documents WHERE exam_id = ? AND status IN ('pending','processing')")
    .get(doc.exam_id) as { n: number };
  if (pending.n === 0) void buildTopicMap(doc.exam_id);
}

let polling = false;

/** Check running slide batches; save finished results. Called every minute from instrumentation.ts. */
export async function pollBatches() {
  if (polling) return;
  polling = true;
  try {
    const docs = db.prepare("SELECT id FROM documents WHERE batch_id IS NOT NULL AND status = 'processing'").all() as { id: number }[];
    for (const { id } of docs) {
      const doc = docInfo(id);
      if (!doc?.batch_id || !doc.user_id) continue;
      try {
        const creds = credentials(doc.user_id);
        const results = await batchResults(creds, "read slides (batch)", SlideNotes, doc.batch_id);
        if (!results) continue; // still running
        const byId = new Map(pendingPages(id).map((p) => [String(p.id), p]));
        for (const r of results) {
          const page = byId.get(r.customId);
          if (page && r.ok) savePageNotes(creds.userId, page, r.value);
        }
        db.prepare("UPDATE documents SET batch_id = NULL WHERE id = ?").run(id);
        // Anything the batch couldn't do gets one direct retry.
        const leftover = pendingPages(id);
        if (leftover.length) await processDirectly(creds, doc, leftover);
        finishDocument(doc);
      } catch (err) {
        console.error(`Polling batch for document ${id} failed`, err);
      }
    }
  } finally {
    polling = false;
  }
}

function slideRequest(lecture: string, page: PageRow) {
  const image = fs.readFileSync(path.join(FILES_DIR, page.image_path)).toString("base64");
  return {
    system: NOTES_SYSTEM,
    effort: "low" as const,
    maxTokens: 8000,
    content: [
      { type: "image" as const, base64: image },
      { type: "text" as const, text: `Lecture: ${lecture}\nSlide ${page.page_number}\n\nExtracted text layer:\n${page.text || "(none)"}` },
    ],
  };
}

function savePageNotes(userId: number, page: PageRow, notes: SlideNotes) {
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
    const gloss = db.prepare("INSERT OR IGNORE INTO glossary (user_id, abbr, meaning) VALUES (?, ?, ?)");
    for (const a of notes.abbreviations) gloss.run(userId, a.abbr.trim(), a.meaning.trim());
  });
  tx();
}

/** Resume lectures that were mid-processing when the app stopped (optionally only one user's). */
export function resumeUnfinished(userId?: number) {
  const docs = db
    .prepare(
      `SELECT d.id FROM documents d JOIN exams e ON e.id = d.exam_id
       WHERE d.status IN ('processing','error') AND d.batch_id IS NULL ${userId ? "AND e.user_id = ?" : "AND d.status = 'processing'"}`,
    )
    .all(...(userId ? [userId] : [])) as { id: number }[];
  for (const d of docs) void processDocument(d.id);
  if (!userId) db.prepare("UPDATE exams SET topic_status = 'none' WHERE topic_status = 'building'").run();
}

export function parseNotes(page: Pick<PageRow, "notes_json">): SlideNotes | null {
  return page.notes_json ? (JSON.parse(page.notes_json) as SlideNotes) : null;
}
