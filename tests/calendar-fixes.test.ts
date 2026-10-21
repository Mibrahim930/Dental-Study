// Calendar release, job 1: bug fixes from design/CALENDAR-RESEARCH.md (rough edges 3, 4, 7, 8, 9).
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addDays, icsToken, plannerSettings, rebuildPlan, setTaskStatus, tasksOn, todayIn } from "@/lib/planner";
import { daysUntil } from "@/lib/format";
import { examsByDate } from "@/lib/calendar";
import { foldLine, icsBody, icsEscape } from "@/lib/ics";
import { GET as icsGET } from "@/app/api/ics/[token]/route";
import { makeExam, makeUser } from "./helpers";

const today = (u: number) => todayIn(plannerSettings(u).timezone);
const studied = (u: number, topicId: number) => !!db.prepare("SELECT 1 FROM topic_study WHERE user_id = ? AND topic_id = ?").get(u, topicId);

async function feed(userId: number): Promise<string> {
  const token = icsToken(userId);
  const res = await icsGET(new Request(`http://x/api/ics/${token}.ics`), { params: Promise.resolve({ token: `${token}.ics` }) } as never);
  expect(res.status).toBe(200);
  return res.text();
}
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");

afterEach(() => {
  vi.useRealTimers();
});

describe("ticking a Study task by hand", () => {
  it("counts the topic as studied, so the next re-plan doesn't schedule it again", () => {
    const u = makeUser();
    plannerSettings(u);
    const { topicIds } = makeExam(u, addDays(today(u), 20), [8, 8, 8]);
    rebuildPlan(u);
    const learn = tasksOn(u, today(u), addDays(today(u), 30)).filter((t) => t.kind === "learn");
    const first = learn.find((t) => JSON.parse(t.topic_ids)[0] === topicIds[0])!;
    setTaskStatus(u, first.id, "done");
    expect(studied(u, topicIds[0])).toBe(true);

    rebuildPlan(u);
    const again = tasksOn(u, today(u), addDays(today(u), 30)).filter((t) => t.kind === "learn" && t.status === "todo");
    expect(again.some((t) => JSON.parse(t.topic_ids)[0] === topicIds[0])).toBe(false);
    expect(again.length).toBe(2);
  });

  it("unticking takes it back, and the topic returns to the plan", () => {
    const u = makeUser();
    plannerSettings(u);
    const { topicIds } = makeExam(u, addDays(today(u), 20), [8, 8]);
    rebuildPlan(u);
    const task = tasksOn(u, today(u), addDays(today(u), 30)).find((t) => t.kind === "learn" && JSON.parse(t.topic_ids)[0] === topicIds[1])!;
    setTaskStatus(u, task.id, "done");
    setTaskStatus(u, task.id, "todo");
    expect(studied(u, topicIds[1])).toBe(false);
    rebuildPlan(u);
    expect(tasksOn(u, today(u), addDays(today(u), 30)).some((t) => t.kind === "learn" && JSON.parse(t.topic_ids)[0] === topicIds[1])).toBe(true);
  });

  it("unticking keeps a topic she opened in a study session before ticking", () => {
    const u = makeUser();
    plannerSettings(u);
    const { topicIds } = makeExam(u, addDays(today(u), 20), [8]);
    rebuildPlan(u);
    db.prepare("INSERT INTO topic_study (user_id, topic_id, studied_at) VALUES (?, ?, datetime('now', '-2 days'))").run(u, topicIds[0]);
    const task = Number(
      db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title) VALUES (?, ?, 'learn', ?, 20, 'Study: T')").run(u, today(u), JSON.stringify(topicIds)).lastInsertRowid,
    );
    setTaskStatus(u, task, "done");
    setTaskStatus(u, task, "todo");
    expect(studied(u, topicIds[0])).toBe(true);
  });

  it("can't mark another student's topic studied, or touch another student's task", () => {
    const a = makeUser();
    const b = makeUser();
    const { topicIds } = makeExam(b, addDays(today(b), 20), [8]);
    const forged = Number(
      db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title) VALUES (?, ?, 'learn', ?, 20, 'x')").run(a, today(a), JSON.stringify(topicIds)).lastInsertRowid,
    );
    setTaskStatus(a, forged, "done");
    expect(studied(a, topicIds[0])).toBe(false);
    const theirs = Number(
      db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title) VALUES (?, ?, 'learn', ?, 20, 'x')").run(b, today(b), JSON.stringify(topicIds)).lastInsertRowid,
    );
    setTaskStatus(a, theirs, "done");
    expect((db.prepare("SELECT status FROM plan_tasks WHERE id = ?").get(theirs) as { status: string }).status).toBe("todo");
    expect(studied(b, topicIds[0])).toBe(false);
  });

  it("ticking other kinds of task records no topic", () => {
    const u = makeUser();
    const { topicIds } = makeExam(u, addDays(today(u), 20), [8]);
    const id = Number(
      db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title) VALUES (?, ?, 'practice', ?, 20, 'x')").run(u, today(u), JSON.stringify(topicIds)).lastInsertRowid,
    );
    setTaskStatus(u, id, "done");
    expect(studied(u, topicIds[0])).toBe(false);
  });
});

