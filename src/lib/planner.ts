// Study planner: turns upcoming exams, busy days and weekly study time into a day-by-day task list.
//
// For each upcoming exam:
//   - one "learn" task per topic not yet studied (sized by slide count),
//   - a short practice exam after every few topics,
//   - a weak-topic review two days before and a timed practice exam the day before.
// Days are filled in order; at each step the exam that is furthest behind (most work left relative to
// the study time left before it) gets the next slot, so several exams interleave naturally.
// A daily spaced-review block is reserved first whenever the student has review cards.
// Future to-do tasks are thrown away and rebuilt whenever something changes; finished tasks are kept.
import crypto from "crypto";
import { db, type Exam, type Topic } from "./db";
import { busyOn, loadBusy } from "./busy";

export type PlanTask = {
  id: number;
  user_id: number;
  date: string;
  exam_id: number | null;
  kind: "learn" | "practice" | "weak_review" | "final_practice" | "review" | "upload";
  topic_ids: string;
  minutes: number;
  title: string;
  status: "todo" | "done" | "missed";
};

export type PlannerSettings = {
  user_id: number;
  weekday_minutes: string; // JSON number[7], Monday first
  review_minutes: number;
  timezone: string;
  ics_token: string | null;
  warnings: string;
  rebuilt_on: string | null;
  missed_seen_through: string | null;
};

/** An exam whose work doesn't all fit before it. Newer warnings also say what was left out and the extra time per day that would cover it. */
export type PlanWarning = { examId: number; examName: string; minutesShort: number; topicsLeft?: number; starredLeft?: number; starredTotal?: number; perDay?: number };

const LEARN_GROUP = 3; // practice after every N topics
const MIN_PER_SLIDE = 2;

// ---- Dates (plain YYYY-MM-DD strings, computed in the student's time zone) ----

