// Wave 1, agent B: request handling outside the AI paths, uploads and backups (audit S4, S5, S6, S7, S8, S12, R10).
import fs from "fs";
import path from "path";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ id: 0, admin: false }));
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (who.id ? { id: who.id } : null),
  apiAdmin: async () => (who.id && who.admin ? { id: who.id, is_admin: 1 } : null),
  requireUser: async () => ({ id: who.id }),
}));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
const redirects = vi.hoisted(() => [] as string[]);
vi.mock("next/navigation", () => ({ redirect: (to: string) => void redirects.push(to) }));

// The backup bucket: every command is recorded; `failOn` makes the first command of that kind throw.
const bucket = vi.hoisted(() => ({ sent: [] as { kind: string; key?: string }[], failOn: null as string | null }));
vi.mock("@/lib/s3", () => ({
  backupConfigured: () => true,
  s3: () => ({
    bucket: "test",
    client: {
      send: async (cmd: { constructor: { name: string }; input: { Key?: string } }) => {
        const kind = cmd.constructor.name;
        if (bucket.failOn === kind) throw new Error("bucket unreachable");
        bucket.sent.push({ kind, key: cmd.input.Key });
        return kind === "ListObjectsV2Command" ? { Contents: [] } : {};
      },
    },
  }),
}));
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), generate: vi.fn(async () => ({ exams: [], year_assumed: null })) }));

import { DATA_DIR, db, FILES_DIR } from "@/lib/db";
import { addReviewCard } from "@/lib/practice";
import { joinClass } from "@/lib/classes";
import { addDays, plannerSettings, rebuildPlan, tasksOn, todayIn } from "@/lib/planner";
import { imageDimensions, imageToJpeg, MAX_RENDER_PIXELS, openPdf, PageShapeError, pictureRefusal, renderPage, renderScale } from "@/lib/pdf";
import { isKeyProblem as scheduleIsKeyProblem } from "@/lib/scheduleImport";
import { isKeyProblem } from "@/lib/http";
import { createReport } from "@/lib/reports";
import { deleteReportedFilesForUser, saveReportedQuestion } from "@/lib/reportedQuestions";
import { runBackup } from "@/lib/backup";
import { createExam, updateExam } from "@/app/actions";
import { POST as answerPOST } from "@/app/api/attempts/[id]/answer/route";
import { POST as attemptReportPOST } from "@/app/api/attempts/[id]/report/route";
import { GET as attemptGET } from "@/app/api/attempts/[id]/route";
import { POST as classesPOST } from "@/app/api/classes/route";
import { POST as joinPOST } from "@/app/api/classes/join/route";
import { POST as sharePOST } from "@/app/api/classes/[id]/share/route";
import { POST as settingsPOST } from "@/app/api/planner/settings/route";
import { POST as taskPOST } from "@/app/api/planner/tasks/[id]/route";
import { POST as reviewCardPOST } from "@/app/api/review/[cardId]/route";
import { GET as reviewGET } from "@/app/api/review/route";
import { PUT as marksPUT } from "@/app/api/marks/route";
import { POST as busyPOST } from "@/app/api/calendar/busy/route";
import { POST as skipPOST } from "@/app/api/calendar/busy/[id]/skip/route";
import { POST as examsPOST } from "@/app/api/calendar/exams/route";
import { POST as readPOST } from "@/app/api/calendar/import/read/route";
import { POST as reportsPOST } from "@/app/api/reports/route";
import { POST as uploadPOST } from "@/app/api/exams/[id]/upload/route";
import { GET as reportedExportGET } from "@/app/api/admin/reported-questions/route";
import { makeExam, makeUser } from "./helpers";

const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id), cardId: String(id) }) }) as never;
const req = (body: string | undefined, method = "POST") => new Request("http://x/api", { method, body });
// Every malformed body a route has to survive: nothing, not JSON, JSON null, an array, a string, and an object with the
// wrong field types.
const BAD = [undefined, "{nope", "null", "[1,2]", '"text"', "42"];

async function expectJson4xx(res: Response) {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(res.headers.get("content-type")).toMatch(/json/);
  expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
}

function signIn(admin = false) {
  who.id = makeUser();
  who.admin = admin;
  return who.id;
}

