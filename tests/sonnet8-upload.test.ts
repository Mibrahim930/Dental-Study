// QA attack tests for the "render in the background" upload change.
import fs from "fs";
import path from "path";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";

let batchCalls = 0;
const cancel = vi.fn(async (...args: unknown[]) => void args);
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  createBatch: vi.fn(async () => {
    batchCalls++;
    return `batch-${batchCalls}`;
  }),
  cancelBatch: (c: unknown, id: string) => cancel(c, id),
  generate: vi.fn(async () => {
    throw new Error("not expected");
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
let signedIn: { id: number; api_key_enc: string; must_change_password: number; is_admin: number } | null = null;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => signedIn,
}));

import { db, FILES_DIR } from "@/lib/db";
import { addDocument, processDocument, removeDocument, resumeUnfinished } from "@/lib/processing";
import { POST } from "@/app/api/exams/[id]/upload/route";
import { makeExam, makeUser } from "./helpers";

function makePdf(n: number): Buffer {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  for (let i = 0; i < n; i++) {
    doc.insertPage(-1, doc.addPage([0, 0, 960, 720], 0, font, `BT /F1 36 Tf 72 600 Td (Slide ${i + 1}) Tj ET`));
  }
  return Buffer.from(doc.saveToBuffer("").asUint8Array());
}
const rows = (docId: number) => db.prepare("SELECT page_number FROM pages WHERE document_id = ? ORDER BY page_number").all(docId) as { page_number: number }[];
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const docDir = (id: number) => path.join(FILES_DIR, `doc-${id}`);

beforeEach(() => {
  batchCalls = 0;
  cancel.mockClear();
});

describe("concurrency", () => {
  it("two lectures uploaded at once both render fully, one batch each", async () => {
    const { examId } = makeExam(makeUser(), null);
    const [a, b] = await Promise.all([addDocument(examId, "A", makePdf(8)), addDocument(examId, "B", makePdf(9))]);
    await Promise.all([processDocument(a), processDocument(b)]);
    expect(rows(a).length).toBe(8);
    expect(rows(b).length).toBe(9);
    expect(batchCalls).toBe(2);
  });

  it("addDocument then resumeUnfinished() right away: no double render, one batch", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Dup", makePdf(10));
    resumeUnfinished();
    resumeUnfinished();
    await processDocument(docId);
    expect(rows(docId).length).toBe(10);
    expect(batchCalls).toBe(1);
  });

  it("Retry (processDocument) called during rendering joins the run", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Retry", makePdf(10));
    const p1 = processDocument(docId);
    const p2 = processDocument(docId);
    expect(p1).toBe(p2);
    await p1;
    expect(batchCalls).toBe(1);
  });
});

describe("removal while rendering", () => {
  it("removeDocument between ticks leaves no rows or files and does not crash", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Mid", makePdf(40));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await removeDocument(docId); // batch_id is NULL here
    await processDocument(docId);
    await new Promise((r) => setTimeout(r, 100));
    expect(cancel).not.toHaveBeenCalled();
    expect(db.prepare("SELECT 1 FROM documents WHERE id = ?").get(docId)).toBeUndefined();
    expect(rows(docId)).toEqual([]);
    expect(fs.existsSync(docDir(docId))).toBe(false);
    expect(batchCalls).toBe(0);
  });

  it("deleting the whole exam mid-render does not crash or leave pages", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "ExamGone", makePdf(30));
    await new Promise((r) => setImmediate(r));
    try {
      db.prepare("DELETE FROM exams WHERE id = ?").run(examId);
    } catch {
      return; // FK prevents it: fine
    }
    await processDocument(docId).catch((e) => {
      throw new Error(`BUG: render after exam delete threw: ${e}`);
    });
    expect(rows(docId)).toEqual([]);
  });
});

describe("bad PDFs", () => {
  it("1-page PDF works", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "One", makePdf(1));
    await processDocument(docId);
    expect(rows(docId).length).toBe(1);
  });

  it("corrupt PDF: addDocument rejects, nothing left behind", async () => {
    const { examId } = makeExam(makeUser(), null);
    const before = count("SELECT COUNT(*) n FROM documents");
    await expect(addDocument(examId, "Bad", Buffer.from("%PDF-1.4 garbage garbage"))).rejects.toThrow();
    expect(count("SELECT COUNT(*) n FROM documents")).toBe(before);
  });

  it("zero-page PDF is rejected without a row", async () => {
    const { examId } = makeExam(makeUser(), null);
    const empty = Buffer.from(new mupdf.PDFDocument().saveToBuffer("").asUint8Array());
    const before = count("SELECT COUNT(*) n FROM documents");
    await expect(addDocument(examId, "Empty", empty)).rejects.toThrow();
    expect(count("SELECT COUNT(*) n FROM documents")).toBe(before);
  });

  it("original.pdf corrupted after upload: error state with a readable message; Retry resumes after repair", async () => {
    const { examId } = makeExam(makeUser(), null);
    const good = makePdf(6);
    const docId = await addDocument(examId, "Rot", good);
    await processDocument(docId);
    db.prepare("DELETE FROM pages WHERE document_id = ? AND page_number > 3").run(docId);
    db.prepare("UPDATE documents SET batch_id = NULL, status='processing' WHERE id = ?").run(docId);
    fs.writeFileSync(path.join(docDir(docId), "original.pdf"), "nope");
    await processDocument(docId);
    const d = db.prepare("SELECT status, error FROM documents WHERE id = ?").get(docId) as { status: string; error: string };
    expect(d.status).toBe("error");
    expect(d.error).toMatch(/Could not read this PDF/);
    expect(rows(docId).length).toBe(3);
    fs.writeFileSync(path.join(docDir(docId), "original.pdf"), good);
    await processDocument(docId);
    expect(rows(docId).length).toBe(6);
  });

  it("original.pdf missing: error state, not an unhandled rejection", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Gone", makePdf(5));
    await processDocument(docId);
    db.prepare("DELETE FROM pages WHERE document_id = ?").run(docId);
    db.prepare("UPDATE documents SET batch_id = NULL WHERE id = ?").run(docId);
    fs.rmSync(path.join(docDir(docId), "original.pdf"));
    await processDocument(docId);
    expect((db.prepare("SELECT status FROM documents WHERE id = ?").get(docId) as { status: string }).status).toBe("error");
  });
});