export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday */
export function weekday(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// ---- Settings ----

export function plannerSettings(userId: number): PlannerSettings {
  db.prepare("INSERT OR IGNORE INTO planner_settings (user_id) VALUES (?)").run(userId);
  return db.prepare("SELECT * FROM planner_settings WHERE user_id = ?").get(userId) as PlannerSettings;
}

export function userToday(userId: number): string {
  return todayIn(plannerSettings(userId).timezone);
}

export function icsToken(userId: number): string {
  const s = plannerSettings(userId);
  if (s.ics_token) return s.ics_token;
  return regenerateIcsToken(userId);
}

export function regenerateIcsToken(userId: number): string {
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare("UPDATE planner_settings SET ics_token = ? WHERE user_id = ?").run(token, userId);
  return token;
}

// ---- Building the plan ----

type Draft = Omit<PlanTask, "id" | "user_id" | "status">;
type ExamQueue = { exam: Exam; deadline: string; queue: Draft[] };

function topicMinutes(topic: Topic): number {
  const slides = (JSON.parse(topic.page_ids) as number[]).length;
  return Math.min(60, Math.max(15, 10 + slides * MIN_PER_SLIDE));
}

/** Rebuild the user's plan from today forward. Returns exams that don't fit in the available time. */
export function rebuildPlan(userId: number): PlanWarning[] {
  const settings = plannerSettings(userId);
  const today = todayIn(settings.timezone);
  const weekdayMinutes = JSON.parse(settings.weekday_minutes) as number[];

  db.prepare("UPDATE plan_tasks SET status = 'missed' WHERE user_id = ? AND status = 'todo' AND date < ?").run(userId, today);
  db.prepare("DELETE FROM plan_tasks WHERE user_id = ? AND status = 'todo' AND date >= ?").run(userId, today);

  const exams = db
    .prepare("SELECT * FROM exams WHERE user_id = ? AND status = 'active' AND exam_date > ? ORDER BY exam_date")
    .all(userId, today) as Exam[];
  const finish = (warnings: PlanWarning[]) => {
    db.prepare("UPDATE planner_settings SET warnings = ?, rebuilt_on = ? WHERE user_id = ?").run(JSON.stringify(warnings), today, userId);
    return warnings;
  };
  if (exams.length === 0) return finish([]);

  // Capacity per day (minutes), from today to the day before the last exam.
  const lastDay = addDays(exams[exams.length - 1].exam_date!, -1);
  // One-off ranges and weekly repeats (minus skipped weeks), decided by the same helper the calendar and feed use.
  const busy = loadBusy(userId, today);
  const isBusy = (d: string) => busyOn(busy.rows, busy.skips, d).length > 0;
  // "Study time this day" overrides (0 = day off) replace the weekday's usual hours; a busy day still wins.
  const overrides = dayOverrides(userId, today);
  const doneToday = (db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM plan_tasks WHERE user_id = ? AND date = ? AND status = 'done'").get(userId, today) as {
    m: number;
  }).m;
  const days: string[] = [];
  const cap = new Map<string, number>();
  for (let d = today; d <= lastDay; d = addDays(d, 1)) {
    days.push(d);
    let minutes = isBusy(d) ? 0 : (overrides.get(d) ?? weekdayMinutes[weekday(d)] ?? 0);
    if (d === today) minutes = Math.max(0, minutes - doneToday);
    cap.set(d, minutes);
  }
  const studyDays = new Map(cap); // each day's study time before anything is placed

  const out: Draft[] = [];
  const place = (task: Draft, day: string) => {
    out.push({ ...task, date: day });
    cap.set(day, (cap.get(day) ?? 0) - task.minutes);
  };

  // 1. Daily spaced review, when there is anything to review.
  const hasCards = !!db
    .prepare("SELECT 1 FROM review_cards r JOIN questions q ON q.id = r.question_id JOIN exams e ON e.id = q.exam_id WHERE e.user_id = ? LIMIT 1")
    .get(userId);
  const reviewDoneToday = !!db.prepare("SELECT 1 FROM plan_tasks WHERE user_id = ? AND date = ? AND kind = 'review' AND status = 'done'").get(userId, today);
  if (hasCards) {
    for (const d of days) {
      const c = cap.get(d)!;
      if (c <= 0 || (d === today && reviewDoneToday)) continue;
      place({ date: d, exam_id: null, kind: "review", topic_ids: "[]", minutes: Math.min(settings.review_minutes, c), title: "Daily review" }, d);
    }
  }

  // 2. Per-exam work.
  const studied = new Set(
    (db.prepare("SELECT topic_id FROM topic_study WHERE user_id = ?").all(userId) as { topic_id: number }[]).map((r) => r.topic_id),
  );
  const queues: ExamQueue[] = [];
  for (const exam of exams) {
    const examDay = exam.exam_date!;
    const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(exam.id) as Topic[];
    if (topics.length === 0) {
      const docs = (db.prepare("SELECT COUNT(*) n FROM documents WHERE exam_id = ?").get(exam.id) as { n: number }).n;
      if (docs === 0) {
        out.push({ date: today, exam_id: exam.id, kind: "upload", topic_ids: "[]", minutes: 5, title: `Upload lectures for ${exam.name}` });
      }
      continue;
    }

    // Final stretch, pinned to fixed days (moved earlier if that day is unavailable).
    const pin = (task: Omit<Draft, "date">, daysBefore: number) => {
      for (let d = addDays(examDay, -daysBefore); d >= today; d = addDays(d, -1)) {
        if ((cap.get(d) ?? 0) > 0) return place({ ...task, date: d }, d);
      }
    };
    pin({ exam_id: exam.id, kind: "final_practice", topic_ids: "[]", minutes: 45, title: `Timed practice exam: ${exam.name}` }, 1);
    pin({ exam_id: exam.id, kind: "weak_review", topic_ids: "[]", minutes: 30, title: `Review your weakest topics: ${exam.name}` }, 2);

    const queue: Draft[] = [];
    let group: Topic[] = [];
    // Learning should wrap up three days out, leaving room for the final stretch.
    const deadline = addDays(examDay, -3) >= today ? addDays(examDay, -3) : addDays(examDay, -1);
    let remaining = topics.filter((t) => !studied.has(t.id));
    // Not enough time for everything: the topics the professor emphasized go first, so what doesn't fit is lighter material.
    const needed = remaining.reduce((m, t) => m + topicMinutes(t), 0) + Math.ceil(remaining.length / LEARN_GROUP) * 20;
    const available = days.filter((d) => d <= deadline).reduce((m, d) => m + Math.max(0, cap.get(d) ?? 0), 0);
    if (needed > available) remaining = [...remaining.filter((t) => t.emphasized), ...remaining.filter((t) => !t.emphasized)];
    remaining.forEach((t, i) => {
      queue.push({ date: "", exam_id: exam.id, kind: "learn", topic_ids: JSON.stringify([t.id]), minutes: topicMinutes(t), title: `Study: ${t.title}` });
      group.push(t);
      if (group.length === LEARN_GROUP || i === remaining.length - 1) {
        queue.push({
          date: "",
          exam_id: exam.id,
          kind: "practice",
          topic_ids: JSON.stringify(group.map((g) => g.id)),
          minutes: 20,
          title: `Practice quiz (${group.length} topic${group.length === 1 ? "" : "s"}): ${exam.name}`,
        });
        group = [];
      }
    });
    queues.push({ exam, deadline, queue });
  }

  // 3. Fill days, always serving the exam that is furthest behind. Each exam is paced: per day it gets
  //    roughly its remaining work divided by the study days left, so learning is spread out (better for
  //    memory, and a missed day doesn't sink the plan) instead of crammed into the first days.
  const minutesLeft = (q: ExamQueue) => q.queue.reduce((s, t) => s + t.minutes, 0);
  const capacityBetween = (from: string, to: string) => days.filter((d) => d >= from && d <= to).reduce((sum, d) => sum + Math.max(0, cap.get(d)!), 0);
  const studyDaysBetween = (from: string, to: string) => days.filter((d) => d >= from && d <= to && cap.get(d)! > 0).length;
  for (const day of days) {
    if (cap.get(day)! <= 0) continue;
    const quota = new Map(queues.map((q) => [q, (minutesLeft(q) / Math.max(1, studyDaysBetween(day, q.deadline))) * 1.25]));
    const given = new Map<ExamQueue, number>();
    for (;;) {
      const room = cap.get(day)!;
      const open = queues.filter((q) => q.queue.length > 0 && q.deadline >= day);
      if (open.length === 0 || room <= 0) break;
      const ranked = open
        .map((q) => ({ q, urgency: minutesLeft(q) / Math.max(1, capacityBetween(day, q.deadline)) }))
        .sort((a, b) => b.urgency - a.urgency || a.q.deadline.localeCompare(b.q.deadline));
      // Within pace (always allow one task per exam per day), and with a little overflow so a 45-minute
      // topic still fits a 40-minute gap.
      const pick = ranked.find(({ q }) => {
        const already = given.get(q) ?? 0;
        return q.queue[0].minutes <= room + 10 && (already === 0 || already + q.queue[0].minutes <= quota.get(q)!);
      });
      if (!pick) break;
      const task = pick.q.queue.shift()!;
      given.set(pick.q, (given.get(pick.q) ?? 0) + task.minutes);
      place(task, day);
    }
  }

  const warnings: PlanWarning[] = queues
    .filter((q) => q.queue.length > 0)
    .map((q) => {
      const minutesShort = q.queue.reduce((s, t) => s + t.minutes, 0);
      const left = q.queue.filter((t) => t.kind === "learn").map((t) => (JSON.parse(t.topic_ids) as number[])[0]);
      const starredLeft = left.length
        ? (db.prepare(`SELECT COUNT(*) n FROM topics WHERE emphasized = 1 AND id IN (${left.map(() => "?").join(",")})`).get(...left) as { n: number }).n
        : 0;
      return {
        examId: q.exam.id,
        examName: q.exam.name,
        minutesShort,
        topicsLeft: left.length,
        starredLeft,
        starredTotal: (db.prepare("SELECT COUNT(*) n FROM topics WHERE exam_id = ? AND emphasized = 1").get(q.exam.id) as { n: number }).n,
        perDay: Math.ceil(minutesShort / Math.max(1, days.filter((d) => d <= q.deadline && (studyDays.get(d) ?? 0) > 0).length)),
      };
    });

  const insert = db.prepare(
    "INSERT INTO plan_tasks (user_id, date, exam_id, kind, topic_ids, minutes, title) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const t of out) insert.run(userId, t.date, t.exam_id, t.kind, t.topic_ids, t.minutes, t.title);
  })();
  return finish(warnings);
}

