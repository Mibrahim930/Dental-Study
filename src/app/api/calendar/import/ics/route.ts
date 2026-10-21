import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { addDays, plannerSettings, todayIn } from "@/lib/planner";
import { parseIcs } from "@/lib/icsImport";

/** Keep in step with MAX_IMPORT_MB in ImportSchedule.tsx. */
const MAX_IMPORT_MB = 20;
/** Most a confirm screen should list; school feeds can hold over a thousand items. */
const MAX_RETURNED = 400;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * "Import a calendar file (.ics) from your school": the file's events with a date in the student's zone, whether each
 * looks like an exam and whether it's past. Saves nothing (the confirm screen does). No AI, no cost.
 */
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  if (Number(request.headers.get("content-length")) > MAX_IMPORT_MB * 1024 * 1024) return fail(`That file is over ${MAX_IMPORT_MB} MB.`, 413);
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail("That didn't arrive in one piece. Check your connection and try again.");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return fail("Choose a calendar file (.ics) first.");
    if (file.size > MAX_IMPORT_MB * 1024 * 1024) return fail(`That file is over ${MAX_IMPORT_MB} MB.`, 413);
    const text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 5000))) {
      return fail("That doesn't look like a calendar file. In Canvas or your school calendar, look for \"Export\" or \"Calendar feed\" and download the .ics file.");
    }
    const timezone = plannerSettings(user.id).timezone;
    const today = todayIn(timezone);
    const { events, truncated } = parseIcs(text, timezone);
    // Upcoming first; past events only from the last year (a feed can go back many years).
    const yearAgo = addDays(today, -366);
    const kept = events.filter((e) => e.date >= yearAgo);
    const upcoming = kept.filter((e) => e.date >= today);
    const past = kept.filter((e) => e.date < today).reverse();
    const pick = [...upcoming.filter((e) => e.looksLikeExam), ...past.filter((e) => e.looksLikeExam), ...upcoming.filter((e) => !e.looksLikeExam), ...past.filter((e) => !e.looksLikeExam)].slice(
      0,
      MAX_RETURNED,
    );
    pick.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    return NextResponse.json({
      events: pick.map((e) => ({ name: e.name, date: e.date, course: e.course, kind: e.kind, looksLikeExam: e.looksLikeExam, past: e.date < today, recurring: e.recurring })),
      total: events.length,
      cut: truncated || kept.length > pick.length,
    });
  } catch (err) {
    console.error("ICS import failed", err);
    return fail("We couldn't read that calendar file. Try exporting it again, or paste the exam dates instead.");
  }
}
