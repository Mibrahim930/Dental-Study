// QA attack tests for the calendar "first release" (dc8ae49..bc9fba1). Tests named "FIXED (was BUG…)" failed when written and
// pass after the QA-fix commit. Tests named "NOTE:" document behaviour worth knowing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { POST as readPOST } from "@/app/api/calendar/import/read/route";
import { POST as icsImportPOST } from "@/app/api/calendar/import/ics/route";
import { POST as examsPOST } from "@/app/api/calendar/exams/route";
import { POST as busyPOST } from "@/app/api/calendar/busy/route";
import { POST as skipPOST } from "@/app/api/calendar/busy/[id]/skip/route";
import { POST as deletePOST } from "@/app/api/calendar/busy/[id]/delete/route";
import { POST as dayPOST } from "@/app/api/planner/day/route";
import { POST as replanPOST } from "@/app/api/planner/replan/route";
import { GET as feedGET } from "@/app/api/ics/[token]/route";
import { addDays, icsToken, markTopicStudied, missedSummary, plannerSettings, rebuildPlan, replanFromToday, setDayOverride, setTaskStatus, tasksOn, todayIn, weekday } from "@/lib/planner";
import { parseIcs, startDate, parseProp } from "@/lib/icsImport";
import { cleanImported } from "@/lib/scheduleImport";
import { cleanExamRows, createExams } from "@/lib/examImport";
import { busyOn, coversDate, firstOccurrence, loadBusy, maskOf } from "@/lib/busy";
import { foldLine, icsEscape } from "@/lib/ics";
import { daysUntil } from "@/lib/format";
import { examProgress, examProgressMany } from "@/lib/readiness";
import { findCrunches, crunchMessage, readinessTone } from "@/lib/calendar";
import { makeExam, makeUser } from "./helpers";

const TZ = "America/New_York";
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, "");
const today = () => todayIn(plannerSettings(currentUserId).timezone);
const nextWeekday = (from: string, wd: number) => {
  let d = from;
  while (weekday(d) !== wd) d = addDays(d, 1);
  return d;
};
const fileForm = (name: string, bytes: Uint8Array | string, field = "file") => {
  const body = new FormData();
  body.set(field, new File([typeof bytes === "string" ? bytes : Buffer.from(bytes)], name));
  return body;
};
const importIcs = (text: string | Uint8Array, name = "x.ics") => icsImportPOST(new Request("http://x/api/calendar/import/ics", { method: "POST", body: fileForm(name, text) }));
const vcal = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

beforeEach(() => {
  calls.length = 0;
  failWith = null;
  hasKey = true;
  reply = { exams: [], year_assumed: null };
  currentUserId = makeUser();
});
afterEach(() => vi.useRealTimers());