// ---- Per-day study time ----

export const MAX_DAY_MINUTES = 16 * 60;

/** Days with their own study time, from `from` on (date → minutes). */
export function dayOverrides(userId: number, from: string): Map<string, number> {
  return new Map(
    (db.prepare("SELECT date, minutes FROM day_overrides WHERE user_id = ? AND date >= ?").all(userId, from) as { date: string; minutes: number }[]).map((r) => [
      r.date,
      r.minutes,
    ]),
  );
}

/** Set (or with null, clear) one day's study time, then re-plan. Minutes are clamped to 0–16 h. */
export function setDayOverride(userId: number, date: string, minutes: number | null): PlanWarning[] {
  if (minutes == null) db.prepare("DELETE FROM day_overrides WHERE user_id = ? AND date = ?").run(userId, date);
  else {
    const m = Math.min(MAX_DAY_MINUTES, Math.max(0, Math.round(minutes)));
    db.prepare("INSERT INTO day_overrides (user_id, date, minutes) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET minutes = excluded.minutes").run(userId, date, m);
  }
  return rebuildPlan(userId);
}

// ---- Missed tasks and "Re-plan from today" ----

const MISSED_WINDOW_DAYS = 7;

/** Missed tasks from the last week that she hasn't re-planned yet: how many, and whether they were all yesterday. */
export function missedSummary(userId: number): { count: number; yesterdayOnly: boolean } {
  const s = plannerSettings(userId);
  const today = todayIn(s.timezone);
  const yesterday = addDays(today, -1);
  // Only the last week, and nothing up to the day she last pressed "Re-plan from today".
  const floor = addDays(today, -MISSED_WINDOW_DAYS - 1);
  const since = s.missed_seen_through && s.missed_seen_through > floor ? s.missed_seen_through : floor;
  const rows = db
    // "Upload lectures for …" is a reminder re-made every day, not study she skipped: it doesn't count.
    .prepare("SELECT date FROM plan_tasks WHERE user_id = ? AND status = 'missed' AND kind != 'upload' AND date > ? AND date < ?")
    .all(userId, since, today) as { date: string }[];
  return { count: rows.length, yesterdayOnly: rows.length > 0 && rows.every((r) => r.date === yesterday) };
}

