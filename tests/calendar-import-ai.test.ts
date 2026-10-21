// Calendar release, job 4: "Paste or snap your exam schedule" — one AI call (mocked here), nothing saved before confirm.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mupdf from "mupdf";

type Call = { purpose: string; system: string; content: { type: string; text?: string; base64?: string }[] };
const calls: Call[] = [];
let reply: unknown = { exams: [], year_assumed: null };
let failWith: Error | null = null;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: Call) => {
    calls.push(opts);
    if (failWith) throw failWith;
    return reply;
  }),
}));
let hasKey = true;
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => {
    if (!hasKey) throw new Error("No API key set up. Add one in Settings.");
    return { userId, provider: "anthropic", apiKey: "k" };
  },
}));
let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { POST } from "@/app/api/calendar/import/read/route";
import { plannerSettings, todayIn } from "@/lib/planner";
import { cleanImported } from "@/lib/scheduleImport";
import { sniffFile } from "@/lib/pdf";
import { makeUser } from "./helpers";

function png(w = 400, h = 300): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(230);
  return pix.asPNG();
}
function pdf(pages: number): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, font, `BT /F1 18 Tf 72 700 Td (Endo Block ${i + 1} - Nov ${i + 4}) Tj ET`));
  return doc.saveToBuffer("").asUint8Array();
}
function send(text: string, files: { name: string; bytes: Uint8Array; type?: string }[] = []) {
  const body = new FormData();
  body.set("text", text);
  for (const f of files) body.append("files", new File([Buffer.from(f.bytes)], f.name, { type: f.type ?? "" }));
  return POST(new Request("http://x/api/calendar/import/read", { method: "POST", body }));
}
const examCount = () => (db.prepare("SELECT COUNT(*) n FROM exams").get() as { n: number }).n;

beforeEach(() => {
  calls.length = 0;
  failWith = null;
  hasKey = true;
  reply = { exams: [], year_assumed: null };
  currentUserId = makeUser();
});

describe("reading a pasted schedule", () => {
  it("makes one AI call with today's date in the student's zone, and saves nothing", async () => {
    reply = {
      exams: [
        { name: "Endo Block 2", date: "2026-11-04", course: "Endo D2", kind: "block", confidence: "high", note: null },
        { name: "Perio Quiz", date: "2026-11-06", course: null, kind: "quiz", confidence: "medium", note: "Year not shown; assumed 2026." },
      ],
      year_assumed: 2026,
    };
    const before = examCount();
    const res = await send("Endo Block 2 - Tue Nov 4\nPerio Quiz - Nov 6");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exams).toHaveLength(2);
    expect(body.yearAssumed).toBe(2026);
    expect(body.message).toBeNull();
    expect(examCount()).toBe(before);

    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe("exam schedule import");
    const today = todayIn(plannerSettings(currentUserId).timezone);
    expect(calls[0].content[0].text).toContain(`Today is ${today}`);
    expect(calls[0].content.map((p) => p.text ?? "").join("\n")).toContain("Perio Quiz - Nov 6");
    expect(calls[0].system).toMatch(/Never invent a date/);
    expect(calls[0].system).toMatch(/Ignore lectures/);
  });

  it("an empty result says so plainly", async () => {
    const body = await (await send("Lecture 1: Intro\nThanksgiving break")).json();
    expect(body.exams).toEqual([]);
    expect(body.message).toBe("We couldn't find any exam dates in that. Try a clearer photo or paste the text.");
  });

  it("bad dates from the AI become 'no date, check it' and unknown types become Block exam", () => {
    const out = cleanImported({
      exams: [
        { name: "  A  ", date: "2026-02-30", course: " ", kind: "block", confidence: "high", note: null },
        { name: "B", date: "Nov 4", course: null, kind: "weird" as never, confidence: "high", note: null },
        { name: "", date: "2026-11-04", course: null, kind: "quiz", confidence: "high", note: null },
        { name: "C", date: null, course: null, kind: "quiz", confidence: "high", note: "TBA" },
        { name: "D", date: "2026-12-01", course: null, kind: "practical", confidence: "medium", note: null },
      ],
      year_assumed: null,
    });
    expect(out.map((e) => [e.name, e.date, e.kind, e.confidence])).toEqual([
      ["A", null, "block", "low"],
      ["B", null, "block", "low"],
      ["C", null, "quiz", "low"],
      ["D", "2026-12-01", "practical", "medium"],
    ]);
    expect(out[1].note).toMatch(/Couldn't read the date/);
    expect(out[2].note).toBe("TBA");
    expect(cleanImported(null)).toEqual([]);
  });
});

