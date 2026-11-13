import fs from "fs";
import path from "path";
import { db, FILES_DIR, resetSectionQuiz, type PageRow } from "./db";
import { batchResults, cancelBatch, createBatch, generate, mapLimit } from "./ai";
import { credentials, type Credentials } from "./credentials";
import { buildTopicMap } from "./topics";
import { NOTES_SYSTEM, SlideNotes } from "./notes";
import { openPdf, PdfRefused, renderPage } from "./pdf";
import { track } from "./inflight";

export type { SlideNotes };

/** The most pages one uploaded lecture may have: a longer PDF would fill the shared disk with slide images. */
export const MAX_PDF_PAGES = 400;

/**
 * Save an uploaded PDF and start reading it in the background. Only the page count happens here, so the browser gets
 * its answer within seconds however long the lecture is: the slides are rendered to images and sent to the AI by
 * processDocument (a 150-slide lecture used to be rendered inside the upload request, which the hosting proxy cut off).
 */
export async function addDocument(examId: number, filename: string, bytes: Buffer): Promise<number> {
  let count: number;
  const pdf = openPdf(bytes);
  try {
    count = pdf.countPages();
  } finally {
    pdf.destroy();
  }
  if (count === 0) throw new Error("This PDF has no pages.");
  if (count > MAX_PDF_PAGES) throw new PdfRefused(`This PDF has ${count} pages. The most one lecture can have is ${MAX_PDF_PAGES}. Split it and upload the parts.`);

  const docId = Number(
    db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, ?, ?, 'processing')").run(examId, filename, count).lastInsertRowid,
  );
  const dir = path.join(FILES_DIR, `doc-${docId}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "original.pdf"), bytes);
  } catch (err) {
    // Nothing was saved (e.g. the disk is full): leave no half-made lecture behind.
    db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  void processDocument(docId);
  return docId;
}

/**
 * Render to images any slides of a lecture that aren't in the database yet: a fresh upload, or one interrupted by a
 * restart. A page at a time, giving the server a breath between pages so the site stays responsive meanwhile.
 * Returns false if the lecture was removed while this ran.
 */
async function renderMissingPages(doc: DocInfo): Promise<boolean> {
  const have = new Set((db.prepare("SELECT page_number FROM pages WHERE document_id = ?").all(doc.id) as { page_number: number }[]).map((p) => p.page_number));
  if (have.size >= doc.page_count) return true;
  const pdf = openPdf(fs.readFileSync(path.join(FILES_DIR, `doc-${doc.id}`, "original.pdf")));
  try {
    const insert = db.prepare("INSERT OR IGNORE INTO pages (document_id, page_number, text, image_path, aspect) VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < doc.page_count; i++) {
      if (have.has(i + 1)) continue;
      if (!db.prepare("SELECT 1 FROM documents WHERE id = ?").get(doc.id)) return false; // removed meanwhile
      const { jpeg, text, aspect } = renderPage(pdf, i);
      const rel = path.join(`doc-${doc.id}`, `p${i + 1}.jpg`);
      fs.writeFileSync(path.join(FILES_DIR, rel), jpeg);
      insert.run(doc.id, i + 1, text, rel, aspect);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    pdf.destroy();
  }
  return true;
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

type DocInfo = { id: number; filename: string; exam_id: number; page_count: number; batch_id: string | null; user_id: number | null };

function docInfo(docId: number): DocInfo | undefined {
  return db
    .prepare("SELECT d.id, d.filename, d.exam_id, d.page_count, d.batch_id, e.user_id FROM documents d JOIN exams e ON e.id = d.exam_id WHERE d.id = ?")
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

  try {
    if (!(await renderMissingPages(doc))) return;
  } catch (err) {
    return failDoc(docId, `Could not read this PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pages = pendingPages(docId);
  if (creds.provider === "anthropic" && pages.length > 3) {
    try {
      const batchId = await createBatch(
        creds,
        SlideNotes,
        pages.map((p) => ({ customId: String(p.id), ...slideRequest(doc.filename, p) })),
      );
      db.prepare("UPDATE documents SET batch_id = ?, batch_at = datetime('now') WHERE id = ?").run(batchId, docId);
      return;
    } catch (err) {
      console.error(`Batch create failed for document ${docId}; processing directly`, err);
    }
  }
  await processDirectly(creds, doc, pages);
  finishDocument(doc);
}

/** Slide by slide. A deploy waits for it (lib/inflight.ts): the slides read so far are paid for by then. */
function processDirectly(creds: Credentials, doc: DocInfo, pages: PageRow[]): Promise<void> {
  return track(readSlides(creds, doc, pages));
}