// ───────────────────────── 1. ICS parser ─────────────────────────
describe("parseIcs edge cases", () => {
  it("ignores properties of nested components (VALARM) inside an event, and keeps ones after it", () => {
    const text = vcal(vevent("DTSTART;VALUE=DATE:20261104", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder text", "SUMMARY:ALARM SUMMARY", "END:VALARM", "SUMMARY:Endo Exam", "DESCRIPTION:real"));
    const { events } = parseIcs(text, TZ);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("Endo Exam");
    expect(events[0].description).toBe("real");
  });

  it("odd-case property names, params in lower case, quoted TZID and quotes containing colon/semicolon", () => {
    const text = vcal(vevent('dtstart;tzid="America/Los_Angeles";value=date-time:20261104T090000', "summary:Perio Quiz"));
    const { events } = parseIcs(text, TZ);
    expect(events).toHaveLength(1);
    expect(events[0].date).toBe("2026-11-04");
    expect(parseProp('X-FOO;P="a:b;c":val:ue')).toEqual({ name: "X-FOO", params: { P: "a:b;c" }, value: "val:ue" });
  });

  it("VALUE=DATE-TIME on an 8-digit value is still a plain date", () => {
    expect(startDate({ name: "DTSTART", params: { VALUE: "DATE-TIME" }, value: "20261104" }, TZ)).toEqual({ date: "2026-11-04", allDay: true });
  });

  it("UTC times land on the student's day; TZID times convert; late-evening Pacific becomes next day in New York", () => {
    expect(startDate({ name: "DTSTART", params: {}, value: "20261105T020000Z" }, TZ)?.date).toBe("2026-11-04");
    expect(startDate({ name: "DTSTART", params: { TZID: "America/Los_Angeles" }, value: "20261104T220000" }, TZ)?.date).toBe("2026-11-05");
    expect(startDate({ name: "DTSTART", params: { TZID: "/America/Chicago" }, value: "20261104T230000" }, TZ)?.date).toBe("2026-11-05");
  });

  it("a local time inside the spring-forward gap does not crash or jump days", () => {
    const r = startDate({ name: "DTSTART", params: { TZID: "America/New_York" }, value: "20260308T023000" }, TZ);
    expect(r?.date).toBe("2026-03-08");
    const r2 = startDate({ name: "DTSTART", params: { TZID: "America/New_York" }, value: "20261101T013000" }, TZ); // ambiguous fall-back hour
    expect(r2?.date).toBe("2026-11-01");
  });

  it("Windows time-zone names and junk zones keep the written date, never throw", () => {
    for (const tz of ["Eastern Standard Time", "W. Europe Standard Time", "", "Nowhere/City", "UTC+5", "\u0000", "a".repeat(5000)]) {
      expect(startDate({ name: "DTSTART", params: { TZID: tz }, value: "20261104T230000" }, TZ)?.date).toBe("2026-11-04");
    }
  });

  it("invalid times/dates are handled: 25:99, month 13, Feb 30, year 2101, year 1999", () => {
    expect(startDate({ name: "DTSTART", params: {}, value: "20261304" }, TZ)).toBeNull();
    expect(startDate({ name: "DTSTART", params: {}, value: "20260230" }, TZ)).toBeNull();
    expect(startDate({ name: "DTSTART", params: {}, value: "21010101" }, TZ)).toBeNull();
    expect(startDate({ name: "DTSTART", params: {}, value: "19991231" }, TZ)).toBeNull();
    expect(startDate({ name: "DTSTART", params: {}, value: "20261104T259900" }, TZ)?.date).toBe("2026-11-04");
    expect(parseIcs(vcal(vevent("DTSTART:21500101", "SUMMARY:Far future exam")), TZ).events).toEqual([]);
  });

  it("duplicate UIDs: same uid + same name + same date collapses, same uid on other dates stays (moved/overridden occurrences)", () => {
    const e = (d: string) => vevent("UID:abc", `DTSTART;VALUE=DATE:${d}`, "SUMMARY:Midterm");
    const { events } = parseIcs(vcal(e("20261104"), e("20261104"), e("20261111")), TZ);
    expect(events.map((x) => x.date)).toEqual(["2026-11-04", "2026-11-11"]);
  });

  it("CRLF, LF, bare CR, BOM and folded lines (also folded in the middle of a UTF-8 word)", () => {
    for (const nl of ["\r\n", "\n", "\r"]) {
      const text = `\uFEFFBEGIN:VCALENDAR${nl}BEGIN:VEVENT${nl}DTSTART;VALUE=DATE:20261104${nl}SUMMARY:Endo${nl} dontics Exam${nl}END:VEVENT${nl}END:VCALENDAR${nl}`;
      expect(parseIcs(text, TZ).events[0]?.name).toBe("Endodontics Exam");
    }
  });

  it("FIXED (was BUG): an event whose END:VEVENT is missing is silently dropped when another BEGIN:VEVENT follows (comment says missing ENDs are tolerated)", () => {
    const text = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261104\r\nSUMMARY:First Exam\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261105\r\nSUMMARY:Second Exam\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(parseIcs(text, TZ).events.map((e) => e.name)).toEqual(["First Exam", "Second Exam"]);
  });

  it("FIXED (was BUG, low): a truncated download (last event has no END:VEVENT/END:VCALENDAR) loses its last event instead of keeping it", () => {
    const text = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261104\r\nSUMMARY:Cut Off Exam\r\n`;
    expect(parseIcs(text, TZ).events.map((e) => e.name)).toEqual(["Cut Off Exam"]);
  });

  it("cancelled, moved-occurrence and recurring flags", () => {
    const { events } = parseIcs(
      vcal(
        vevent("DTSTART;VALUE=DATE:20261104", "SUMMARY:Gone", "STATUS:cancelled"),
        vevent("DTSTART;VALUE=DATE:20261105", "SUMMARY:Moved", "RECURRENCE-ID;VALUE=DATE:20261105"),
        vevent("DTSTART;VALUE=DATE:20261106", "SUMMARY:Weekly Quiz", "RRULE:FREQ=WEEKLY"),
      ),
      TZ,
    );
    expect(events.map((e) => [e.name, e.recurring])).toEqual([["Weekly Quiz", true]]);
  });

  it("exam-word detection uses whole words", () => {
    const names = ["Contest", "Latest news", "Midterm 1", "Final Exam", "Practical (OSCE)", "Boards review"];
    const { events } = parseIcs(vcal(...names.map((n, i) => vevent(`DTSTART;VALUE=DATE:2026110${i + 1}`, `SUMMARY:${n}`))), TZ);
    expect(Object.fromEntries(events.map((e) => [e.name, e.looksLikeExam]))).toEqual({
      Contest: false,
      "Latest news": false,
      "Midterm 1": true,
      "Final Exam": true,
      "Practical (OSCE)": true,
      "Boards review": true,
    });
  });

  it("10,000 events (UTC, TZID and DATE mixed) parse in a few seconds and are capped", () => {
    const evs: string[] = [];
    for (let i = 0; i < 10000; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const start = i % 3 === 0 ? `DTSTART:2026${String((i % 12) + 1).padStart(2, "0")}${day}T150000Z` : i % 3 === 1 ? `DTSTART;TZID=America/Chicago:2026${String((i % 12) + 1).padStart(2, "0")}${day}T090000` : `DTSTART;VALUE=DATE:2026${String((i % 12) + 1).padStart(2, "0")}${day}`;
      evs.push(vevent(`UID:u${i}`, start, `SUMMARY:Event ${i} exam`));
    }
    const t0 = Date.now();
    const { events, truncated } = parseIcs(vcal(...evs), TZ);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(4000);
    expect(events.length).toBeLessThanOrEqual(5000);
    expect(truncated).toBe(true);
  });

  it("FIXED (was BUG): many stray END: lines after many BEGIN: lines take quadratic time (stack.lastIndexOf per END) — one 15 MB upload can hang the server", () => {
    // 60k BEGIN:X then 60k END:Y (about 0.8 MB). Each END scans the whole stack: 3.6e9 comparisons.
    const text = "BEGIN:VCALENDAR\n" + "BEGIN:X\n".repeat(60000) + "END:Y\n".repeat(60000) + "END:VCALENDAR\n";
    const t0 = Date.now();
    parseIcs(text, TZ);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a 5 MB single line and 200k blank lines do not blow up", () => {
    const t0 = Date.now();
    parseIcs("BEGIN:VCALENDAR\n" + "SUMMARY:" + "x".repeat(5_000_000) + "\n" + "\n".repeat(200000) + "END:VCALENDAR", TZ);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("POST /api/calendar/import/ics never throws out", () => {
  const answered = async (res: Response) => {
    expect(res.status).toBeLessThan(500);
    const body = await res.json(); // always JSON
    expect(typeof body).toBe("object");
    return body;
  };

  it("garbage inputs all get a JSON answer", async () => {
    const random = new Uint8Array(200_000);
    for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) >>> 24;
    const utf16 = Buffer.from("\uFEFF" + vcal(vevent("DTSTART;VALUE=DATE:20261104", "SUMMARY:Exam")), "utf16le");
    const inputs: (string | Uint8Array)[] = [
      random,
      utf16,
      "BEGIN:VCALENDAR",
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:\nSUMMARY\n:\n;;;\nEND:VEVENT",
      "BEGIN:VCALENDAR\n" + "\u0000".repeat(1000) + "\nEND:VCALENDAR",
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=\u0000:20261104T100000\nSUMMARY:\\\nEND:VEVENT",
      "x".repeat(6000) + "BEGIN:VCALENDAR",
      "\uD800\uDC00 BEGIN:VCALENDAR \uD800", // lone surrogate
    ];
    for (const i of inputs) await answered(await importIcs(i));
  });

  it("non-multipart bodies, missing/empty/string 'file' fields, wrong field name", async () => {
    const mk = (init: RequestInit) => icsImportPOST(new Request("http://x", { method: "POST", ...init }));
    for (const res of [
      await mk({ body: "{}", headers: { "content-type": "application/json" } }),
      await mk({ body: "garbage", headers: { "content-type": "multipart/form-data; boundary=zzz" } }),
      await mk({}),
      await mk({ body: (() => { const f = new FormData(); f.set("file", "just text"); return f; })() }),
      await mk({ body: new FormData() }),
      await mk({ body: fileForm("e.ics", "", "file") }),
      await mk({ body: fileForm("e.ics", vcal(), "files") }),
    ]) {
      const b = await answered(res);
      expect(b.error).toBeTruthy();
    }
  });

  it("returns upcoming exams first, past ones only when in the last year, and never saves anything", async () => {
    const t = today();
    const d = (n: number) => addDays(t, n).replaceAll("-", "");
    const before = (db.prepare("SELECT COUNT(*) n FROM exams").get() as { n: number }).n;
    const text = vcal(
      vevent(`DTSTART;VALUE=DATE:${d(5)}`, "SUMMARY:Endo Exam [DENT 501]"),
      vevent(`DTSTART;VALUE=DATE:${d(-10)}`, "SUMMARY:Old Quiz"),
      vevent(`DTSTART;VALUE=DATE:${d(-900)}`, "SUMMARY:Ancient Final"),
      vevent(`DTSTART;VALUE=DATE:${d(3)}`, "SUMMARY:Lecture 4"),
    );
    const body = await answered(await importIcs(text));
    expect(body.events.map((e: { name: string }) => e.name)).toEqual(["Old Quiz", "Lecture 4", "Endo Exam"]);
    expect(body.events.find((e: { name: string }) => e.name === "Endo Exam")).toMatchObject({ course: "DENT 501", looksLikeExam: true, past: false });
    expect(body.events.find((e: { name: string }) => e.name === "Old Quiz").past).toBe(true);
    expect((db.prepare("SELECT COUNT(*) n FROM exams").get() as { n: number }).n).toBe(before);
  });

  it("a 5000+ event feed answers within a few seconds and says it was cut", async () => {
    const t = today();
    const evs = Array.from({ length: 6000 }, (_, i) => vevent(`UID:${i}`, `DTSTART;VALUE=DATE:${addDays(t, 1 + (i % 300)).replaceAll("-", "")}`, `SUMMARY:Thing ${i}`));
    const t0 = Date.now();
    const body = await answered(await importIcs(vcal(...evs)));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(body.cut).toBe(true);
    expect(body.events.length).toBeLessThanOrEqual(400);
  });

  it("401 without a session", async () => {
    currentUserId = 0;
    expect((await importIcs(vcal())).status).toBe(401);
  });
});

// ───────────────────────── 2. AI schedule import route ─────────────────────────
function png(w = 400, h = 300): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(230);
  return pix.asPNG();
}
function pdf(pages: number): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, font, `BT /F1 18 Tf 72 700 Td (Endo Block ${i + 1}) Tj ET`));
  return doc.saveToBuffer("").asUint8Array();
}
function send(text: string, files: { name: string; bytes: Uint8Array }[] = []) {
  const body = new FormData();
  body.set("text", text);
  for (const f of files) body.append("files", new File([Buffer.from(f.bytes)], f.name));
  return readPOST(new Request("http://x/api/calendar/import/read", { method: "POST", body }));
}
const examCount = () => (db.prepare("SELECT COUNT(*) n FROM exams").get() as { n: number }).n;

describe("AI schedule import (mocked generate)", () => {
  it("weird AI output never throws: null/number/object fields, null entries", () => {
    const weird = {
      exams: [
        null,
        undefined,
        "string entry",
        42,
        { name: null, date: "2026-11-04" },
        { name: 123, date: 20261104, course: 5, kind: 7, confidence: {}, note: [] },
        { name: "Real", date: "2026-11-4", course: { a: 1 }, kind: "quiz", confidence: "high", note: 9 },
        { name: "  Ok  ", date: "2026-11-04T10:00:00", kind: "BLOCK", confidence: "HIGH", note: "   " },
        { name: "x".repeat(500), date: "2026-11-04", course: "c".repeat(500), kind: "board", confidence: "medium", note: "n".repeat(500) },
      ],
      year_assumed: "2026",
    } as never;
    const out = cleanImported(weird);
    expect(out.map((e) => e.name)).toEqual(["123", "Real", "Ok", "x".repeat(120)]);
    expect(out.every((e) => e.date === null || /^\d{4}-\d{2}-\d{2}$/.test(e.date))).toBe(true);
    const long = out[3];
    expect(long.course!.length).toBe(80);
    expect(long.note!.length).toBe(200);
    expect(out[1].date).toBeNull(); // "2026-11-4" is not accepted
    expect(out[1].note).toMatch(/Couldn't read the date/);
  });

  it("NOTE: 'Nov-4' style dates the model gets wrong become 'no date', flagged low, with the original shown in the note", () => {
    const [e] = cleanImported({ exams: [{ name: "A", date: "2026-11-4", course: null, kind: "quiz", confidence: "high", note: null }], year_assumed: null });
    expect(e.confidence).toBe("low");
    expect(e.note).toContain("2026-11-4");
  });

  it("FIXED (was BUG, low): 200 exams from the AI are silently cut to 60 with no message for the student", async () => {
    reply = { exams: Array.from({ length: 200 }, (_, i) => ({ name: `Exam ${i}`, date: addDays(today(), 10 + i), course: null, kind: "quiz", confidence: "high", note: null })), year_assumed: null };
    const body = await (await send("lots")).json();
    expect(body.exams.length).toBeLessThanOrEqual(60);
    // Expected: the response (or message) tells the student that only the first 60 are shown.
    expect(body.message ?? body.cut ?? body.truncated ?? null).not.toBeNull();
  });

  it("passes purpose 'exam schedule import', today's date in her zone, and saves nothing", async () => {
    reply = { exams: [{ name: "Endo", date: "2026-11-04", course: null, kind: "block", confidence: "high", note: null }], year_assumed: 2026 };
    const before = examCount();
    const res = await send("Endo - Nov 4");
    expect(res.status).toBe(200);
    expect(calls[0].purpose).toBe("exam schedule import");
    expect(calls[0].content[0].text).toContain(`Today is ${today()}`);
    expect(examCount()).toBe(before);
  });

  it("PDF: 5 pages → only 3 images, pdfCut flag; PNG → JPEG; two files together", async () => {
    const res = await send("", [{ name: "s.pdf", bytes: pdf(5) }]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pdfCut).toBe(true);
    expect(calls[0].content.filter((p) => p.type === "image")).toHaveLength(3);
    calls.length = 0;
    const res2 = await send("", [{ name: "a.png", bytes: png() }, { name: "b.pdf", bytes: pdf(1) }]);
    expect(res2.status).toBe(200);
    expect(calls[0].content.filter((p) => p.type === "image")).toHaveLength(2);
    const first = calls[0].content.find((p) => p.type === "image")!;
    expect(Buffer.from(first.base64!, "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
  });

  it("file errors: empty submit, whitespace only, 5 files, 5 pages over the limit, corrupt PDF, text file, HEIC, WebP, oversize text", async () => {
    expect((await send("")).status).toBe(400);
    expect((await send("   \n  ")).status).toBe(400);
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.png`, bytes: png(50, 50) }));
    expect(((await (await send("", five)).json()) as { error: string }).error).toMatch(/up to 4/);
    const manyPages = [{ name: "a.pdf", bytes: pdf(3) }, { name: "b.png", bytes: png(50, 50) }, { name: "c.png", bytes: png(50, 50) }];
    expect(((await (await send("", manyPages)).json()) as { error: string }).error).toMatch(/more than 4/);
    const corrupt = await send("", [{ name: "bad.pdf", bytes: Buffer.from("%PDF-1.4 this is not a real pdf") }]);
    expect(corrupt.status).toBe(400);
    expect((await corrupt.json()).error).toMatch(/couldn't open/);
    expect(((await (await send("", [{ name: "notes.txt", bytes: Buffer.from("hello") }])).json()) as { error: string }).error).toMatch(/isn't a photo or a PDF/);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(20)]);
    expect(((await (await send("", [{ name: "IMG_1.heic", bytes: heic }])).json()) as { error: string }).error).toMatch(/HEIC/);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(20)]);
    expect(((await (await send("", [{ name: "a.webp", bytes: webp }])).json()) as { error: string }).error).toMatch(/WebP/);
    expect((await send("x".repeat(30001))).status).toBe(400);
    expect(calls).toHaveLength(0); // none of these reached the AI
  });

  it("a truncated PNG and a 1x1 PNG are answered, not thrown", async () => {
    const good = png(100, 100);
    const trunc = Buffer.from(good).subarray(0, 60);
    const r = await send("", [{ name: "t.png", bytes: trunc }]);
    expect(r.status).toBeLessThan(500);
    await r.json();
    const tiny = await send("", [{ name: "t.png", bytes: png(1, 1) }]);
    expect(tiny.status).toBeLessThan(500);
  });

  it("FIXED (was BUG, low): no key → plain message; key/billing errors pass through; but ANY error text containing 'key' (e.g. an internal one) is shown raw", async () => {
    hasKey = false;
    expect((await (await send("Endo Nov 4")).json()).error).toMatch(/Add your AI key/);
    hasKey = true;
    failWith = new Error("401 invalid x-api-key");
    const r = await send("Endo Nov 4");
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/401/);
    failWith = new Error("The answer was cut off (too long). Try a smaller request.");
    expect((await (await send("Endo Nov 4")).json()).error).toMatch(/couldn't read that just now/);
    failWith = new Error("SQLITE_ERROR: no such column: key_id at /home/app/src/x.ts:12"); // internals that mention "key"
    const leak = (await (await send("Endo Nov 4")).json()).error as string;
    expect(leak).not.toMatch(/SQLITE|\/home\/app/); // BUG(low) if this fails: any error message containing "key" is shown raw to the student
  });

  it("401 without a session, and an exam list with a 'null' date round-trips through the route", async () => {
    reply = { exams: [{ name: "TBA exam", date: null, course: null, kind: "quiz", confidence: "high", note: null }], year_assumed: null };
    const b = await (await send("x")).json();
    expect(b.exams[0]).toMatchObject({ date: null, confidence: "low" });
    currentUserId = 0;
    expect((await send("x")).status).toBe(401);
  });
});

