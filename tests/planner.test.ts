import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addDays, markTopicStudied, plannerSettings, rebuildPlan, tasksOn, todayIn, weekday } from "@/lib/planner";
import { makeExam, makeUser } from "./helpers";

const today = () => todayIn(plannerSettings(1).timezone);
const setHours = (userId: number, hoursPerDay: number[]) =>
  db.prepare("UPDATE planner_settings SET weekday_minutes = ? WHERE user_id = ?").run(JSON.stringify(hoursPerDay.map((h) => h * 60)), userId);

describe("study planner", () => {
  it("schedules every topic, practice quizzes and the final stretch before the exam", () => {
    const u = makeUser();
    plannerSettings(u);
    const examDay = addDays(today(), 14);
    const { examId, topicIds } = makeExam(u, examDay, [10, 10, 10, 10, 10, 10, 10]);
    expect(rebuildPlan(u)).toEqual([]);
    const tasks = tasksOn(u, today(), examDay).filter((t) => t.exam_id === examId);
    const learn = tasks.filter((t) => t.kind === "learn");
    expect(learn.map((t) => JSON.parse(t.topic_ids)[0]).sort()).toEqual([...topicIds].sort());
    expect(learn.every((t) => t.date <= addDays(examDay, -3))).toBe(true);
    expect(tasks.filter((t) => t.kind === "practice")).toHaveLength(3); // groups of 3, 3, 1
    expect(tasks.find((t) => t.kind === "final_practice")?.date).toBe(addDays(examDay, -1));
    expect(tasks.find((t) => t.kind === "weak_review")?.date).toBe(addDays(examDay, -2));
    expect(tasks.some((t) => t.date >= examDay)).toBe(false);
  });

  it("spreads learning across the available days instead of cramming it up front", () => {
    const u = makeUser();
    plannerSettings(u);
    setHours(u, [3, 3, 3, 3, 3, 3, 3]);
    const examDay = addDays(today(), 12);
    const { examId } = makeExam(u, examDay, [8, 10, 12, 14, 16, 18, 20]);
    rebuildPlan(u);
    const learnDays = new Set(tasksOn(u, today(), examDay).filter((t) => t.exam_id === examId && t.kind === "learn").map((t) => t.date));
    expect(learnDays.size).toBeGreaterThanOrEqual(5);
    const lastLearn = [...learnDays].sort().at(-1)!;
    expect(lastLearn >= addDays(examDay, -5)).toBe(true);
  });

  it("never schedules on busy days or zero-hour weekdays", () => {
    const u = makeUser();
    plannerSettings(u);
    setHours(u, [2, 2, 2, 2, 2, 0, 0]); // weekends off
    const start = addDays(today(), 1);
    db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label) VALUES (?, ?, ?, 'Clinic')").run(u, start, addDays(start, 2));
    makeExam(u, addDays(today(), 20), [8, 8, 8, 8]);
    rebuildPlan(u);
    for (const t of tasksOn(u, today(), addDays(today(), 30))) {
      expect(t.date >= start && t.date <= addDays(start, 2)).toBe(false);
      expect(weekday(t.date)).toBeLessThan(5);
    }
  });

  it("interleaves two exams and finishes the sooner one first", () => {
    const u = makeUser();
    plannerSettings(u);
    setHours(u, [1, 1, 1, 1, 1, 1, 1]);
    const soon = makeExam(u, addDays(today(), 8), [10, 10, 10], "Soon");
    const later = makeExam(u, addDays(today(), 25), [10, 10, 10, 10, 10, 10], "Later");
    expect(rebuildPlan(u)).toEqual([]);
    const tasks = tasksOn(u, today(), addDays(today(), 30));
    const lastSoonLearn = tasks.filter((t) => t.exam_id === soon.examId && t.kind === "learn").at(-1)!.date;
    expect(lastSoonLearn <= addDays(today(), 5)).toBe(true);
    expect(tasks.some((t) => t.exam_id === later.examId && t.kind === "learn")).toBe(true);
    // No day is overfilled by more than the small overflow allowance.
    const perDay = new Map<string, number>();
    for (const t of tasks) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.minutes);
    for (const m of perDay.values()) expect(m).toBeLessThanOrEqual(60 + 45);
  });

  it("warns when there isn't enough time", () => {
    const u = makeUser();
    plannerSettings(u);
    setHours(u, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const { examId } = makeExam(u, addDays(today(), 5), Array(12).fill(20), "Cram");
    const warnings = rebuildPlan(u);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].examId).toBe(examId);
    expect(warnings[0].minutesShort).toBeGreaterThan(0);
  });

  it("studying a topic ticks its task and keeps it out of the next plan", () => {
    const u = makeUser();
    plannerSettings(u);
    const { topicIds } = makeExam(u, addDays(today(), 10), [10, 10]);
    rebuildPlan(u);
    markTopicStudied(u, topicIds[0]);
    const done = db.prepare("SELECT status FROM plan_tasks WHERE user_id = ? AND kind = 'learn' AND topic_ids = ?").get(u, JSON.stringify([topicIds[0]])) as {
      status: string;
    };
    expect(done.status).toBe("done");
    rebuildPlan(u);
    const learnTodo = tasksOn(u, today(), addDays(today(), 10)).filter((t) => t.kind === "learn" && t.status === "todo");
    expect(learnTodo.map((t) => JSON.parse(t.topic_ids)[0])).toEqual([topicIds[1]]);
  });

  it("marks unfinished past tasks as missed and reschedules the work", () => {
    const u = makeUser();
    plannerSettings(u);
    const { topicIds } = makeExam(u, addDays(today(), 10), [10]);
    db.prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, topic_ids, minutes, title) VALUES (?, ?, NULL, 'learn', ?, 30, 'old')").run(
      u,
      addDays(today(), -1),
      JSON.stringify([topicIds[0]]),
    );
    rebuildPlan(u);
    expect((db.prepare("SELECT status FROM plan_tasks WHERE user_id = ? AND title = 'old'").get(u) as { status: string }).status).toBe("missed");
    expect(tasksOn(u, today(), addDays(today(), 10)).some((t) => t.kind === "learn")).toBe(true);
  });

  it("asks for lectures when an exam has none yet", () => {
    const u = makeUser();
    plannerSettings(u);
    makeExam(u, addDays(today(), 30), []);
    rebuildPlan(u);
    expect(tasksOn(u, today(), today()).some((t) => t.kind === "upload")).toBe(true);
  });
});
