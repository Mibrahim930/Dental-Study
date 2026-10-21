// Calendar release, job 6: weekly repeating busy days ("Clinic every Tuesday until …"), skipping one week, planner and feed.
import { describe, expect, it, vi } from "vitest";

let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { POST as busyPOST } from "@/app/api/calendar/busy/route";
import { POST as skipPOST } from "@/app/api/calendar/busy/[id]/skip/route";
import { POST as deletePOST } from "@/app/api/calendar/busy/[id]/delete/route";
import { GET as icsGET } from "@/app/api/ics/[token]/route";
import { addDays, icsToken, plannerSettings, rebuildPlan, tasksOn, todayIn, weekday } from "@/lib/planner";
import { busyOn, coversDate, firstOccurrence, loadBusy, maskOf, repeatLabel, skippedOn, type BusyRow } from "@/lib/busy";
import { makeExam, makeUser } from "./helpers";

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const addBusy = (body: unknown) => busyPOST(new Request("http://x", json(body)));
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const skip = (id: number, body: unknown) => skipPOST(new Request("http://x", json(body)), ctx(id));
const lastBusyId = (u: number) => (db.prepare("SELECT MAX(id) id FROM busy_days WHERE user_id = ?").get(u) as { id: number }).id;
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, "");

/** The next date on or after `from` that falls on weekday `wd` (0 = Monday). */
const nextWeekday = (from: string, wd: number) => {
  let d = from;
  while (weekday(d) !== wd) d = addDays(d, 1);
  return d;
};

describe("repeat expansion (pure)", () => {
  const clinic: BusyRow = { id: 7, start_date: "2026-11-02", end_date: "2026-11-30", label: "Clinic", weekdays: maskOf([1, 3]) }; // Tue + Thu

  it("covers only the chosen weekdays between start and until", () => {
    const days: string[] = [];
    for (let d = "2026-10-26"; d <= "2026-12-06"; d = addDays(d, 1)) if (busyOn([clinic], new Set(), d).length) days.push(d);
    expect(days).toEqual(["2026-11-03", "2026-11-05", "2026-11-10", "2026-11-12", "2026-11-17", "2026-11-19", "2026-11-24", "2026-11-26"]);
    expect(firstOccurrence(clinic)).toBe("2026-11-03");
  });

  it("a skipped week is not busy, and shows as skipped", () => {
    const skips = new Set(["7|2026-11-10"]);
    expect(busyOn([clinic], skips, "2026-11-10")).toEqual([]);
    expect(skippedOn([clinic], skips, "2026-11-10").map((b) => b.id)).toEqual([7]);
    expect(busyOn([clinic], skips, "2026-11-12").length).toBe(1);
    expect(skippedOn([clinic], skips, "2026-11-12")).toEqual([]);
  });

  it("one-off ranges ignore skips; labels read naturally", () => {
    const trip: BusyRow = { id: 8, start_date: "2026-11-10", end_date: "2026-11-12", label: "Trip", weekdays: null };
    expect(busyOn([trip], new Set(["8|2026-11-11"]), "2026-11-11").length).toBe(1);
    expect(coversDate(trip, "2026-11-13")).toBe(false);
    expect(repeatLabel(maskOf([1]))).toBe("every Tuesday");
    expect(repeatLabel(maskOf([1, 3]))).toBe("every Tue and Thu");
    expect(repeatLabel(maskOf([0, 2, 4]))).toBe("every Mon, Wed and Fri");
    expect(repeatLabel(maskOf([0, 1, 2, 3, 4]))).toBe("every weekday");
    expect(repeatLabel(maskOf([0, 1, 2, 3, 4, 5, 6]))).toBe("every day");
    expect(firstOccurrence({ ...clinic, start_date: "2026-11-04", end_date: "2026-11-04" })).toBeNull(); // a Wednesday only
  });
});

