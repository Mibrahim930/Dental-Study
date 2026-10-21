// Calendar release, job 2: "Exams without a date" — picking a date puts the exam on the calendar and into the plan.
import { describe, expect, it, vi } from "vitest";

let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  requireUser: async () => ({ id: currentUserId }),
}));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

import { db } from "@/lib/db";
import { setExamDate } from "@/app/actions";
import { addDays, plannerSettings, tasksOn, todayIn } from "@/lib/planner";
import { isValidDate } from "@/lib/calendar";
import { makeExam, makeUser } from "./helpers";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const dateOf = (id: number) => (db.prepare("SELECT exam_date FROM exams WHERE id = ?").get(id) as { exam_date: string | null }).exam_date;

describe("exams without a date", () => {
  it("saving a date puts the exam into the plan", async () => {
    const u = makeUser();
    currentUserId = u;
    const today = todayIn(plannerSettings(u).timezone);
    const { examId } = makeExam(u, null, [8, 8, 8]);
    expect(tasksOn(u, today, addDays(today, 60)).some((t) => t.exam_id === examId)).toBe(false);
    const date = addDays(today, 21);
    expect(await setExamDate(null, form({ id: String(examId), exam_date: date }))).toBeNull();
    expect(dateOf(examId)).toBe(date);
    const tasks = tasksOn(u, today, addDays(today, 60)).filter((t) => t.exam_id === examId);
    expect(tasks.filter((t) => t.kind === "learn")).toHaveLength(3);
  });

  it("refuses a missing or impossible date and changes nothing", async () => {
    const u = makeUser();
    currentUserId = u;
    const { examId } = makeExam(u, null);
    for (const bad of ["", "2026-02-30", "26-11-04", "0026-11-04", "tomorrow"]) {
      expect(await setExamDate(null, form({ id: String(examId), exam_date: bad }))).toEqual({ error: "Pick a date first." });
    }
    expect(dateOf(examId)).toBeNull();
  });

  it("can't date another student's exam", async () => {
    const owner = makeUser();
    const { examId } = makeExam(owner, null);
    currentUserId = makeUser();
    const r = await setExamDate(null, form({ id: String(examId), exam_date: "2026-12-01" }));
    expect(r?.error).toMatch(/couldn't be found/);
    expect(dateOf(examId)).toBeNull();
  });

  it("isValidDate accepts real dates only", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2027-02-29")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("1999-12-31")).toBe(false);
    expect(isValidDate(20261104)).toBe(false);
  });
});
