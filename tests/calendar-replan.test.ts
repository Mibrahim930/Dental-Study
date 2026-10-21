// Calendar release, job 8: "Re-plan from today" after missed tasks, and "Study time this day" overrides.
import { describe, expect, it, vi } from "vitest";

let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { POST as replanPOST } from "@/app/api/planner/replan/route";
import { POST as dayPOST } from "@/app/api/planner/day/route";
import { addDays, dayOverrides, missedSummary, plannerSettings, rebuildPlan, replanFromToday, setDayOverride, tasksOn, todayIn } from "@/lib/planner";
import { makeExam, makeUser } from "./helpers";

const today = (u: number) => todayIn(plannerSettings(u).timezone);
const day = (body: unknown) => dayPOST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }));
const minutesOn = (u: number, d: string) => tasksOn(u, d, d).reduce((s, t) => s + t.minutes, 0);

/** Pretend the plan was made a few days ago and nothing was done since: move the first learn tasks into the past. */
function missSome(u: number, daysAgo: number[]) {
  const learn = tasksOn(u, today(u), addDays(today(u), 60)).filter((t) => t.kind === "learn");
  daysAgo.forEach((ago, i) => db.prepare("UPDATE plan_tasks SET date = ? WHERE id = ?").run(addDays(today(u), -ago), learn[i].id));
  rebuildPlan(u); // the daily rebuild marks them missed and rolls their topics forward
  return learn.slice(0, daysAgo.length).map((t) => JSON.parse(t.topic_ids)[0] as number);
}

describe("missed tasks and Re-plan from today", () => {
  it("counts yesterday's misses, re-plans, says what came back, and the note goes away", async () => {
    const u = makeUser();
    currentUserId = u;
    plannerSettings(u);
    makeExam(u, addDays(today(u), 25), [8, 8, 8, 8, 8, 8]);
    rebuildPlan(u);
    const topics = missSome(u, [1, 1, 1]);
    expect(missedSummary(u)).toEqual({ count: 3, yesterdayOnly: true });

    const res = await replanPOST();
    const body = await res.json();
    expect(body.topicsBack).toBe(3);
    expect(body.message).toBe("Done. 3 missed topics are back in your plan.");
    const planned = tasksOn(u, today(u), addDays(today(u), 30)).filter((t) => t.kind === "learn" && t.status === "todo").map((t) => JSON.parse(t.topic_ids)[0]);
    for (const t of topics) expect(planned).toContain(t);
    expect(missedSummary(u).count).toBe(0);
  });

  it("older misses in the last week say 'this week'; older than a week are left alone", () => {
    const u = makeUser();
    plannerSettings(u);
    makeExam(u, addDays(today(u), 25), [8, 8, 8, 8]);
    rebuildPlan(u);
    missSome(u, [1, 3, 12]);
    expect(missedSummary(u)).toEqual({ count: 2, yesterdayOnly: false });
  });

  it("a miss after the last re-plan shows again", () => {
    const u = makeUser();
    plannerSettings(u);
    makeExam(u, addDays(today(u), 25), [8, 8, 8, 8]);
    rebuildPlan(u);
    missSome(u, [2]);
    replanFromToday(u);
    expect(missedSummary(u).count).toBe(0);
    // As if she had re-planned yesterday (dealt with everything up to the day before) and then missed yesterday's review.
    db.prepare("UPDATE planner_settings SET missed_seen_through = ? WHERE user_id = ?").run(addDays(today(u), -2), u);
    db.prepare("INSERT INTO plan_tasks (user_id, date, kind, minutes, title, status) VALUES (?, ?, 'review', 15, 'Daily review', 'missed')").run(u, addDays(today(u), -1));
    expect(missedSummary(u)).toEqual({ count: 1, yesterdayOnly: true });
  });

  it("with nothing missed it still re-plans and says so; signed out is refused", async () => {
    const u = makeUser();
    currentUserId = u;
    expect((await (await replanPOST()).json()).message).toBe("Done. Your plan now starts from today.");
    currentUserId = 0;
    expect((await replanPOST()).status).toBe(401);
  });
});

describe("study time for one day", () => {
  it("an override changes that day's capacity; a day off plans nothing; back to usual restores it", async () => {
    const u = makeUser();
    currentUserId = u;
    plannerSettings(u);
    db.prepare("UPDATE planner_settings SET weekday_minutes = ?, review_minutes = 0 WHERE user_id = ?").run(JSON.stringify(Array(7).fill(120)), u);
    makeExam(u, addDays(today(u), 30), Array(20).fill(20));
    rebuildPlan(u);
    const d1 = addDays(today(u), 2);
    const d2 = addDays(today(u), 3);
    expect(minutesOn(u, d1)).toBeGreaterThan(30);

    expect((await day({ date: d1, minutes: 30 })).status).toBe(200);
    expect(minutesOn(u, d1)).toBeLessThanOrEqual(30 + 10); // the planner's small overflow allowance
    expect((await day({ date: d2, minutes: 0 })).status).toBe(200);
    expect(minutesOn(u, d2)).toBe(0);
    expect([...dayOverrides(u, today(u))]).toEqual([
      [d1, 30],
      [d2, 0],
    ]);

    expect((await day({ date: d2, minutes: null })).status).toBe(200);
    expect(minutesOn(u, d2)).toBeGreaterThan(0);
    expect(dayOverrides(u, today(u)).has(d2)).toBe(false);
  });

  it("more time on one day is used", () => {
    const u = makeUser();
    plannerSettings(u);
    db.prepare("UPDATE planner_settings SET weekday_minutes = ?, review_minutes = 0 WHERE user_id = ?").run(JSON.stringify(Array(7).fill(30)), u);
    makeExam(u, addDays(today(u), 20), Array(20).fill(20));
    const d = addDays(today(u), 1);
    setDayOverride(u, d, 180);
    expect(minutesOn(u, d)).toBeGreaterThan(40);
  });

  it("a busy day stays busy whatever the override says", () => {
    const u = makeUser();
    plannerSettings(u);
    makeExam(u, addDays(today(u), 20), Array(10).fill(20));
    const d = addDays(today(u), 1);
    db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label) VALUES (?, ?, ?, 'Clinic')").run(u, d, d);
    setDayOverride(u, d, 300);
    expect(minutesOn(u, d)).toBe(0);
  });

  it("refuses past days, impossible values and bad bodies", async () => {
    currentUserId = makeUser();
    const t = today(currentUserId);
    for (const [body, msg] of [
      [{ date: addDays(t, -1), minutes: 60 }, /passed/],
      [{ date: "2026-02-30", minutes: 60 }, /Pick a day/],
      [{ date: addDays(t, 1), minutes: -5 }, /between 0 and 16/],
      [{ date: addDays(t, 1), minutes: 17 * 60 }, /between 0 and 16/],
      [{ date: addDays(t, 1), minutes: "90" }, /between 0 and 16/],
      [{ date: addDays(t, 900), minutes: 60 }, /next two years/],
    ] as const) {
      const r = await day(body);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(msg);
    }
    expect((await dayPOST(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400);
  });
});