async function readSlides(creds: Credentials, doc: DocInfo, pages: PageRow[]) {
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

/** A batch that still can't be collected this long after it was sent is given up on (the API keeps results 24 hours). */
export const BATCH_GIVE_UP_HOURS = 26;

/** What the student reads when collecting a lecture's slide batch is given up on. */
export const BATCH_FAILED = {
  noKey: "This lecture's slides couldn't be collected because there is no AI key. Add one in Settings, then press Retry.",
  keyRefused: "Your AI key was turned down while collecting this lecture's slides. Check it in Settings, then press Retry.",
  gone: "The AI service no longer has this lecture's slides. Press Retry to read the rest again.",
  tooLong: "Collecting this lecture's slides kept failing for over a day. Press Retry to read the rest again.",
};

/** HTTP status of an error from the AI provider's SDK, if it has one. */
const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};

/**
 * Check running slide batches; save finished results. Called every minute from instrumentation.ts.
 * A batch that can never be collected (the key was removed or refused, or the API no longer knows the batch) fails its
 * lecture at once with a plain message and is forgotten, so Retry starts afresh. Other errors (network, a busy API)
 * are tried again next minute, until the batch is BATCH_GIVE_UP_HOURS old.
 */
export async function pollBatches() {
  if (polling) return;
  polling = true;
  try {
    const docs = db.prepare("SELECT id FROM documents WHERE batch_id IS NOT NULL AND status = 'processing'").all() as { id: number }[];
    for (const { id } of docs) {
      const doc = docInfo(id);
      if (!doc?.batch_id || !doc.user_id) continue;
      let creds: Credentials;
      try {
        creds = credentials(doc.user_id);
      } catch (err) {
        console.error(`Polling batch for document ${id}: no usable key`, err);
        failDoc(id, BATCH_FAILED.noKey);
        continue;
      }
      try {
        const outcome = await batchResults(creds, "read slides (batch)", SlideNotes, doc.batch_id);
        if (!outcome) continue; // still running
        const byId = new Map(pendingPages(id).map((p) => [String(p.id), p]));
        // Saving the results, forgetting the batch and recording its cost happen together, so a batch is never
        // collected (and counted in the spending tracker) twice, whatever stops the server.
        db.transaction(() => {
          for (const r of outcome.results) {
            const page = byId.get(r.customId);
            if (!page || !r.ok) continue;
            try {
              savePageNotes(creds.userId, page, r.value);
            } catch (err) {
              console.error(`Saving slide ${page.id} from a batch failed; it is read again directly`, err);
            }
          }
          db.prepare("UPDATE documents SET batch_id = NULL WHERE id = ?").run(id);
          outcome.logUsage();
        })();
        // Anything the batch couldn't do gets one direct retry.
        const leftover = pendingPages(id);
        if (leftover.length) await processDirectly(creds, doc, leftover);
        finishDocument(doc);
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403) failDoc(id, BATCH_FAILED.keyRefused);
        else if (status === 404) failDoc(id, BATCH_FAILED.gone);
        else if (batchAgeHours(id) > BATCH_GIVE_UP_HOURS) failDoc(id, BATCH_FAILED.tooLong);
        console.error(`Polling batch for document ${id} failed`, err);
      }
    }
  } finally {
    polling = false;
  }
}

/** Hours since a lecture's batch was sent (batches sent before that was recorded: since the upload). */
function batchAgeHours(docId: number): number {
  const r = db.prepare("SELECT (julianday('now') - julianday(COALESCE(batch_at, created_at))) * 24 AS h FROM documents WHERE id = ?").get(docId) as
    | { h: number | null }
    | undefined;
  return r?.h ?? 0;
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
  if (!db.prepare("SELECT 1 FROM pages WHERE id = ?").get(page.id)) return; // lecture was removed meanwhile
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE pages SET status = 'done', error = NULL, title = ?, notes_json = ?, emphasized = ?, has_case = ?, is_filler = ? WHERE id = ?",
    ).run(notes.title, JSON.stringify(notes), notes.emphasized ? 1 : 0, notes.case_prompt ? 1 : 0, notes.is_filler ? 1 : 0, page.id);
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

/**
 * Resume lectures that were mid-processing when the app stopped (optionally only one user's). At start-up, topic maps
 * that were being built are built again in "auto" mode: lectures already in the map stay as they are, only lectures
 * with no section yet are mapped, and leftover slides join their nearest section without an AI call. (A build writes
 * its result in one transaction at the end, so an interrupted one left the earlier map whole.)
 */