describe("exam page / progress expectations", () => {
  it("fresh upload: page_count set, zero page rows, done count 0 via the page's own query", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Fresh", makePdf(20));
    const r = db
      .prepare("SELECT d.*, SUM(p.status = 'done') done FROM documents d LEFT JOIN pages p ON p.document_id = d.id WHERE d.exam_id = ? GROUP BY d.id")
      .get(examId) as { page_count: number; done: number | null };
    expect(r.page_count).toBe(20);
    expect(r.done ?? 0).toBe(0);
    await processDocument(docId);
  });
});

describe("upload route", () => {
  const post = (examId: number, init: RequestInit) =>
    POST(new Request("http://x/api/exams/1/upload", { method: "POST", ...init }), { params: Promise.resolve({ id: String(examId) }) } as never);
  const pdfForm = (name: string, bytes: Uint8Array | string) => {
    const f = new FormData();
    f.set("file", new File([bytes as BlobPart], name, { type: "application/pdf" }));
    return f;
  };
  let examId: number;
  beforeEach(() => {
    const u = makeUser();
    signedIn = { id: u, api_key_enc: "", must_change_password: 0, is_admin: 0 };
    examId = makeExam(u, null).examId;
  });

  it("413 when content-length is over 100 MB", async () => {
    const res = await post(examId, { headers: { "content-length": String(101 * 1024 * 1024) }, body: "x" });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/over 100 MB/);
  });

  it("non-numeric content-length does not wrongly 413", async () => {
    const res = await post(examId, { headers: { "content-length": "abc" }, body: pdfForm("a.pdf", makePdf(2)) });
    expect(res.status).not.toBe(413);
  });

  it("body that isn't multipart -> 400 JSON", async () => {
    const res = await post(examId, { headers: { "content-type": "text/plain" }, body: "hello" });
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("no body at all -> 400 JSON", async () => {
    const res = await post(examId, {});
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("multipart with truncated body -> 400 JSON", async () => {
    const body = '--abc\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n%PDF-1';
    const res = await post(examId, { headers: { "content-type": "multipart/form-data; boundary=abc" }, body });
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it(".txt -> 400", async () => {
    const res = await post(examId, { body: pdfForm("notes.txt", "hi") });
    expect(res.status).toBe(400);
  });

  it("bad PDF -> 400 'Could not read this PDF', no documents row", async () => {
    const before = count("SELECT COUNT(*) n FROM documents");
    const res = await post(examId, { body: pdfForm("bad.pdf", "not a pdf at all") });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Could not read this PDF/);
    expect(count("SELECT COUNT(*) n FROM documents")).toBe(before);
  });

  it("good PDF -> 200 with id, page_count known", async () => {
    const res = await post(examId, { body: pdfForm("good.pdf", makePdf(4)) });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect((db.prepare("SELECT page_count FROM documents WHERE id = ?").get(id) as { page_count: number }).page_count).toBe(4);
    await processDocument(id);
  });

  it("ENOSPC while saving original.pdf -> 507, no row, no leftover dir", async () => {
    const before = count("SELECT COUNT(*) n FROM documents");
    const dirsBefore = fs.existsSync(FILES_DIR) ? fs.readdirSync(FILES_DIR).length : 0;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    let res: Response;
    try {
      res = await post(examId, { body: pdfForm("full.pdf", makePdf(3)) });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(507);
    expect(count("SELECT COUNT(*) n FROM documents")).toBe(before);
    expect(fs.existsSync(FILES_DIR) ? fs.readdirSync(FILES_DIR).length : 0).toBe(dirsBefore);
  });

  it("someone else's exam -> 404", async () => {
    const other = makeExam(makeUser(), null).examId;
    expect((await post(other, { body: pdfForm("a.pdf", makePdf(1)) })).status).toBe(404);
  });
});

describe("memory", () => {
  it("rendering 165 pages grows RSS by less than 100 MB", async () => {
    const { examId } = makeExam(makeUser(), null);
    const docId = await addDocument(examId, "Big", makePdf(165));
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
    await processDocument(docId);
    clearInterval(timer);
    expect(rows(docId).length).toBe(165);
    expect((peak - before) / 1048576).toBeLessThan(100);
  }, 60000);
});
