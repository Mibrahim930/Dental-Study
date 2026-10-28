// The filler check over every stored lesson: runs at start and from the Admin page, cleans what it finds (no AI
// call), and keeps a record of every lesson ever found so the owner can see that it was the only one.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async () => {
    throw new Error("no AI call expected");
  }),
}));
let currentUser: { id: number; is_admin: number } | null = null;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiAdmin: async () => (currentUser?.is_admin ? currentUser : null),
}));

import { db, getMeta } from "@/lib/db";
import { cleanLesson, lastLessonScan, LESSON_VERSION, scanLessonsForFiller } from "@/lib/study";
import { POST as scanPOST } from "@/app/api/admin/lesson-scan/route";
import { makeUser } from "./helpers";

/** Lessons stored in this test file's database so far (the database is shared by the file's tests). */
const countLessons = () => (db.prepare("SELECT COUNT(*) n FROM topics WHERE lesson_json IS NOT NULL").get() as { n: number }).n;
const RAMBLE = "Done.\n\n(Keep going.)\n\nOk.\n\nStop.\n\n.\n\nEnd of slide.\n\nBye.";
const GOOD = "The kidney filters the blood. Damage that came on within days is **acute kidney injury (AKI)**; damage older than 3 months is **chronic kidney disease (CKD)**.";

function section(o: { exam?: string; lecture?: string | null; title?: string; lesson: object | string | null; userId?: number } = { lesson: null }) {
  const userId = o.userId ?? makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, ?)").run(userId, o.exam ?? "Renal").lastInsertRowid);
  const docId =
    o.lecture === null
      ? null
      : Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, ?, 'done')").run(examId, o.lecture ?? "L1.pdf").lastInsertRowid);
  const pageId = docId
    ? Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status) VALUES (?, 1, '', 'done')").run(docId).lastInsertRowid)
    : null;
  const topicId = Number(
    db
      .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id, lesson_json) VALUES (?, 0, ?, 's', ?, ?, ?)")
      .run(examId, o.title ?? "Classifying kidney injury", JSON.stringify(pageId ? [pageId] : []), docId, o.lesson == null ? null : typeof o.lesson === "string" ? o.lesson : JSON.stringify(o.lesson)).lastInsertRowid,
  );
  return { userId, examId, docId, pageId, topicId, lesson: () => (db.prepare("SELECT lesson_json FROM topics WHERE id = ?").get(topicId) as { lesson_json: string | null }).lesson_json };
}
const lessonWith = (pageId: number | null, explanation: string, extra: object = {}) => ({
  intro: "What this is about.",
  slides: [{ page_id: pageId ?? 1, explanation }],
  key_points: ["k"],
  connections: null,
  version: LESSON_VERSION,
  ...extra,
});

beforeEach(() => {
  currentUser = null;
  db.prepare("DELETE FROM meta WHERE key = 'lesson_filler_scan'").run();
});

