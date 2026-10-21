// Calendar release, job 3: "+ Add exams" — several exams in one go, one transaction, one re-plan.
import { describe, expect, it, vi } from "vitest";

let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { POST } from "@/app/api/calendar/exams/route";
import { addDays, plannerSettings, todayIn } from "@/lib/planner";
import { duplicateKey } from "@/lib/calendar";
import { cleanExamRows, existingExamKeys } from "@/lib/examImport";
import { makeExam, makeUser } from "./helpers";

const post = (body: unknown) => POST(new Request("http://x/api/calendar/exams", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const examsOf = (u: number) => db.prepare("SELECT name, exam_date, kind, course FROM exams WHERE user_id = ? ORDER BY id").all(u) as { name: string; exam_date: string; kind: string; course: string | null }[];

describe("adding several exams at once", () => {
  it("creates every row and re-plans once (uploads tasks appear for each new exam)", async () => {
    const u = makeUser();
    currentUserId = u;
    const today = todayIn(plannerSettings(u).timezone);
    const res = await post({
      exams: [
        { name: "  Endo   Block 2 ", date: addDays(today, 10), kind: "block", course: "Endo D2" },
        { name: "Perio Quiz", date: addDays(today, 12), kind: "quiz" },
        { name: "OSCE", date: addDays(today, 30), kind: "practical", course: "" },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(3);
    expect(examsOf(u)).toEqual([
      { name: "Endo Block 2", exam_date: addDays(today, 10), kind: "block", course: "Endo D2" },
      { name: "Perio Quiz", exam_date: addDays(today, 12), kind: "quiz", course: null },
      { name: "OSCE", exam_date: addDays(today, 30), kind: "practical", course: null },
    ]);
    const uploads = db.prepare("SELECT COUNT(*) n FROM plan_tasks WHERE user_id = ? AND kind = 'upload'").get(u) as { n: number };
    expect(uploads.n).toBe(3);
  });

  it("is all or nothing: one bad row saves none and says which row", async () => {
    const u = makeUser();
    currentUserId = u;
    for (const [rows, msg] of [
      [[{ name: "A", date: "2026-12-01" }, { name: "", date: "2026-12-02" }], /Row 2 needs a name/],
      [[{ name: "A", date: "2026-12-01" }, { name: "B" }], /Row 2 \(B\) needs a date/],
      [[{ name: "A", date: "2027-02-29" }], /Row 1 \(A\) has a date that doesn't exist/],
      [[], /at least one/],
      ["nope", /at least one/],
      [Array.from({ length: 61 }, (_, i) => ({ name: `E${i}`, date: "2026-12-01" })), /more than 60/],
    ] as const) {
      const res = await post({ exams: rows });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(msg);
    }
    expect(examsOf(u)).toEqual([]);
  });

  it("unknown types become Block exam; long names are trimmed; a broken body is a plain 400", async () => {
    const u = makeUser();
    currentUserId = u;
    await post({ exams: [{ name: "X".repeat(500), date: "2026-12-01", kind: "nonsense", course: 42 }] });
    const [e] = examsOf(u);
    expect(e.kind).toBe("block");
    expect(e.name.length).toBe(120);
    expect(e.course).toBeNull();
    const bad = await post("{not json");
    expect(bad.status).toBe(400);
  });

  it("the single-exam form still works and still needs a real date", async () => {
    const u = makeUser();
    currentUserId = u;
    expect((await post({ name: "Solo", date: "2026-11-31" })).status).toBe(400);
    expect((await post({ name: "Solo", date: "2026-11-30", kind: "board" })).status).toBe(200);
    expect(examsOf(u).map((e) => e.kind)).toEqual(["board"]);
  });

  it("signed-out requests are refused", async () => {
    currentUserId = 0;
    expect((await post({ exams: [{ name: "A", date: "2026-12-01" }] })).status).toBe(401);
  });

  it("duplicates are matched on name (case, spacing, punctuation ignored) and date, against active exams only", () => {
    const u = makeUser();
    makeExam(u, "2026-11-04", [], "Endo Block 2");
    const { examId } = makeExam(u, "2026-11-06", [], "Old Quiz");
    db.prepare("UPDATE exams SET status = 'archived' WHERE id = ?").run(examId);
    const keys = existingExamKeys(u);
    expect(keys.has(duplicateKey("endo  block-2", "2026-11-04"))).toBe(true);
    expect(keys.has(duplicateKey("Endo Block 2", "2026-11-05"))).toBe(false);
    expect(keys.has(duplicateKey("Old Quiz", "2026-11-06"))).toBe(false);
    expect("rows" in cleanExamRows([{ name: "a", date: "2026-11-04" }])).toBe(true);
  });
});