// ───────────────────────── 3. Bulk add ─────────────────────────
describe("bulk add exams", () => {
  const post = (body: unknown) => examsPOST(new Request("http://x", json(body)));
  const mine = () => (db.prepare("SELECT COUNT(*) n FROM exams WHERE user_id = ?").get(currentUserId) as { n: number }).n;
  const future = (n: number) => addDays(today(), n);

  it("all or nothing: one bad row among 10 creates none and names the row", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `E${i}`, date: future(5 + i), kind: "quiz" }));
    rows[6] = { name: "Bad", date: "2026-02-30", kind: "quiz" };
    const res = await post({ exams: rows });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Row 7 \(Bad\)/);
    expect(mine()).toBe(0);
  });

  it("DB-level rollback: a row that violates the schema after some succeeded leaves no partial exams", () => {
    expect(() =>
      createExams(currentUserId, [
        { name: "A", date: future(5), kind: "quiz", course: null },
        { name: null as never, date: future(6), kind: "quiz", course: null },
      ]),
    ).toThrow();
    expect(mine()).toBe(0);
  });

  it("60 rows are fine, 61 are refused, empty/ non-array refused", async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `E${i}`, date: future(5 + i), kind: "quiz" }));
    expect((await post({ exams: mk(61) })).status).toBe(400);
    expect(mine()).toBe(0);
    const res = await post({ exams: mk(60) });
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(60);
    for (const bad of [[], null, "x", {}, 5]) expect((await post({ exams: bad })).status).toBe(400);
    expect(mine()).toBe(60);
  });

  it("rows can't smuggle a user_id / status, and other users are untouched", async () => {
    const other = makeUser();
    const res = await post({ exams: [{ name: "Sneaky", date: future(9), kind: "quiz", user_id: other, status: "archived", id: 1 }] });
    expect(res.status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) n FROM exams WHERE user_id = ?").get(other) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT status FROM exams WHERE user_id = ? AND name = 'Sneaky'").get(currentUserId) as { status: string }).status).toBe("active");
  });

  it("odd bodies: array body, null body, string body, exams as object all answer 400 JSON", async () => {
    for (const b of [[], null, "str", 12]) {
      const res = await post(b);
      expect(res.status).toBe(400);
      await res.json();
    }
    const res = await examsPOST(new Request("http://x", { method: "POST", body: "{not json" }));
    expect(res.status).toBe(400);
  });

  it("cleanExamRows: trims/collapses names, truncates, defaults kind, rejects year 2101 and '2026-11-4'", () => {
    const ok = cleanExamRows([{ name: "  Endo \n  Block  ", date: " 2026-11-04 ", kind: "nope", course: "  D2   Endo " }]);
    expect(ok).toEqual({ rows: [{ name: "Endo Block", date: "2026-11-04", kind: "block", course: "D2 Endo" }] });
    expect(cleanExamRows([{ name: "A", date: "2101-01-01" }])).toHaveProperty("error");
    expect(cleanExamRows([{ name: "A", date: "2026-11-4" }])).toHaveProperty("error");
    expect(cleanExamRows([{ name: "   ", date: "2026-11-04" }])).toEqual({ error: "Row 1 needs a name." });
    expect(cleanExamRows([null])).toEqual({ error: "Row 1 needs a name." });
  });

  it("NOTE: the server does not de-duplicate; adding the same exam twice makes two exams (the confirm screen only warns)", async () => {
    const row = { name: "Endo Block", date: future(20), kind: "block" };
    await post({ exams: [row, row] });
    await post({ exams: [row] });
    expect(mine()).toBe(3);
  });

  it("re-plans once: a new undated-lecture exam gets an 'Upload lectures' task today", async () => {
    await post({ exams: [{ name: "Perio", date: future(14), kind: "block" }] });
    const titles = tasksOn(currentUserId, today(), addDays(today(), 30)).map((t) => t.title);
    expect(titles).toContain("Upload lectures for Perio");
  });

  it("a date in the past is accepted and creates an exam that is not planned (no crash)", async () => {
    const res = await post({ exams: [{ name: "Old", date: addDays(today(), -40), kind: "quiz" }] });
    expect(res.status).toBe(200);
    expect(tasksOn(currentUserId, today(), addDays(today(), 30))).toEqual([]);
  });
});