describe("countdown uses the student's day, not the server clock", () => {
  it("in a New York evening (already tomorrow in UTC) an exam tomorrow is still 1 day away", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T02:00:00Z")); // 10 pm on the 21st in New York
    const ny = todayIn("America/New_York");
    expect(ny).toBe("2026-10-21");
    expect(daysUntil("2026-10-22", ny)).toBe(1);
    expect(daysUntil("2026-10-22", new Date().toISOString().slice(0, 10))).toBe(0); // what the server clock said before
  });

  it("counts whole days across a daylight-saving change and handles no date", () => {
    expect(daysUntil("2026-11-02", "2026-10-31")).toBe(2);
    expect(daysUntil("2027-03-15", "2027-03-01")).toBe(14);
    expect(daysUntil(null, "2026-10-21")).toBeNull();
    expect(daysUntil("2026-10-20", "2026-10-21")).toBe(-1);
  });
});

describe("calendar feed (ICS)", () => {
  it("leaves archived exams out", async () => {
    const u = makeUser();
    const { examId: kept } = makeExam(u, addDays(today(u), 10), [], "Kept exam");
    const { examId: gone } = makeExam(u, addDays(today(u), 12), [], "Archived exam");
    db.prepare("UPDATE exams SET status = 'archived' WHERE id = ?").run(gone);
    const ics = unfold(await feed(u));
    expect(ics).toContain(`UID:exam-${kept}@dental-study`);
    expect(ics).not.toContain(`UID:exam-${gone}@dental-study`);
    expect(ics).not.toContain("Archived exam");
  });

  it("escapes ; , \\ and newlines in text", async () => {
    expect(icsEscape("a;b,c\\d\ne\r\nf")).toBe("a\\;b\\,c\\\\d\\ne\\nf");
    const u = makeUser();
    const { examId } = makeExam(u, addDays(today(u), 10), [], "Endo; Block, Part \\2");
    db.prepare("UPDATE exams SET course = ? WHERE id = ?").run("Line 1\nLine 2", examId);
    const ics = unfold(await feed(u));
    expect(ics).toContain("SUMMARY:📝 Endo\\; Block\\, Part \\\\2");
    expect(ics).toContain("DESCRIPTION:Line 1\\nLine 2");
  });

  it("folds every line at 75 octets without splitting characters, and unfolds back exactly", async () => {
    const long = "Study: " + "Périapical lésions 🦷 ".repeat(12);
    const folded = foldLine(`SUMMARY:${long}`);
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(unfold(folded)).toBe(`SUMMARY:${long}`);
    expect(folded).not.toContain("�");
    expect(foldLine("SHORT:x")).toBe("SHORT:x");

    const u = makeUser();
    makeExam(u, addDays(today(u), 10), [], "A very long exam name that keeps going and going well past the seventy-five octet limit 🦷🦷");
    const ics = await feed(u);
    expect(ics.endsWith("\r\n")).toBe(true);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(icsBody(["A", "B"])).toBe("A\r\nB\r\n");
  });
});

describe("year view: days with two or more exams", () => {
  it("groups exams by day so a second exam on the same day is marked, not hidden", () => {
    const map = examsByDate([
      { id: 1, exam_date: "2026-11-04" },
      { id: 2, exam_date: "2026-11-04" },
      { id: 3, exam_date: "2026-11-06" },
      { id: 4, exam_date: null },
    ]);
    expect(map.get("2026-11-04")!.map((e) => e.id)).toEqual([1, 2]);
    expect(map.get("2026-11-06")!.length).toBe(1);
    expect([...map.keys()]).toEqual(["2026-11-04", "2026-11-06"]);
  });
});
