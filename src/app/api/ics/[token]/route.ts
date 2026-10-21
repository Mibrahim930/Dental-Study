import { db, type Exam } from "@/lib/db";
import { addDays, tasksOn, userToday } from "@/lib/planner";
import { compactDate, ICS_DAYS, icsBody, icsEscape } from "@/lib/ics";
import { daysOf, firstOccurrence, isRepeating, loadBusy } from "@/lib/busy";

// Calendar subscription feed (Google / Apple Calendar). The secret token in the URL identifies the user.
export async function GET(_request: Request, ctx: RouteContext<"/api/ics/[token]">) {
  const token = (await ctx.params).token.replace(/\.ics$/, "");
  const row = db.prepare("SELECT user_id FROM planner_settings WHERE ics_token = ?").get(token) as { user_id: number } | undefined;
  if (!row || token.length < 20) return new Response("Not found", { status: 404 });
  const userId = row.user_id;

  // Archived exams are finished with: they leave the feed like they leave the plan.
  const exams = db.prepare("SELECT * FROM exams WHERE user_id = ? AND exam_date IS NOT NULL AND status = 'active'").all(userId) as Exam[];
  const busy = loadBusy(userId);
  const today = userToday(userId);
  const tasks = tasksOn(userId, addDays(today, -14), addDays(today, 180));

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lolos Study Buddy//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Lolo's Study Buddy", "METHOD:PUBLISH"];
  const allDay = (uid: string, start: string, endInclusive: string, summary: string, description = "") => {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}@dental-study`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(start)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(endInclusive, 1))}`,
      `SUMMARY:${icsEscape(summary)}`,
      ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
      "END:VEVENT",
    );
  };
  for (const e of exams) allDay(`exam-${e.id}`, e.exam_date!, e.exam_date!, `📝 ${e.name}`, e.course ?? "");
  for (const b of busy.rows) {
    if (!isRepeating(b)) {
      allDay(`busy-${b.id}`, b.start_date, b.end_date, `⛔ ${b.label}`);
      continue;
    }
    // A weekly repeat is one repeating event: first real occurrence, BYDAY, UNTIL (a DATE, like DTSTART), skipped weeks as EXDATE.
    const first = firstOccurrence(b);
    if (!first) continue;
    const skipped = [...busy.skips].filter((k) => k.startsWith(`${b.id}|`)).map((k) => compactDate(k.split("|")[1])).sort();
    lines.push(
      "BEGIN:VEVENT",
      `UID:busy-${b.id}@dental-study`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(first)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(first, 1))}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${daysOf(b.weekdays).map((d) => ICS_DAYS[d]).join(",")};UNTIL=${compactDate(b.end_date)}`,
      ...(skipped.length ? [`EXDATE;VALUE=DATE:${skipped.join(",")}`] : []),
      `SUMMARY:${icsEscape(`⛔ ${b.label}`)}`,
      "END:VEVENT",
    );
  }
  const byDay = new Map<string, typeof tasks>();
  for (const t of tasks) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  for (const [day, list] of byDay) {
    const minutes = list.reduce((s, t) => s + t.minutes, 0);
    allDay(`plan-${day}`, day, day, `📚 Study plan (${Math.round(minutes / 6) / 10} h)`, list.map((t) => `${t.status === "done" ? "✓" : "•"} ${t.title} (${t.minutes} min)`).join("\n"));
  }
  lines.push("END:VCALENDAR");
  return new Response(icsBody(lines), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