function question(examId: number) {
  return Number(
    db
      .prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (?, 'recall', 'Q?', ?, 0, 'because')")
      .run(examId, JSON.stringify(["a", "b", "c", "d"])).lastInsertRowid,
  );
}

function pdfOf(pages: [number, number][]): Buffer {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
  for (const [w, h] of pages) doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, font, "BT /F1 12 Tf 10 10 Td (x) Tj ET"));
  return Buffer.from(doc.saveToBuffer("").asUint8Array());
}

beforeEach(() => {
  redirects.length = 0;
  bucket.sent.length = 0;
  bucket.failOn = null;
});

describe("S6: malformed bodies get a JSON 4xx, never a throw", () => {
  it("attempts/[id]/answer and attempts/[id]/report", async () => {
    const u = signIn();
    const { examId } = makeExam(u, null);
    const q = question(examId);
    const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(examId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 0)").run(attemptId, q);
    for (const body of [...BAD, JSON.stringify({ questionId: String(q), chosen: 0 }), JSON.stringify({ questionId: q, chosen: "1" })]) {
      await expectJson4xx(await answerPOST(req(body), ctx(attemptId)));
    }
    for (const body of [...BAD, JSON.stringify({ questionId: String(q) })]) await expectJson4xx(await attemptReportPOST(req(body), ctx(attemptId)));
    // Nothing was recorded; a good body still works.
    expect((db.prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ?").get(attemptId) as { chosen_index: number | null }).chosen_index).toBeNull();
    expect((await answerPOST(req(JSON.stringify({ questionId: q, chosen: 1, confidence: "sure" })), ctx(attemptId))).status).toBe(200);
    expect((db.prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ?").get(attemptId) as { chosen_index: number | null }).chosen_index).toBe(1);
  });

  it("classes, classes/join, classes/[id]/share", async () => {
    const u = signIn();
    for (const body of [...BAD, JSON.stringify({ name: 42 }), JSON.stringify({ name: "   " })]) await expectJson4xx(await classesPOST(req(body)));
    for (const body of [...BAD, JSON.stringify({ code: 42 }), JSON.stringify({ code: ["ABC"] }), JSON.stringify({ code: "" })]) await expectJson4xx(await joinPOST(req(body)));
    const res = await classesPOST(req(JSON.stringify({ name: "  Perio crew  " })));
    const { id: classId } = (await res.json()) as { id: number };
    expect((db.prepare("SELECT name FROM classes WHERE id = ?").get(classId) as { name: string }).name).toBe("Perio crew");
    for (const body of [...BAD, JSON.stringify({ examId: "1" }), JSON.stringify({ examId: 1.5 })]) await expectJson4xx(await sharePOST(req(body), ctx(classId)));
    expect(db.prepare("SELECT COUNT(*) n FROM classes WHERE owner_id = ?").get(u)).toEqual({ n: 1 });
  });

  it("joinClass never throws on a non-string code", () => {
    const u = makeUser();
    for (const code of [undefined, null, 42, {}, ["X"], "", "  -- "]) expect(joinClass(u, code)).toBeNull();
  });

  it("planner/settings keeps saved values for missing or wrong-typed fields", async () => {
    const u = signIn();
    const before = plannerSettings(u);
    for (const body of BAD) expect((await settingsPOST(req(body))).status).toBe(200);
    const res = await settingsPOST(req(JSON.stringify({ weekdayMinutes: "lots", reviewMinutes: "abc", timezone: 7 })));
    expect(res.status).toBe(200);
    const after = plannerSettings(u);
    expect(after.weekday_minutes).toBe(before.weekday_minutes);
    expect(after.review_minutes).toBe(before.review_minutes);
    expect(after.timezone).toBe(before.timezone);
  });

  it("planner/tasks/[id] needs an explicit status (a garbled body doesn't untick a task)", async () => {
    const u = signIn();
    const today = todayIn(plannerSettings(u).timezone);
    const task = Number(db.prepare("INSERT INTO plan_tasks (user_id, date, kind, minutes, title, status) VALUES (?, ?, 'upload', 10, 't', 'done')").run(u, today).lastInsertRowid);
    for (const body of [...BAD, JSON.stringify({ status: 1 }), JSON.stringify({ status: "maybe" })]) await expectJson4xx(await taskPOST(req(body), ctx(task)));
    expect((db.prepare("SELECT status FROM plan_tasks WHERE id = ?").get(task) as { status: string }).status).toBe("done");
    expect((await taskPOST(req(JSON.stringify({ status: "todo" })), ctx(task))).status).toBe(200);
    expect((db.prepare("SELECT status FROM plan_tasks WHERE id = ?").get(task) as { status: string }).status).toBe("todo");
  });

  it("review/[cardId] needs a boolean `correct`; an unknown confidence counts as good", async () => {
    const u = signIn();
    const { examId } = makeExam(u, null);
    const q = question(examId);
    addReviewCard(q);
    const card = (db.prepare("SELECT id, due FROM review_cards WHERE question_id = ?").get(q) as { id: number; due: string });
    for (const body of [...BAD, JSON.stringify({ correct: "yes" })]) await expectJson4xx(await reviewCardPOST(req(body), ctx(card.id)));
    expect((db.prepare("SELECT due FROM review_cards WHERE id = ?").get(card.id) as { due: string }).due).toBe(card.due);
    expect((await reviewCardPOST(req(JSON.stringify({ correct: true, confidence: { x: 1 } })), ctx(card.id))).status).toBe(200);
  });

  it("marks, calendar/busy and calendar/busy/[id]/skip", async () => {
    const u = signIn();
    const today = todayIn(plannerSettings(u).timezone);
    const busy = Number(db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label, weekdays) VALUES (?, ?, ?, 'Clinic', 1)").run(u, today, addDays(today, 60)).lastInsertRowid);
    for (const body of BAD) {
      await expectJson4xx(await marksPUT(req(body, "PUT")));
      await expectJson4xx(await busyPOST(req(body)));
      await expectJson4xx(await skipPOST(req(body), ctx(busy)));
    }
  });

  it("calendar/exams: a bad body is a plain 400", async () => {
    signIn();
    for (const body of [...BAD, JSON.stringify({ name: 7, date: "2030-01-01" }), JSON.stringify({ name: "X", date: 20300101 })]) await expectJson4xx(await examsPOST(req(body)));
  });
});

describe("not-found answers", () => {
  it("someone else's attempt is the JSON 404; the reported-questions export answers non-admins like the other admin routes", async () => {
    const other = makeUser();
    const { examId } = makeExam(other, null);
    const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode) VALUES (?, 'tutor')").run(examId).lastInsertRowid);
    signIn();
    const res = await attemptGET(req(undefined, "GET"), ctx(attemptId));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect((await answerPOST(req("{}"), ctx(attemptId))).status).toBe(404);
    expect((await reportedExportGET()).status).toBe(401);
    signIn(true);
    expect((await reportedExportGET()).status).toBe(200);
  });
});

describe("S8: exam name and date are checked", () => {
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const examOf = (id: number) => db.prepare("SELECT name, course, exam_date FROM exams WHERE id = ?").get(id) as { name: string; course: string | null; exam_date: string | null };

  it("createExam / updateExam: a date that isn't a real day is saved as no date, long names are capped, the plan still builds", async () => {
    const u = signIn();
    await createExam(form({ name: `  ${"N".repeat(300)}  `, course: "C".repeat(200), exam_date: "zzz", kind: "board" }));
    expect(redirects).toHaveLength(1);
    const id = Number(redirects[0].split("/").pop());
    expect(examOf(id)).toEqual({ name: "N".repeat(120), course: "C".repeat(80), exam_date: null });
    expect(() => rebuildPlan(u)).not.toThrow();

    const today = todayIn(plannerSettings(u).timezone);
    await updateExam(id, form({ name: "Perio\n block", exam_date: addDays(today, 20) }));
    expect(examOf(id)).toEqual({ name: "Perio block", course: null, exam_date: addDays(today, 20) });
    await updateExam(id, form({ name: "Perio", exam_date: "2026-02-30" }));
    expect(examOf(id).exam_date).toBeNull();
    await updateExam(id, form({ name: "Perio", exam_date: addDays(today, 20) }));
    expect(() => rebuildPlan(u)).not.toThrow();
    // Back on a real date, the exam is planned again (the upload task for an exam with no lectures yet).
    expect(tasksOn(u, today, addDays(today, 30)).some((t) => t.exam_id === id)).toBe(true);
    // An empty name still saves nothing.
    await updateExam(id, form({ name: "   ", exam_date: "" }));
    expect(examOf(id).name).toBe("Perio");
  });

  it("calendar/exams single exam: invalid date refused (like the table), name and course capped", async () => {
    const u = signIn();
    const today = todayIn(plannerSettings(u).timezone);
    for (const date of ["zzz", "2026-02-30", " "]) expect((await examsPOST(req(JSON.stringify({ name: "Solo", date })))).status).toBe(400);
    const res = await examsPOST(req(JSON.stringify({ name: "S".repeat(500), course: ` ${"c".repeat(300)} `, date: addDays(today, 10) })));
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    expect(examOf(id)).toEqual({ name: "S".repeat(120), course: "c".repeat(80), exam_date: addDays(today, 10) });
    expect(() => rebuildPlan(u)).not.toThrow();
  });
});

describe("S12: review limit", () => {
  it("clamps to 1..200 and falls back to 20", async () => {
    const u = signIn();
    const { examId } = makeExam(u, null);
    for (let i = 0; i < 25; i++) addReviewCard(question(examId));
    db.prepare("UPDATE review_cards SET due = '2000-01-01T00:00:00.000Z' WHERE question_id IN (SELECT id FROM questions WHERE exam_id = ?)").run(examId);
    const n = async (q: string) => ((await (await reviewGET(new Request(`http://x/api/review${q}`))).json()) as { cards: unknown[] }).cards.length;
    expect(await n("")).toBe(20);
    expect(await n("?limit=abc")).toBe(20);
    expect(await n("?limit=-1")).toBe(1);
    expect(await n("?limit=0")).toBe(1);
    expect(await n("?limit=3.9")).toBe(3);
    expect(await n("?limit=5000")).toBe(25);
  });
});

describe("S4: page render size", () => {
  it("a normal 4:3 or 16:9 slide comes out 1280 wide, as before", () => {
    const doc = openPdf(pdfOf([[960, 720], [960, 540], [612, 792]]));
    try {
      expect(imageDimensions(renderPage(doc, 0).jpeg, "jpeg")).toEqual({ width: 1280, height: 960 });
      expect(imageDimensions(renderPage(doc, 1).jpeg, "jpeg")).toEqual({ width: 1280, height: 720 });
      expect(renderPage(doc, 2).aspect).toBeCloseTo(612 / 792);
      expect(imageDimensions(renderPage(doc, 2).jpeg, "jpeg")!.width).toBe(1280); // a portrait letter page is still under the cap
    } finally {
      doc.destroy();
    }
    expect(renderScale(960, 720)).toBe(1280 / 960);
  });

  it("a very tall page is rendered smaller (about 4 MP); a strip over 20:1 is refused with a plain message", () => {
    const doc = openPdf(pdfOf([[600, 10000], [100, 3000], [3000, 100]]));
    try {
      const tall = renderPage(doc, 0);
      const dims = imageDimensions(tall.jpeg, "jpeg")!;
      expect(dims.width).toBeLessThan(1280);
      expect(dims.width * dims.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS * 1.01);
      expect(tall.aspect).toBeCloseTo(0.06);
      expect(() => renderPage(doc, 1)).toThrow(PageShapeError);
      expect(() => renderPage(doc, 2)).toThrow(/long, thin strip/);
    } finally {
      doc.destroy();
    }
    expect(() => renderScale(0, 100)).toThrow(PageShapeError);
  });

  it("the upload route never shows raw errors; a missing exam is the JSON 404", async () => {
    const u = signIn();
    const { examId } = makeExam(u, null);
    const form = new FormData();
    form.append("file", new File([new Uint8Array(Buffer.from("not a pdf at all"))], "bad.pdf", { type: "application/pdf" }));
    const res = await uploadPOST(new Request("http://x", { method: "POST", body: form }), ctx(examId));
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^Could not read this PDF\./);
    expect(error).not.toMatch(/Error|mupdf|format/i);
    expect((await uploadPOST(new Request("http://x", { method: "POST", body: form }), ctx(987654))).status).toBe(404);
  });
});

describe("S5: only JPEG and PNG pictures are accepted from students", () => {
  const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const BMP = Buffer.concat([Buffer.from("BM"), Buffer.alloc(60)]);
  const TIFF = Buffer.concat([Buffer.from("II*\0"), Buffer.alloc(20)]);
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const files = (field: string, list: { name: string; bytes: Buffer }[], extra: Record<string, string> = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    for (const f of list) fd.append(field, new File([new Uint8Array(f.bytes)], f.name));
    return new Request("http://x", { method: "POST", body: fd });
  };

  it("pictureRefusal: JPEG/PNG pass, PDFs only where asked, everything else gets a plain sentence", () => {
    expect(pictureRefusal("a.png", "png")).toBeNull();
    expect(pictureRefusal("a.jpg", "jpeg")).toBeNull();
    expect(pictureRefusal("a.pdf", "pdf", { pdf: true })).toBeNull();
    expect(pictureRefusal("a.pdf", "pdf")).toMatch(/isn't a picture/);
    expect(pictureRefusal("a.gif", "gif")).toMatch(/"a.gif" is a GIF, which can't be read here/);
    expect(pictureRefusal("a.bmp", "bmp")).toMatch(/BMP/);
    expect(pictureRefusal("a.tif", "tiff")).toMatch(/TIFF/);
    expect(pictureRefusal("a.webp", "webp")).toMatch(/WebP/);
    expect(pictureRefusal("IMG.HEIC", "heic")).toMatch(/HEIC/);
    expect(pictureRefusal("x", "unknown", { pdf: true })).toMatch(/isn't a photo or a PDF/);
    expect(() => imageToJpeg(GIF, "gif")).toThrow();
  });

  it("report screenshots: GIF, BMP and TIFF refused by name; PNG still accepted", async () => {
    signIn();
    for (const [name, bytes, kind] of [["a.gif", GIF, "GIF"], ["a.bmp", BMP, "BMP"], ["a.tif", TIFF, "TIFF"]] as const) {
      const res = await reportsPOST(files("files", [{ name, bytes }], { message: "look" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(kind);
    }
    expect((await reportsPOST(files("files", [{ name: "a.png", bytes: PNG }], { message: "look" }))).status).toBe(200);
  });

  it("schedule import: a GIF is refused before any AI call", async () => {
    signIn();
    const res = await readPOST(files("files", [{ name: "sched.gif", bytes: GIF }]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/"sched.gif" is a GIF/);
  });
});

describe("S7: isKeyProblem has one copy", () => {
  it("scheduleImport re-exports the http one", () => {
    expect(scheduleIsKeyProblem).toBe(isKeyProblem);
    expect(scheduleIsKeyProblem("FOREIGN KEY constraint failed")).toBe(false);
  });
});

describe("R10: backups", () => {
  const snapshot = path.join(DATA_DIR, "backup-snapshot.db");

  it("a failed run removes the database snapshot", async () => {
    bucket.failOn = "PutObjectCommand";
    const status = await runBackup();
    expect(status.ok).toBe(false);
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  it("report screenshots and reported-question files are copied once, under files/", async () => {
    const u = makeUser();
    const report = createReport({ userId: u, kind: "problem", message: "x", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff]), new Uint8Array([0xff, 0xd8, 0xff])] });
    const rq = saveReportedQuestion({ userId: u, examId: null, topicId: null, source: "quiz", ref: "r", question: { question: "Q", options: ["a"], correct_index: 0 }, reason: null });
    const first = await runBackup();
    expect(first.ok).toBe(true);
    expect(fs.existsSync(snapshot)).toBe(false);
    const keys = bucket.sent.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining([`files/reports/${report}/1.jpg`, `files/reports/${report}/2.jpg`, `files/reported-questions/${rq}.json`]));
    expect(first.message).toMatch(/report file/);

    bucket.sent.length = 0;
    await runBackup();
    expect(bucket.sent.filter((c) => c.key?.startsWith("files/"))).toEqual([]);
  });

  it("deleteReportedFilesForUser removes that student's report files only", () => {
    const a = makeUser();
    const b = makeUser();
    const save = (userId: number) => saveReportedQuestion({ userId, examId: null, topicId: null, source: "quiz", ref: "r", question: { question: "Q", options: [], correct_index: null }, reason: null });
    const [ra, rb] = [save(a), save(b)];
    const file = (id: number) => path.join(FILES_DIR, "reported-questions", `${id}.json`);
    expect(fs.existsSync(file(ra))).toBe(true);
    deleteReportedFilesForUser(a);
    expect(fs.existsSync(file(ra))).toBe(false);
    expect(fs.existsSync(file(rb))).toBe(true);
  });
});