/**
 * "Re-plan from today": rebuild now (missed topics go back into the coming days), mark the missed tasks as dealt with so
 * the note goes away, and say what came back.
 */
export function replanFromToday(userId: number): { warnings: PlanWarning[]; topicsBack: number; message: string } {
  const s = plannerSettings(userId);
  const today = todayIn(s.timezone);
  const missedLearn = db
    .prepare("SELECT topic_ids FROM plan_tasks WHERE user_id = ? AND status = 'missed' AND kind = 'learn' AND date > ? AND date < ?")
    .all(userId, addDays(today, -MISSED_WINDOW_DAYS - 1), today) as { topic_ids: string }[];
  const warnings = rebuildPlan(userId);
  db.prepare("UPDATE planner_settings SET missed_seen_through = ? WHERE user_id = ?").run(addDays(today, -1), userId);
  const missedTopics = new Set(missedLearn.flatMap((t) => JSON.parse(t.topic_ids) as number[]));
  const planned = new Set(
    (db.prepare("SELECT topic_ids FROM plan_tasks WHERE user_id = ? AND status = 'todo' AND kind = 'learn' AND date >= ?").all(userId, today) as { topic_ids: string }[]).flatMap(
      (t) => JSON.parse(t.topic_ids) as number[],
    ),
  );
  const topicsBack = [...missedTopics].filter((id) => planned.has(id)).length;
  const back = topicsBack ? `${topicsBack} missed ${topicsBack === 1 ? "topic is" : "topics are"} back in your plan.` : "Your plan now starts from today.";
  const tight = warnings.length ? ` Not everything fits before ${warnings.map((w) => w.examName).join(" and ")}; the note on the calendar says what to do.` : "";
  return { warnings, topicsBack, message: `Done. ${back}${tight}` };
}