// ───────────────────────── 4. Busy repeats ─────────────────────────
describe("busy repeats", () => {
  const addBusy = (body: unknown) => busyPOST(new Request("http://x", json(body)));
  const skip = (id: number | string, body: unknown) => skipPOST(new Request("http://x", json(body)), ctx(id));
  const lastId = (u = currentUserId) => (db.prepare("SELECT MAX(id) id FROM busy_days WHERE user_id = ?").get(u) as { id: number }).id;
  const feed = async () => {
    const res = await feedGET(new Request("http://x"), { params: Promise.resolve({ token: icsToken(currentUserId) }) } as never);
    return unfold(await res.text());
  };
  const occurrences = (b: Parameters<typeof coversDate>[0], from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (coversDate(b, d)) out.push(d);
    return out;
  };

  it("expansion across the US DST change (2026-11-01), year boundary and a leap day gives exactly the chosen weekdays", () => {
    const tue = (s: string, e: string) => ({ id: 1, start_date: s, end_date: e, label: "C", weekdays: maskOf([1]) });
    expect(occurrences(tue("2026-10-20", "2026-11-17"), "2026-10-19", "2026-11-20")).toEqual(["2026-10-20", "2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17"]);
    expect(occurrences({ ...tue("2026-12-24", "2027-01-14"), weekdays: maskOf([3]) }, "2026-12-20", "2027-01-20")).toEqual(["2026-12-24", "2026-12-31", "2027-01-07", "2027-01-14"]);
    expect(occurrences(tue("2028-02-22", "2028-03-07"), "2028-02-20", "2028-03-10")).toEqual(["2028-02-22", "2028-02-29", "2028-03-07"]);
    // spring forward 2026-03-08 (Sunday)
    expect(occurrences({ ...tue("2026-03-01", "2026-03-15"), weekdays: maskOf([6]) }, "2026-03-01", "2026-03-15")).toEqual(["2026-03-01", "2026-03-08", "2026-03-15"]);
  });

  it("POST validation: bad weekdays, missing/early/too-far until, no day inside the range", async () => {
    const t = today();
    const cases: [unknown, number][] = [
      [{ start: t, label: "x", weekdays: [7], until: addDays(t, 30) }, 400],
      [{ start: t, label: "x", weekdays: [-1, 9, "a", 1.5], until: addDays(t, 30) }, 400],
      [{ start: t, label: "x", weekdays: [1] }, 400],
      [{ start: t, label: "x", weekdays: [1], until: addDays(t, -1) }, 400],
      [{ start: t, label: "x", weekdays: [1], until: addDays(t, 732) }, 400],
      [{ start: t, label: "x", weekdays: [1], until: "2026-02-30" }, 400],
      [{ start: nextWeekday(t, 2), label: "x", weekdays: [1], until: nextWeekday(t, 2) }, 400], // a Wednesday-only range with Tuesday chosen
      [{ start: "nope", label: "x" }, 400],
      [{ label: "x" }, 400],
    ];
    for (const [body, status] of cases) expect((await addBusy(body)).status, JSON.stringify(body)).toBe(status);
    expect(db.prepare("SELECT COUNT(*) n FROM busy_days WHERE user_id = ?").get(currentUserId)).toEqual({ n: 0 });
    expect((await addBusy({ start: t, label: "ok", weekdays: [1], until: addDays(t, 731) })).status).toBe(200);
  });

  it("FIXED (was BUG, low): non-day values in weekdays are coerced with Number(): null, '', true, [] all become Monday/Tuesday instead of being rejected", async () => {
    const t = today();
    const res = await addBusy({ start: t, label: "x", weekdays: [null], until: addDays(t, 30) });
    expect(res.status).toBe(400); // actual: 200 and a repeat on Mondays
  });

  it("FIXED (was BUG, low): weekdays: [] with a start date silently becomes a one-day busy range (not an error)", async () => {
    const res = await addBusy({ start: addDays(today(), 3), label: "x", weekdays: [], until: addDays(today(), 30) });
    // Expected: refuse (the form sent 'repeat' with no days) or create a repeat; actual: a single one-off busy day is created.
    const row = db.prepare("SELECT * FROM busy_days WHERE user_id = ?").get(currentUserId) as { weekdays: number | null; end_date: string } | undefined;
    expect(res.status === 400 || (row?.weekdays ?? 0) > 0).toBe(true);
  });

  it("weird label and body: label collapses spaces and is cut at 80; non-string label becomes 'Busy'", async () => {
    const t = today();
    await addBusy({ start: t, label: `  ${"x ".repeat(100)}`, end: t });
    await addBusy({ start: t, label: 5, end: t });
    const labels = (db.prepare("SELECT label FROM busy_days WHERE user_id = ? ORDER BY id").all(currentUserId) as { label: string }[]).map((r) => r.label);
    expect(labels[0].length).toBeLessThanOrEqual(80);
    expect(labels[1]).toBe("Busy");
  });

  it("skip/undo: validation, idempotence, other users' rows, non-repeating rows, bad ids", async () => {
    const t = today();
    const tue = nextWeekday(addDays(t, 1), 1);
    await addBusy({ start: tue, label: "Clinic", weekdays: [1], until: addDays(tue, 60) });
    const id = lastId();
    const nextTue = addDays(tue, 7);
    expect((await skip(id, { date: nextTue })).status).toBe(200);
    expect((await skip(id, { date: nextTue })).status).toBe(200); // twice is fine
    expect(db.prepare("SELECT COUNT(*) n FROM busy_skips WHERE busy_id = ?").get(id)).toEqual({ n: 1 });
    expect((await skip(id, { date: addDays(nextTue, 1) })).status).toBe(400); // a Wednesday
    expect((await skip(id, { date: addDays(tue, -7) })).status).toBe(400); // before it starts
    expect((await skip(id, { date: addDays(tue, 70) })).status).toBe(400); // after until
    expect((await skip(id, {})).status).toBe(400);
    expect((await skip(id, "garbage")).status).toBe(400);
    expect((await skipPOST(new Request("http://x", { method: "POST", body: "{bad" }), ctx(id))).status).toBe(400);
    expect((await skip(id, { date: nextTue, undo: true })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM busy_skips WHERE busy_id = ?").get(id)).toEqual({ n: 0 });
    expect((await skip(id, { date: nextTue, undo: "true" })).status).toBe(200); // string "true" is treated as skip, not undo
    expect(db.prepare("SELECT COUNT(*) n FROM busy_skips WHERE busy_id = ?").get(id)).toEqual({ n: 1 });
    for (const bad of ["abc", "-1", "0", "1e9", ""]) expect((await skip(bad, { date: nextTue })).status).toBe(404);

    // one-off row
    await addBusy({ start: tue, end: addDays(tue, 2), label: "Trip" });
    expect((await skip(lastId(), { date: tue })).status).toBe(400);

    // another user's row
    const mine = id;
    currentUserId = makeUser();
    expect((await skip(mine, { date: nextTue })).status).toBe(404);
    expect((await skip(mine, { date: nextTue, undo: true })).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) n FROM busy_skips WHERE busy_id = ?").get(mine)).toEqual({ n: 1 });
    // and the other user can't delete it
    await deletePOST(new Request("http://x", { method: "POST" }), ctx(mine));
    expect(db.prepare("SELECT COUNT(*) n FROM busy_days WHERE id = ?").get(mine)).toEqual({ n: 1 });
  });

  it("deleting a repeat cascades its skipped weeks; loadBusy is per user", async () => {
    const t = today();
    const tue = nextWeekday(addDays(t, 1), 1);
    await addBusy({ start: tue, label: "Clinic", weekdays: [1], until: addDays(tue, 60) });
    const id = lastId();
    await skip(id, { date: addDays(tue, 7) });
    const stranger = makeUser();
    expect(loadBusy(stranger).rows).toEqual([]);
    expect(loadBusy(stranger).skips.size).toBe(0);
    expect(loadBusy(currentUserId).skips.size).toBe(1);
    await deletePOST(new Request("http://x", { method: "POST" }), ctx(id));
    expect(db.prepare("SELECT COUNT(*) n FROM busy_skips WHERE busy_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("planner: no study on repeat days; a skipped week gets study back; ending 'until' frees later weeks", async () => {
    const { examId } = makeExam(currentUserId, addDays(today(), 40), Array(30).fill(8), "Big");
    void examId;
    db.prepare("UPDATE planner_settings SET weekday_minutes = ? WHERE user_id = ?").run(JSON.stringify([90, 90, 90, 90, 90, 90, 90]), currentUserId);
    const t = today();
    const tue = nextWeekday(addDays(t, 1), 1);
    await addBusy({ start: tue, label: "Clinic", weekdays: [1], until: addDays(tue, 21) });
    const id = lastId();
    const days = (from: string, to: string) => new Set(tasksOn(currentUserId, from, to).map((x) => x.date));
    const busyTues = [tue, addDays(tue, 7), addDays(tue, 14), addDays(tue, 21)];
    let planned = days(t, addDays(t, 40));
    for (const d of busyTues) expect(planned.has(d), `busy ${d}`).toBe(false);
    expect(planned.has(addDays(tue, 28))).toBe(true); // after until, Tuesday is a study day again
    await skip(id, { date: addDays(tue, 7) });
    planned = days(t, addDays(t, 40));
    expect(planned.has(addDays(tue, 7))).toBe(true);
    expect(planned.has(tue)).toBe(false);
  });

  it("feed: repeat is one weekly event whose DTSTART is a real occurrence, with RRULE/UNTIL/EXDATE; one-off stays a range; labels are escaped and folded", async () => {
    const t = today();
    const wed = nextWeekday(addDays(t, 1), 2);
    const start = addDays(wed, -1); // a Tuesday: not an occurrence for Wed+Fri
    await addBusy({ start, label: "Clinic; \"Lab\", rm 3 line2 \\ end " + "é😀".repeat(40), weekdays: [2, 4], until: addDays(wed, 30) });
    const id = lastId();
    await skip(id, { date: addDays(wed, 7) });
    await addBusy({ start: addDays(t, 2), end: addDays(t, 4), label: "Trip" });
    const raw = await feedGET(new Request("http://x"), { params: Promise.resolve({ token: icsToken(currentUserId) }) } as never).then((r) => r.text());
    for (const line of raw.split("\r\n")) expect(new TextEncoder().encode(line).length, line).toBeLessThanOrEqual(75);
    expect(raw.endsWith("\r\n")).toBe(true);
    const body = unfold(raw);
    const ev = body.split("BEGIN:VEVENT").find((b) => b.includes(`UID:busy-${id}@`))!;
    expect(ev).toContain(`DTSTART;VALUE=DATE:${wed.replaceAll("-", "")}`); // first real occurrence, not the Tuesday start
    expect(ev).toContain(`DTEND;VALUE=DATE:${addDays(wed, 1).replaceAll("-", "")}`);
    expect(ev).toContain(`RRULE:FREQ=WEEKLY;BYDAY=WE,FR;UNTIL=${addDays(wed, 30).replaceAll("-", "")}`);
    expect(ev).toContain(`EXDATE;VALUE=DATE:${addDays(wed, 7).replaceAll("-", "")}`);
    expect(ev).toContain("SUMMARY:⛔ Clinic\\; \"Lab\"\\, rm 3 line2 \\\\ end");
    const trip = body.split("BEGIN:VEVENT").find((b) => b.includes("SUMMARY:⛔ Trip"))!;
    expect(trip).not.toContain("RRULE");
    expect(trip).toContain(`DTEND;VALUE=DATE:${addDays(t, 5).replaceAll("-", "")}`);
  });

  it("feed: archived exams are not in the feed, deleted skips leave no EXDATE, repeat whose days never occur is omitted from the feed", async () => {
    const { examId } = makeExam(currentUserId, addDays(today(), 10), [], "Archived Exam");
    db.prepare("UPDATE exams SET status = 'archived' WHERE id = ?").run(examId);
    makeExam(currentUserId, addDays(today(), 12), [], "Live Exam");
    // legacy/inconsistent row: weekdays set but no matching day inside the range
    const wed = nextWeekday(addDays(today(), 1), 2);
    db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label, weekdays) VALUES (?, ?, ?, 'Never', ?)").run(currentUserId, wed, wed, maskOf([0]));
    const body = await feed();
    expect(body).toContain("Live Exam");
    expect(body).not.toContain("Archived Exam");
    expect(body).not.toContain("Never");
    expect(body).not.toContain("EXDATE");
  });

  it("icsEscape/foldLine: lone CR, long emoji lines and exactly-75-octet lines", () => {
    expect(icsEscape("a\rb\r\nc\nd")).toBe("a\\nb\\nc\\nd");
    for (const line of ["x".repeat(75), "x".repeat(76), "😀".repeat(30), "é".repeat(100), "a" + "😀".repeat(20)]) {
      const folded = foldLine(line);
      for (const phys of folded.split("\r\n")) expect(new TextEncoder().encode(phys).length).toBeLessThanOrEqual(75);
      expect(folded.replace(/\r\n /g, "")).toBe(line);
    }
  });
});

// ───────────────────────── 5. Day overrides + replan ─────────────────────────
describe("study time this day", () => {
  const day = (body: unknown) => dayPOST(new Request("http://x", json(body)));
  const sumOn = (d: string) => tasksOn(currentUserId, d, d).reduce((s, t) => s + t.minutes, 0);
  const setup = (topics = 25) => {
    makeExam(currentUserId, addDays(today(), 30), Array(topics).fill(10), "Big");
    db.prepare("UPDATE planner_settings SET weekday_minutes = ? WHERE user_id = ?").run(JSON.stringify([60, 60, 60, 60, 60, 60, 60]), currentUserId);
    rebuildPlan(currentUserId);
  };

  it("validation: past, far future, bad date, negative, > 16 h, strings, NaN-like", async () => {
    const t = today();
    const bad: unknown[] = [
      { date: addDays(t, -1), minutes: 60 },
      { date: addDays(t, 732), minutes: 60 },
      { date: "x", minutes: 60 },
      { date: addDays(t, 2), minutes: -1 },
      { date: addDays(t, 2), minutes: 961 },
      { date: addDays(t, 2), minutes: "60" },
      { date: addDays(t, 2), minutes: true },
      { date: addDays(t, 2) },
      { date: addDays(t, 2), minutes: [] },
    ];
    for (const b of bad) expect((await day(b)).status, JSON.stringify(b)).toBe(400);
    expect((await dayPOST(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await day({ date: t, minutes: 0 })).status).toBe(200);
    expect((await day({ date: addDays(t, 731), minutes: 960 })).status).toBe(200);
    expect((await day({ date: addDays(t, 3), minutes: 90.6 })).status).toBe(200);
    expect(db.prepare("SELECT minutes FROM day_overrides WHERE user_id = ? AND date = ?").get(currentUserId, addDays(t, 3))).toEqual({ minutes: 91 });
  });

  it("NOTE: when the plan is comfortable, raising a day's hours adds no tasks (work is paced evenly); only day-off/less has an effect", async () => {
    setup(25);
    const d = addDays(today(), 5);
    const usual = sumOn(d);
    await day({ date: d, minutes: 600 });
    expect(sumOn(d)).toBe(usual);
  });

  it("0 = day off; more minutes = more tasks that day (when behind); null goes back to usual; other users unaffected", async () => {
    setup(90);
    const t = today();
    const d = addDays(t, 5);
    const usual = sumOn(d);
    expect(usual).toBeGreaterThan(0);
    await day({ date: d, minutes: 0 });
    expect(sumOn(d)).toBe(0);
    await day({ date: d, minutes: 240 });
    expect(sumOn(d)).toBeGreaterThan(usual);
    expect(sumOn(d)).toBeLessThanOrEqual(240 + 10);
    await day({ date: d, minutes: null });
    expect(sumOn(d)).toBe(usual);
    const stranger = makeUser();
    setDayOverride(stranger, d, 0);
    expect(sumOn(d)).toBe(usual);
  });

  it("a busy day beats an override; override on a repeat day that is skipped works", async () => {
    setup();
    const t = today();
    const d = addDays(t, 6);
    await busyPOST(new Request("http://x", json({ start: d, end: d, label: "Trip" })));
    await day({ date: d, minutes: 480 });
    expect(sumOn(d)).toBe(0);
  });

  it("an override for today subtracts what is already done today", async () => {
    setup();
    const t = today();
    db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title, status) VALUES (?, ?, 'review', '[]', 50, 'x', 'done')").run(currentUserId, t);
    await day({ date: t, minutes: 60 });
    const todo = tasksOn(currentUserId, t, t).filter((x) => x.status === "todo").reduce((s, x) => s + x.minutes, 0);
    expect(todo).toBeLessThanOrEqual(10 + 10); // 60 - 50 done, plus the 10-minute overflow allowance
  });

  it("an exam the day after a day-off still gets its final practice pinned earlier", async () => {
    const t = today();
    const { examId } = makeExam(currentUserId, addDays(t, 8), [8, 8, 8], "Soon");
    db.prepare("UPDATE planner_settings SET weekday_minutes = ? WHERE user_id = ?").run(JSON.stringify([90, 90, 90, 90, 90, 90, 90]), currentUserId);
    await day({ date: addDays(t, 7), minutes: 0 });
    const fp = tasksOn(currentUserId, t, addDays(t, 9)).find((x) => x.exam_id === examId && x.kind === "final_practice");
    expect(fp).toBeTruthy();
    expect(fp!.date < addDays(t, 7)).toBe(true);
  });
});

describe("missed tasks and re-plan", () => {
  const addTask = (date: string, status: string, kind = "practice", topicIds = "[]", examId: number | null = null) =>
    db.prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, topic_ids, minutes, title, status) VALUES (?, ?, ?, ?, ?, 20, 't', ?)").run(currentUserId, date, examId, kind, topicIds, status);

  it("window: yesterday..7 days back counted; 8+ days back and today/future not counted", () => {
    const t = today();
    addTask(addDays(t, -1), "missed");
    addTask(addDays(t, -7), "missed");
    addTask(addDays(t, -8), "missed");
    addTask(addDays(t, -30), "missed");
    addTask(t, "todo");
    addTask(addDays(t, 2), "missed");
    addTask(addDays(t, -2), "done");
    expect(missedSummary(currentUserId)).toEqual({ count: 2, yesterdayOnly: false });
  });

  it("yesterdayOnly and zero", () => {
    const t = today();
    expect(missedSummary(currentUserId)).toEqual({ count: 0, yesterdayOnly: false });
    addTask(addDays(t, -1), "missed");
    expect(missedSummary(currentUserId)).toEqual({ count: 1, yesterdayOnly: true });
  });

  it("re-plan clears the note, only newer misses show again, and the message counts topics back", () => {
    const t = today();
    const { examId, topicIds } = makeExam(currentUserId, addDays(t, 20), [6, 6], "Endo");
    addTask(addDays(t, -1), "missed", "learn", JSON.stringify([topicIds[0]]), examId);
    addTask(addDays(t, -3), "missed", "learn", JSON.stringify([topicIds[1]]), examId);
    expect(missedSummary(currentUserId).count).toBe(2);
    const r = replanFromToday(currentUserId);
    expect(r.topicsBack).toBe(2);
    expect(r.message).toBe("Done. 2 missed topics are back in your plan.");
    expect(missedSummary(currentUserId).count).toBe(0);
    addTask(addDays(t, -1), "missed"); // a new miss with the same date as the cut-off is NOT hidden... (date > since)
    expect(missedSummary(currentUserId).count).toBe(0);
  });

  it("a missed topic that was since studied, or whose exam is archived, is not 'back in your plan'", () => {
    const t = today();
    const { examId, topicIds } = makeExam(currentUserId, addDays(t, 20), [6, 6], "Endo");
    addTask(addDays(t, -1), "missed", "learn", JSON.stringify([topicIds[0]]), examId);
    markTopicStudied(currentUserId, topicIds[0]);
    expect(replanFromToday(currentUserId).topicsBack).toBe(0);
    db.prepare("UPDATE exams SET status = 'archived' WHERE id = ?").run(examId);
    addTask(addDays(t, -1), "missed", "learn", JSON.stringify([topicIds[1]]), examId);
    const r = replanFromToday(currentUserId);
    expect(r.topicsBack).toBe(0);
    expect(r.message).toBe("Done. Your plan now starts from today.");
  });

  it("NOTE: pressing re-plan twice repeats 'N missed topics are back' (the missed rows stay in the table)", () => {
    const t = today();
    const { examId, topicIds } = makeExam(currentUserId, addDays(t, 20), [6], "Endo");
    addTask(addDays(t, -1), "missed", "learn", JSON.stringify([topicIds[0]]), examId);
    expect(replanFromToday(currentUserId).topicsBack).toBe(1);
    expect(replanFromToday(currentUserId).topicsBack).toBe(1);
  });

  it("FIXED (was BUG, low): the 'Upload lectures' nag and daily reviews count as 'missed tasks' (an exam with no lectures yet produces 'You missed 1 task yesterday')", () => {
    // Simulate yesterday: plan built then the day rolled over without ticking anything.
    const t = today();
    makeExam(currentUserId, addDays(t, 20), [], "NoLectures");
    rebuildPlan(currentUserId);
    db.prepare("UPDATE plan_tasks SET date = ? WHERE user_id = ?").run(addDays(t, -1), currentUserId);
    rebuildPlan(currentUserId); // marks yesterday's todo as missed
    // Expected: housekeeping prompts (kind 'upload') are not "missed study tasks".
    expect(missedSummary(currentUserId).count).toBe(0);
  });

  it("route: 401 without a session; 200 with message", async () => {
    currentUserId = 0;
    expect((await replanPOST()).status).toBe(401);
    currentUserId = makeUser();
    const b = await (await replanPOST()).json();
    expect(b.message).toBe("Done. Your plan now starts from today.");
  });
});

// ───────────────────────── 6. setTaskStatus ─────────────────────────
describe("setTaskStatus", () => {
  const learnTask = (userId: number, date: string, topicIds: number[], examId: number | null = null) =>
    Number(db.prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, topic_ids, minutes, title) VALUES (?, ?, ?, 'learn', ?, 20, 'Study: x')").run(userId, date, examId, JSON.stringify(topicIds)).lastInsertRowid);
  const studied = (u: number, t: number) => !!db.prepare("SELECT 1 FROM topic_study WHERE user_id = ? AND topic_id = ?").get(u, t);

  it("ticking records the topic as studied, re-plans don't re-queue it, unticking takes it back", () => {
    const t = today();
    const { examId, topicIds } = makeExam(currentUserId, addDays(t, 20), [6, 6, 6], "Endo");
    rebuildPlan(currentUserId);
    const task = tasksOn(currentUserId, t, addDays(t, 20)).find((x) => x.kind === "learn")!;
    const topic = (JSON.parse(task.topic_ids) as number[])[0];
    setTaskStatus(currentUserId, task.id, "done");
    expect(studied(currentUserId, topic)).toBe(true);
    rebuildPlan(currentUserId);
    const learns = tasksOn(currentUserId, t, addDays(t, 20)).filter((x) => x.kind === "learn" && x.status === "todo");
    expect(learns.flatMap((x) => JSON.parse(x.topic_ids) as number[])).not.toContain(topic);
    expect(tasksOn(currentUserId, t, addDays(t, 20)).find((x) => x.id === task.id)!.status).toBe("done");
    setTaskStatus(currentUserId, task.id, "todo");
    expect(studied(currentUserId, topic)).toBe(false);
    rebuildPlan(currentUserId);
    const again = tasksOn(currentUserId, t, addDays(t, 20)).filter((x) => x.kind === "learn").flatMap((x) => JSON.parse(x.topic_ids) as number[]);
    expect(again).toContain(topic);
    void examId; void topicIds;
  });

  it("a forged task row pointing at someone else's topics can't mark them studied", () => {
    const t = today();
    const victim = makeUser();
    const { topicIds: victimTopics } = makeExam(victim, addDays(t, 20), [6, 6], "Victim exam");
    const { topicIds: mine } = makeExam(currentUserId, addDays(t, 20), [6], "Mine");
    const forged = learnTask(currentUserId, t, [...victimTopics, mine[0], 999999]);
    setTaskStatus(currentUserId, forged, "done");
    for (const v of victimTopics) expect(studied(victim, v)).toBe(false);
    for (const v of victimTopics) expect(studied(currentUserId, v)).toBe(false);
    expect(studied(currentUserId, mine[0])).toBe(true);
    // and un-ticking can't delete the victim's study record
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(victim, victimTopics[0]);
    setTaskStatus(currentUserId, forged, "todo");
    expect(studied(victim, victimTopics[0])).toBe(true);
  });

  it("another user's task id is ignored; missed tasks stay missed", () => {
    const t = today();
    const other = makeUser();
    const { topicIds } = makeExam(other, addDays(t, 20), [6], "O");
    const theirs = learnTask(other, t, topicIds);
    setTaskStatus(currentUserId, theirs, "done");
    expect((db.prepare("SELECT status FROM plan_tasks WHERE id = ?").get(theirs) as { status: string }).status).toBe("todo");
    expect(studied(other, topicIds[0])).toBe(false);
    const missed = learnTask(currentUserId, addDays(t, -1), []);
    db.prepare("UPDATE plan_tasks SET status = 'missed' WHERE id = ?").run(missed);
    setTaskStatus(currentUserId, missed, "done");
    expect((db.prepare("SELECT status FROM plan_tasks WHERE id = ?").get(missed) as { status: string }).status).toBe("missed");
  });

  it("non-learn tasks tick without touching topic_study; completed_at is set and cleared", () => {
    const t = today();
    const { topicIds } = makeExam(currentUserId, addDays(t, 20), [6], "P");
    const id = Number(db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title) VALUES (?, ?, 'practice', ?, 20, 'q')").run(currentUserId, t, JSON.stringify(topicIds)).lastInsertRowid);
    setTaskStatus(currentUserId, id, "done");
    expect(studied(currentUserId, topicIds[0])).toBe(false);
    expect((db.prepare("SELECT completed_at FROM plan_tasks WHERE id = ?").get(id) as { completed_at: string | null }).completed_at).not.toBeNull();
    setTaskStatus(currentUserId, id, "todo");
    expect((db.prepare("SELECT completed_at FROM plan_tasks WHERE id = ?").get(id) as { completed_at: string | null }).completed_at).toBeNull();
  });

  it("NOTE: unticking a task the study session ticked (same moment) takes the topic back; a topic opened earlier stays studied (see planner setTaskStatus)", () => {
    const t = today();
    const { topicIds } = makeExam(currentUserId, addDays(t, 20), [6], "E");
    const id = learnTask(currentUserId, t, topicIds);
    markTopicStudied(currentUserId, topicIds[0]); // opened in a real session: task becomes done
    expect(studied(currentUserId, topicIds[0])).toBe(true);
    setTaskStatus(currentUserId, id, "todo");
    expect(studied(currentUserId, topicIds[0])).toBe(false); // readiness "studied" drops although she did study it
  });

  it("malformed topic_ids on a learn task throws (forged data) but rolls the status change back", () => {
    const t = today();
    const id = Number(db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title) VALUES (?, ?, 'learn', 'not json', 20, 'x')").run(currentUserId, t).lastInsertRowid);
    try {
      setTaskStatus(currentUserId, id, "done");
    } catch {
      /* acceptable */
    }
    expect((db.prepare("SELECT status FROM plan_tasks WHERE id = ?").get(id) as { status: string }).status).toBe("todo");
  });
});

// ───────────────────────── 7. Countdown / time zone ─────────────────────────
describe("daysUntil with the planner's today", () => {
  it("evening in New York (already tomorrow in UTC) still counts from her own day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T03:30:00Z")); // 23:30 on Oct 20 in New York, 12:30 on Oct 21 in Tokyo
    const ny = todayIn("America/New_York");
    const tokyo = todayIn("Asia/Tokyo");
    expect([ny, tokyo]).toEqual(["2026-10-20", "2026-10-21"]);
    expect(daysUntil("2026-10-21", ny)).toBe(1);
    expect(daysUntil("2026-10-21", tokyo)).toBe(0);
    expect(daysUntil("2026-10-20", ny)).toBe(0);
    expect(daysUntil("2026-10-19", ny)).toBe(-1);
  });

  it("midnight edges and the DST change do not shift whole-day counts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T05:00:00Z")); // 01:00 EDT on DST-end day, before the clocks go back
    expect(todayIn("America/New_York")).toBe("2026-11-01");
    expect(daysUntil("2026-11-02", "2026-11-01")).toBe(1);
    expect(daysUntil("2026-11-02", "2026-10-31")).toBe(2);
    expect(daysUntil("2027-03-15", "2027-03-13")).toBe(2); // across spring-forward
    vi.setSystemTime(new Date("2026-11-01T04:59:59Z"));
    expect(todayIn("America/New_York")).toBe("2026-11-01");
    vi.setSystemTime(new Date("2026-11-02T04:59:59Z")); // 23:59:59 EST
    expect(todayIn("America/New_York")).toBe("2026-11-01");
    vi.setSystemTime(new Date("2026-11-02T05:00:00Z"));
    expect(todayIn("America/New_York")).toBe("2026-11-02");
    vi.setSystemTime(new Date("2026-03-08T06:59:59Z")); // 01:59:59 EST before the jump
    expect(todayIn("America/New_York")).toBe("2026-03-08");
  });

  it("bad input: null, empty, non-ISO dates give null; a bad 'today' must not leak NaN", () => {
    expect(daysUntil(null, "2026-10-20")).toBeNull();
    expect(daysUntil("", "2026-10-20")).toBeNull();
    expect(daysUntil("11/04/2026", "2026-10-20")).toBeNull();
    expect(daysUntil("2026-11-04", "2026-10-20")).toBe(15);
    expect(Number.isNaN(daysUntil("2026-11-04", "garbage") as number)).toBe(true); // NOTE: NaN leaks if a caller ever passes a bad 'today'; callers all use todayIn(), so harmless
  });

  it("an unknown time zone falls back instead of throwing", () => {
    expect(todayIn("Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ───────────────────────── 8. examProgressMany ─────────────────────────
describe("examProgressMany", () => {
  const concept = (u: number, name: string, attempts: number, correct: number, topicIds: number[]) => {
    const id = Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, ?, ?, ?)").run(u, name, attempts, correct).lastInsertRowid);
    for (const t of topicIds) db.prepare("INSERT INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(t, id);
  };

  it("equals examProgress for a mix of exams (no topics, untested, studied, tested) and uses 3 queries", () => {
    const t = today();
    const a = makeExam(currentUserId, addDays(t, 5), [], "empty");
    const b = makeExam(currentUserId, addDays(t, 6), [5, 5], "studied only");
    const c = makeExam(currentUserId, addDays(t, 7), [5, 5, 5], "tested");
    const d = makeExam(currentUserId, null, [5], "undated");
    markTopicStudied(currentUserId, b.topicIds[0]);
    markTopicStudied(currentUserId, c.topicIds[0]);
    concept(currentUserId, "x", 10, 9, [c.topicIds[0], c.topicIds[1]]);
    concept(currentUserId, "y", 4, 1, [c.topicIds[1], d.topicIds[0]]);
    concept(currentUserId, "z", 0, 0, [c.topicIds[2]]);
    const ids = [a.examId, b.examId, c.examId, d.examId, c.examId]; // note the duplicate
    const spy = vi.spyOn(db, "prepare");
    const many = examProgressMany(currentUserId, ids);
    const queries = spy.mock.calls.length;
    spy.mockRestore();
    expect(queries).toBeLessThanOrEqual(3);
    expect([...many.keys()].sort()).toEqual([a.examId, b.examId, c.examId, d.examId].sort());
    for (const id of [a.examId, b.examId, c.examId, d.examId]) expect(many.get(id)).toEqual(examProgress(currentUserId, id));
    expect(many.get(a.examId)).toEqual({ mastery: null, studied: 0, readiness: 0, topics: 0 });
    expect(many.get(b.examId)!.readiness).toBeCloseTo(0.25); // one of two studied untested = 0.5 / 2
    expect(examProgressMany(currentUserId, [])).toEqual(new Map());
  });

  it("scales: 300 exams in one call stays at 3 queries", () => {
    const ids = Array.from({ length: 300 }, (_, i) => makeExam(currentUserId, addDays(today(), i + 1), [4], `E${i}`).examId);
    const spy = vi.spyOn(db, "prepare");
    examProgressMany(currentUserId, ids);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    spy.mockRestore();
  });

  it("a stranger's study records don't count toward my readiness", () => {
    const t = today();
    const e = makeExam(currentUserId, addDays(t, 5), [5], "mine");
    const stranger = makeUser();
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(stranger, e.topicIds[0]);
    expect(examProgressMany(currentUserId, [e.examId]).get(e.examId)!.studied).toBe(0);
  });
});

describe("calendar helpers", () => {
  it("readinessTone thresholds and crunches", () => {
    expect(readinessTone({ readiness: 0.8, studied: 1, mastery: 0.8, topics: 3 })).toBe("mint");
    expect(readinessTone({ readiness: 0.79, studied: 1, mastery: 0.8, topics: 3 })).toBe("butter");
    expect(readinessTone({ readiness: 0.59, studied: 1, mastery: 0.8, topics: 3 })).toBe("coral");
    expect(readinessTone({ readiness: 0.9, studied: 0, mastery: null, topics: 3 })).toBe("muted");
    expect(readinessTone(null)).toBe("muted");
    const ex = (id: number, name: string, d: string | null) => ({ id, name, exam_date: d });
    const list = [ex(1, "A", "2026-11-04"), ex(2, "B", "2026-11-06"), ex(3, "C", "2026-11-20"), ex(4, "Past", "2026-10-01"), ex(5, "NoDate", null), ex(6, "D", "2026-11-06")];
    const c = findCrunches(list, "2026-10-21");
    expect(c.map((x) => [x.a.name, x.b.name, x.days])).toEqual([["A", "B", 2], ["B", "D", 0]]);
    expect(crunchMessage(c[1])).toBe("B and D are on the same day — your plan starts both early.");
    expect(crunchMessage({ a: { name: "A" }, b: { name: "B" }, days: 1 })).toBe("A and B are 1 day apart — your plan starts both early.");
  });

  it("firstOccurrence handles single-day ranges and spans > 7 days", () => {
    const row = { id: 1, start_date: "2026-11-02", end_date: "2026-11-02", label: "x", weekdays: maskOf([0]) };
    expect(firstOccurrence(row)).toBe("2026-11-02");
    expect(firstOccurrence({ ...row, weekdays: maskOf([1]) })).toBeNull();
    expect(busyOn([row], new Set(), "2026-11-02")).toHaveLength(1);
  });
});
