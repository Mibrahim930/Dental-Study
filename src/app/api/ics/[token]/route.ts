import { db, type Exam } from "@/lib/db";
import { addDays, tasksOn, userToday } from "@/lib/planner";

// Calendar subscription feed (Google / Apple Calendar). The secret token in the URL identifies the user.
export async function GET(_request: Request, ctx: RouteContext<"/api/ics/[token]">) {
  const token = (await ctx.params).token.replace(/\.ics$/, "");
  const row = db.prepare("SELECT user_id FROM planner_settings WHERE ics_token = ?").get(token) as { user_id: number } | undefined;
  if (!row || token.length < 20) return new Response("Not found", { status: 404 });
  const userId = row.user_id;

  const exams = db.prepare("SELECT * FROM exams WHERE user_id = ? AND exam_date IS NOT NULL").all(userId) as Exam[];
  const busy = db.prepare("SELECT * FROM busy_days WHERE user_id = ?").all(userId) as { id: number; start_date: string; end_date: string; label: string }[];
  const today = userToday(userId);
  const tasks = tasksOn(userId, addDays(today, -14), addDays(today, 180));

  const compact = (d: string) => d.replaceAll("-", "");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lolos Study Buddy//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Lolo's Study Buddy", "METHOD:PUBLISH"];
  const allDay = (uid: string, start: string, endInclusive: string, summary: string, description = "") => {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}@dental-study`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(start)}`,
      `DTEND;VALUE=DATE:${compact(addDays(endInclusive, 1))}`,
      `SUMMARY:${esc(summary)}`,
      ...(description ? [`DESCRIPTION:${esc(description)}`] : []),
      "END:VEVENT",
    );
  };
  for (const e of exams) allDay(`exam-${e.id}`, e.exam_date!, e.exam_date!, `📝 ${e.name}`, e.course ?? "");
  for (const b of busy) allDay(`busy-${b.id}`, b.start_date, b.end_date, `⛔ ${b.label}`);
  const byDay = new Map<string, typeof tasks>();
  for (const t of tasks) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  for (const [day, list] of byDay) {
    const minutes = list.reduce((s, t) => s + t.minutes, 0);
    allDay(`plan-${day}`, day, day, `📚 Study plan (${Math.round(minutes / 6) / 10} h)`, list.map((t) => `${t.status === "done" ? "✓" : "•"} ${t.title} (${t.minutes} min)`).join("\n"));
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n"), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