/** Rebuild once a day (missed tasks roll forward) — call from pages the student visits. */
export function ensurePlanFresh(userId: number) {
  const s = plannerSettings(userId);
  if (s.rebuilt_on !== todayIn(s.timezone)) rebuildPlan(userId);
}

// ---- Progress hooks ----

/** A topic was opened in a study session: record it and tick off its "learn" task. */
export function markTopicStudied(userId: number, topicId: number) {
  db.prepare("INSERT OR IGNORE INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(userId, topicId);
  db.prepare(
    `UPDATE plan_tasks SET status = 'done', completed_at = datetime('now')
     WHERE user_id = ? AND kind = 'learn' AND status = 'todo' AND EXISTS (SELECT 1 FROM json_each(plan_tasks.topic_ids) WHERE value = ?)`,
  ).run(userId, topicId);
}

/**
 * Tick a task on or off by hand. Ticking a "Study: …" task counts its topic as studied (like opening it), so the next
 * re-plan doesn't schedule it again; unticking takes that back. Missed tasks stay missed (their work is already re-planned).
 */
export function setTaskStatus(userId: number, taskId: number, status: "todo" | "done") {
  const task = db.prepare("SELECT kind, topic_ids, status, completed_at FROM plan_tasks WHERE id = ? AND user_id = ?").get(taskId, userId) as
    | (Pick<PlanTask, "kind" | "topic_ids" | "status"> & { completed_at: string | null })
    | undefined;
  if (!task || task.status === "missed") return;
  db.transaction(() => {
    db.prepare("UPDATE plan_tasks SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') END WHERE id = ? AND user_id = ?").run(
      status,
      status,
      taskId,
      userId,
    );
    if (task.kind !== "learn") return;
    // Only this student's own topics (a forged task row can't touch someone else's).
    const topics = (JSON.parse(task.topic_ids) as number[]).filter(
      (id) => !!db.prepare("SELECT 1 FROM topics t JOIN exams e ON e.id = t.exam_id WHERE t.id = ? AND e.user_id = ?").get(id, userId),
    );
    for (const id of topics) {
      if (status === "done") db.prepare("INSERT OR IGNORE INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(userId, id);
      // Unticking takes back only what the tick recorded: a topic she opened in a study session earlier stays studied.
      else if (task.completed_at) db.prepare("DELETE FROM topic_study WHERE user_id = ? AND topic_id = ? AND studied_at >= ?").run(userId, id, task.completed_at);
    }
  })();
}

export function tasksOn(userId: number, from: string, to: string): (PlanTask & { exam_name: string | null })[] {
  return db
    .prepare(
      `SELECT t.*, e.name AS exam_name FROM plan_tasks t LEFT JOIN exams e ON e.id = t.exam_id
       WHERE t.user_id = ? AND t.date BETWEEN ? AND ? ORDER BY t.date, CASE t.kind WHEN 'review' THEN 0 ELSE 1 END, t.id`,
    )
    .all(userId, from, to) as (PlanTask & { exam_name: string | null })[];
}

/** Topics with the lowest mastery in an exam (for the weak-topic review). */
export function weakestTopics(examId: number, limit = 4): number[] {
  return (
    db
      .prepare(
        `SELECT t.id, AVG(CASE WHEN c.attempts > 0 THEN (c.correct + 1.0) / (c.attempts + 2) ELSE 0.5 END) m
         FROM topics t LEFT JOIN topic_concepts tc ON tc.topic_id = t.id LEFT JOIN concepts c ON c.id = tc.concept_id
         WHERE t.exam_id = ? GROUP BY t.id ORDER BY m ASC LIMIT ?`,
      )
      .all(examId, limit) as { id: number }[]
  ).map((r) => r.id);
}