export function resumeUnfinished(userId?: number) {
  const docs = db
    .prepare(
      `SELECT d.id FROM documents d JOIN exams e ON e.id = d.exam_id
       WHERE d.status IN ('processing','error') AND d.batch_id IS NULL ${userId ? "AND e.user_id = ?" : "AND d.status = 'processing'"}`,
    )
    .all(...(userId ? [userId] : [])) as { id: number }[];
  for (const d of docs) void processDocument(d.id);
  if (!userId) {
    const building = db.prepare("SELECT id FROM exams WHERE topic_status = 'building'").all() as { id: number }[];
    for (const e of building) void buildTopicMap(e.id, "auto");
  }
}

/** A slide's notes, or null when it has none or they are damaged (not JSON, or not an object). */
export function parseNotes(page: Pick<PageRow, "notes_json">): SlideNotes | null {
  if (!page.notes_json) return null;
  try {
    const n: unknown = JSON.parse(page.notes_json);
    return n && typeof n === "object" && !Array.isArray(n) ? (n as SlideNotes) : null;
  } catch {
    return null;
  }
}

/**
 * Remove a lecture (or cancel one still being read): stops its slide batch, deletes its slides and files, and
 * takes its slides out of the topic map. Questions written from it are deleted if never answered; answered ones
 * are retired (flagged) so they never come back but practice history and scores stay intact.
 * Topics that lose slides have their cached lesson and quiz cleared so they're rewritten from what's left.
 */
export async function removeDocument(docId: number): Promise<void> {
  const doc = docInfo(docId);
  if (!doc) return;
  if (doc.batch_id && doc.user_id) {
    try {
      await cancelBatch(credentials(doc.user_id), doc.batch_id);
    } catch (err) {
      console.error(`Cancelling batch for document ${docId} failed`, err);
    }
  }

  const pageIds = new Set((db.prepare("SELECT id FROM pages WHERE document_id = ?").all(docId) as { id: number }[]).map((p) => p.id));
  db.transaction(() => {
    if (pageIds.size) {
      const ids = [...pageIds];
      const marks = ids.map(() => "?").join(",");
      const fromLecture = `(source_page_id IN (${marks}) OR image_page_id IN (${marks}))`;
      // Never-answered questions from this lecture go; answered ones are retired so history stays.
      db.prepare(
        `DELETE FROM questions WHERE ${fromLecture} AND NOT EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.question_id = questions.id AND aq.chosen_index IS NOT NULL)`,
      ).run(...ids, ...ids);
      db.prepare(`UPDATE questions SET flagged = 1, flag_note = COALESCE(flag_note, 'Lecture removed') WHERE ${fromLecture}`).run(...ids, ...ids);
    }

    const topics = db.prepare("SELECT id, page_ids FROM topics WHERE exam_id = ?").all(doc.exam_id) as { id: number; page_ids: string }[];
    for (const t of topics) {
      const pages = JSON.parse(t.page_ids) as number[];
      const kept = pages.filter((p) => !pageIds.has(p));
      if (kept.length === pages.length) continue;
      if (kept.length === 0) db.prepare("DELETE FROM topics WHERE id = ?").run(t.id);
      else {
        db.prepare("UPDATE topics SET page_ids = ?, lesson_json = NULL WHERE id = ?").run(JSON.stringify(kept), t.id);
        resetSectionQuiz(t.id); // rewritten from what's left; earlier answers detach from the old positions
      }
    }
    // Renumber what's left so positions stay 0..n-1.
    const left = db.prepare("SELECT id FROM topics WHERE exam_id = ? ORDER BY position").all(doc.exam_id) as { id: number }[];
    left.forEach((t, i) => db.prepare("UPDATE topics SET position = ? WHERE id = ?").run(i, t.id));
    if (left.length === 0) db.prepare("UPDATE exams SET topic_status = 'none' WHERE id = ?").run(doc.exam_id);

    if (pageIds.size) db.prepare(`DELETE FROM pages_fts WHERE page_id IN (${[...pageIds].map(() => "?").join(",")})`).run(...pageIds);
    db.prepare("DELETE FROM cases WHERE exam_id = ? AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.case_id = cases.id)").run(doc.exam_id);
    db.prepare("UPDATE study_sessions SET current_position = MIN(current_position, ?) WHERE exam_id = ?").run(Math.max(0, left.length - 1), doc.exam_id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
  })();
  // A classmate's copy of a shared exam points at the same slide images; keep them while anyone else still uses them.
  const shared = doc.user_id
    ? db
        .prepare(
          `SELECT 1 FROM pages p JOIN documents d ON d.id = p.document_id JOIN exams e ON e.id = d.exam_id
           WHERE p.image_path LIKE ? AND e.user_id != ? LIMIT 1`,
        )
        .get(`doc-${docId}/%`, doc.user_id)
    : null;
  if (shared) fs.rmSync(path.join(FILES_DIR, `doc-${docId}`, "original.pdf"), { force: true });
  else fs.rmSync(path.join(FILES_DIR, `doc-${docId}`), { recursive: true, force: true });
}
