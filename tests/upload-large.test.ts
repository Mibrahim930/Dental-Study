// Long lectures: the upload answers right away and the slides are rendered in the background, resumably.
import fs from "fs";
import path from "path";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";

let batchCalls = 0;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  createBatch: vi.fn(async () => {
    batchCalls++;
    return `batch-${batchCalls}`;
  }),
  generate: vi.fn(async () => {
    throw new Error("not expected");
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, FILES_DIR } from "@/lib/db";
import { addDocument, processDocument, removeDocument } from "@/lib/processing";
import { makeExam, makeUser } from "./helpers";

/** A PDF with `n` simple pages, made with MuPDF itself. */
function makePdf(n: number): Buffer {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  for (let i = 0; i < n; i++) {
    doc.insertPage(-1, doc.addPage([0, 0, 960, 720], 0, font, `BT /F1 36 Tf 72 600 Td (Slide ${i + 1}) Tj ET`));
  }
  return Buffer.from(doc.saveToBuffer("").asUint8Array());
}

const pageRows = (docId: number) => db.prepare("SELECT page_number, image_path FROM pages WHERE document_id = ? ORDER BY page_number").all(docId) as { page_number: number; image_path: string }[];

beforeEach(() => {
  batchCalls = 0;
});

describe("uploading a long lecture", () => {
  it("answers before any slide is rendered, with the page count already known", async () => {
    const { examId } = makeExam(makeUser(), null);
    const t0 = Date.now();
    const docId = await addDocument(examId, "Long lecture", makePdf(40));
    const doc = db.prepare("SELECT page_count, status FROM documents WHERE id = ?").get(docId) as { page_count: number; status: string };
    expect(doc).toEqual({ page_count: 40, status: "processing" });
    expect(pageRows(docId).length).toBeLessThan(40); // rendering is still going on in the background
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fs.existsSync(path.join(FILES_DIR, `doc-${docId}`, "original.pdf"))).toBe(true);

    await processDocument(docId); // joins the background run
    const pages = pageRows(docId);
    expect(pages.map((p) => p.page_number)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    for (const p of pages) expect(fs.statSync(path.join(FILES_DIR, p.image_path)).size).toBeGreaterThan(1000);
    expect(batchCalls).toBe(1); // then the slides went to the AI as one batch
    expect((db.prepare("SELECT batch_id FROM documents WHERE id = ?").get(docId) as { batch_id: string }).batch_id).toBe("batch-1");
  });

  it("picks up where it left off after a restart: only the missing slides are rendered", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Interrupted", makePdf(12));
    await processDocument(docId);
    // Pretend the server died halfway: half the page rows are gone, as is the batch.
    db.prepare("DELETE FROM pages WHERE document_id = ? AND page_number > 6").run(docId);
    db.prepare("UPDATE documents SET batch_id = NULL WHERE id = ?").run(docId);
    const before = fs.statSync(path.join(FILES_DIR, `doc-${docId}`, "p3.jpg")).mtimeMs;
    await processDocument(docId);
    expect(pageRows(docId).map((p) => p.page_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(fs.statSync(path.join(FILES_DIR, `doc-${docId}`, "p3.jpg")).mtimeMs).toBe(before); // untouched
    expect(batchCalls).toBe(2);
  });

  it("stops rendering quietly when the lecture is removed meanwhile", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Removed", makePdf(30));
    await removeDocument(docId);
    await processDocument(docId);
    expect(db.prepare("SELECT 1 FROM documents WHERE id = ?").get(docId)).toBeUndefined();
    expect(pageRows(docId)).toEqual([]);
    expect(fs.existsSync(path.join(FILES_DIR, `doc-${docId}`))).toBe(false);
  });

  it("rejects a file that isn't a PDF without leaving a lecture behind", async () => {
    const { examId } = makeExam(makeUser(), null);
    const n = (db.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number }).n;
    await expect(addDocument(examId, "Not a pdf", Buffer.from("hello"))).rejects.toThrow();
    expect((db.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number }).n).toBe(n);
  });
});