describe("saving repeats from the busy form", () => {
  it("stores a repeat; rejects no days, a bad or too-long until, and a range with none of those days", async () => {
    const u = makeUser();
    currentUserId = u;
    expect((await addBusy({ start: "2026-11-02", label: "Clinic", weekdays: [1], until: "2026-12-15" })).status).toBe(200);
    const row = db.prepare("SELECT start_date, end_date, label, weekdays FROM busy_days WHERE id = ?").get(lastBusyId(u));
    expect(row).toEqual({ start_date: "2026-11-02", end_date: "2026-12-15", label: "Clinic", weekdays: 2 });

    for (const [body, msg] of [
      [{ start: "2026-11-02", weekdays: [9], until: "2026-12-15" }, /at least one day/],
      [{ start: "2026-11-02", weekdays: [1] }, /repeats until/],
      [{ start: "2026-11-02", weekdays: [1], until: "2026-11-01" }, /repeats until/],
      [{ start: "2026-11-02", weekdays: [1], until: "2029-01-01" }, /two years/],
      [{ start: "2026-11-04", weekdays: [1], until: "2026-11-05" }, /None of those days/],
      [{ start: "nope", weekdays: [1], until: "2026-11-05" }, /start date/],
    ] as const) {
      const res = await addBusy(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(msg);
    }
    // A plain range still works the old way.
    expect((await addBusy({ start: "2026-12-20", end: "2026-12-24", label: "Break" })).status).toBe(200);
    expect(db.prepare("SELECT weekdays FROM busy_days WHERE id = ?").get(lastBusyId(u))).toEqual({ weekdays: null });
  });

  it("skip and undo a week; only on a day the repeat happens; only for her own entries; removing deletes the skips too", async () => {
    const u = makeUser();
    currentUserId = u;
    await addBusy({ start: "2026-11-02", label: "Clinic", weekdays: [1], until: "2026-12-15" });
    const id = lastBusyId(u);
    expect((await skip(id, { date: "2026-11-10" })).status).toBe(200);
    expect(loadBusy(u).skips.has(`${id}|2026-11-10`)).toBe(true);
    expect((await skip(id, { date: "2026-11-11" })).status).toBe(400); // a Wednesday
    expect((await skip(id, { date: "2026-11-10", undo: true })).status).toBe(200);
    expect(loadBusy(u).skips.size).toBe(0);
    await skip(id, { date: "2026-11-17" });

    currentUserId = makeUser();
    expect((await skip(id, { date: "2026-11-24" })).status).toBe(404);
    currentUserId = u;
    await deletePOST(new Request("http://x", { method: "POST" }), ctx(id));
    expect(db.prepare("SELECT COUNT(*) n FROM busy_skips WHERE busy_id = ?").get(id)).toEqual({ n: 0 });
  });
});

describe("planner and phone feed", () => {
  it("the planner leaves repeating days empty, except a skipped week", async () => {
    const u = makeUser();
    currentUserId = u;
    plannerSettings(u);
    const today = todayIn(plannerSettings(u).timezone);
    const start = addDays(today, 1);
    await addBusy({ start, label: "Clinic", weekdays: [1, 3], until: addDays(today, 40) });
    const id = lastBusyId(u);
    const skipped = nextWeekday(addDays(today, 8), 1);
    await skip(id, { date: skipped });
    makeExam(u, addDays(today, 35), Array(14).fill(12));
    rebuildPlan(u);
    const tasks = tasksOn(u, start, addDays(today, 40));
    const byDay = new Set(tasks.map((t) => t.date));
    for (const t of tasks) {
      if (t.date !== skipped) expect([1, 3]).not.toContain(weekday(t.date));
    }
    expect(byDay.has(skipped)).toBe(true); // the skipped Tuesday is a normal study day again
  });

  it("the feed sends a repeat as one weekly event with its skipped weeks", async () => {
    const u = makeUser();
    currentUserId = u;
    await addBusy({ start: "2026-11-02", label: "Clinic, Lab; Ward", weekdays: [1, 3], until: "2026-12-15" });
    const id = lastBusyId(u);
    await skip(id, { date: "2026-11-10" });
    await skip(id, { date: "2026-11-19" });
    await addBusy({ start: "2026-12-20", end: "2026-12-24", label: "Break" });
    const token = icsToken(u);
    const ics = unfold(await (await icsGET(new Request("http://x"), { params: Promise.resolve({ token: `${token}.ics` }) } as never)).text());
    const event = ics.slice(ics.indexOf(`UID:busy-${id}@`), ics.indexOf("END:VEVENT", ics.indexOf(`UID:busy-${id}@`)));
    expect(event).toContain("DTSTART;VALUE=DATE:20261103");
    expect(event).toContain("DTEND;VALUE=DATE:20261104");
    expect(event).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261215");
    expect(event).toContain("EXDATE;VALUE=DATE:20261110,20261119");
    expect(event).toContain("SUMMARY:⛔ Clinic\\, Lab\\; Ward");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261220");
    expect(ics).toContain("DTEND;VALUE=DATE:20261225");
  });
});