describe("photos and PDFs", () => {
  it("a PNG photo is sent to the AI as a JPEG image", async () => {
    await send("", [{ name: "schedule.png", bytes: png() }]);
    const images = calls[0].content.filter((p) => p.type === "image");
    expect(images).toHaveLength(1);
    expect(sniffFile(Buffer.from(images[0].base64!, "base64"))).toBe("jpeg");
  });

  it("a PDF sends its first 3 pages as images plus their text, and says it stopped there", async () => {
    const body = await (await send("", [{ name: "syllabus.pdf", bytes: pdf(5) }])).json();
    expect(body.pdfCut).toBe(true);
    const parts = calls[0].content;
    expect(parts.filter((p) => p.type === "image")).toHaveLength(3);
    const text = parts.map((p) => p.text ?? "").join("\n");
    expect(text).toContain("Endo Block 3");
    expect(text).not.toContain("Endo Block 4");
  });

  it("HEIC, WebP and non-image files get a plain message and no AI call", async () => {
    const heic = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0, ...Buffer.from("mif1heic")]);
    let r = await send("", [{ name: "IMG_0001.HEIC", bytes: heic }]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/HEIC.*screenshot/);
    r = await send("", [{ name: "a.webp", bytes: new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]) }]);
    expect((await r.json()).error).toMatch(/WebP/);
    r = await send("", [{ name: "notes.docx", bytes: new Uint8Array(Buffer.from("PK\u0003\u0004 not a photo")) }]);
    expect((await r.json()).error).toMatch(/isn't a photo or a PDF/);
    r = await send("", [{ name: "broken.pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.7 garbage")) }]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/couldn't open "broken.pdf"/);
    expect(calls).toHaveLength(0);
  });

  it("refuses oversized uploads, too many files, too much text, and an empty request", async () => {
    const big = new Request("http://x", { method: "POST", headers: { "content-length": String(21 * 1024 * 1024) }, body: "x" });
    expect((await POST(big)).status).toBe(413);
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.png`, bytes: png(10, 10) }));
    expect((await (await send("", five)).json()).error).toMatch(/up to 4 files/);
    expect((await (await send("x".repeat(30001))).json()).error).toMatch(/a lot of text/);
    expect((await (await send("   ")).json()).error).toMatch(/Paste the schedule or add a photo first/);
    expect(calls).toHaveLength(0);
  });
});

describe("AI and key problems", () => {
  it("a key problem is passed through; anything else is a plain message", async () => {
    failWith = new Error("401 invalid x-api-key");
    let r = await send("Endo Nov 4");
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("401 invalid x-api-key");
    failWith = new Error("socket hang up at TLSWrap.onStreamRead (node:internal/stream_base_commons:216:20)");
    r = await send("Endo Nov 4");
    expect((await r.json()).error).toBe("The AI couldn't read that just now. Try again in a moment, or type the exams in the table.");
  });

  it("without a key it says how to add one", async () => {
    hasKey = false;
    const r = await send("Endo Nov 4");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Add your AI key in Settings/);
  });

  it("signed out: 401", async () => {
    currentUserId = 0;
    expect((await send("x")).status).toBe(401);
  });
});