describe("scanLessonsForFiller", () => {
  it("finds the lesson with filler, cleans it, leaves the others alone, and records what it found", () => {
    const bad = section({ lesson: null });
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lessonWith(bad.pageId, `${GOOD}\n\n${RAMBLE}`)), bad.topicId);
    const fine = section({ exam: "Pulp", title: "Pulp anatomy", lesson: null });
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lessonWith(fine.pageId, GOOD)), fine.topicId);
    const none = section({ lesson: null });
    const before = fine.lesson();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scan = scanLessonsForFiller();
    warn.mockRestore();
    expect(scan.checked).toBe(countLessons());
    expect(scan.found).toEqual([{ topicId: bad.topicId, examId: bad.examId, exam: "Renal", lecture: "L1.pdf", section: "Classifying kidney injury", trimmed: 1, dropped: 0, intro: false }]);
    expect(JSON.parse(bad.lesson()!).slides[0].explanation).toBe(GOOD);
    expect(JSON.parse(bad.lesson()!).version).toBe(LESSON_VERSION);
    expect(fine.lesson()).toBe(before);
    expect(none.lesson()).toBeNull();
    const last = lastLessonScan()!;
    expect(last.checked).toBe(countLessons());
    expect(last.found.map((h) => h.topicId)).toEqual([bad.topicId]);
    expect(Date.parse(last.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a second check finds nothing new but still lists the lesson found before (the record is cumulative)", () => {
    const bad = section({ lesson: null });
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lessonWith(bad.pageId, `${GOOD}\n\n${RAMBLE}`)), bad.topicId);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    scanLessonsForFiller();
    const again = scanLessonsForFiller();
    vi.restoreAllMocks();
    expect(again.found).toEqual([]);
    expect(lastLessonScan()!.found.map((h) => h.topicId)).toEqual([bad.topicId]);
    // a lesson found twice (filler came back after a rewrite) is listed once, with the latest counts
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lessonWith(bad.pageId, RAMBLE, { intro: "I.\n\nDone.\n\nOk.\n\nBye." })), bad.topicId);
    scanLessonsForFiller();
    const hits = lastLessonScan()!.found.filter((h) => h.topicId === bad.topicId);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ trimmed: 0, dropped: 1, intro: true });
  });

  it("damaged or odd lesson rows don't stop the check", () => {
    section({ lesson: "{not json" });
    section({ lesson: "null" });
    section({ lesson: "[]" });
    section({ lesson: { intro: 5, slides: "nope", key_points: [], connections: null } });
    const bad = section({ lecture: null, lesson: null });
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lessonWith(null, `${GOOD}\n\n${RAMBLE}`)), bad.topicId);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scan = scanLessonsForFiller();
    vi.restoreAllMocks();
    expect(scan.checked).toBe(countLessons());
    expect(scan.found.map((h) => [h.topicId, h.lecture])).toEqual([[bad.topicId, null]]);
  });

  it("a damaged record of an earlier check is ignored", () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lesson_filler_scan', ?)").run("{bad");
    expect(lastLessonScan()).toBeNull();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lesson_filler_scan', ?)").run(JSON.stringify({ at: "x", checked: 1 }));
    expect(lastLessonScan()).toBeNull();
    const scan = scanLessonsForFiller();
    expect(scan.found).toEqual([]);
    expect(getMeta("lesson_filler_scan")).toContain('"found":[]');
  });
});

describe("cleanLesson", () => {
  it("reports trimmed, dropped and intro separately and returns the same object when nothing changes", () => {
    const l = lessonWith(1, GOOD);
    const same = cleanLesson(l);
    expect(same.changed).toBe(false);
    expect(same.lesson).toBe(l);
    const c = cleanLesson({ ...lessonWith(1, `${GOOD}\n\n${RAMBLE}`), slides: [{ page_id: 1, explanation: `${GOOD}\n\n${RAMBLE}` }, { page_id: 2, explanation: RAMBLE }, { page_id: 3, explanation: GOOD }], intro: "Hi.\n\nDone.\n\nBye." });
    expect(c).toMatchObject({ changed: true, trimmed: 1, dropped: 1, intro: true });
    expect(c.lesson.slides.map((s) => s.page_id)).toEqual([1, 3]);
    expect(c.lesson.intro).toBe("Hi.");
  });
});

describe("the Admin route", () => {
  it("runs the check for the admin only", async () => {
    const bad = section({ lesson: null });
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lessonWith(bad.pageId, `${GOOD}\n\n${RAMBLE}`)), bad.topicId);
    expect((await scanPOST()).status).toBe(401);
    currentUser = { id: bad.userId, is_admin: 0 };
    expect((await scanPOST()).status).toBe(401);
    expect(JSON.parse(bad.lesson()!).slides[0].explanation).toContain("Bye.");
    currentUser = { id: bad.userId, is_admin: 1 };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await scanPOST();
    vi.restoreAllMocks();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checked: countLessons(), found: 1 });
    expect(JSON.parse(bad.lesson()!).slides[0].explanation).toBe(GOOD);
  });
});
