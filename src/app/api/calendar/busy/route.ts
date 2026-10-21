import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, unauthorized } from "@/lib/user";
import { addDays, rebuildPlan } from "@/lib/planner";
import { isValidDate } from "@/lib/calendar";
import { firstOccurrence, maskOf } from "@/lib/busy";

/**
 * Mark busy days. Body: { start, end, label } for a range, or { start, label, weekdays: [0..6], until } for
 * "Repeats every week on … until …" (0 = Monday).
 */
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  let body: { start?: unknown; end?: unknown; label?: unknown; weekdays?: unknown; until?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Something went wrong sending that. Try again." }, { status: 400 });
  }
  const { start, end, weekdays, until } = body;
  const label = (typeof body.label === "string" && body.label.replace(/\s+/g, " ").trim().slice(0, 80)) || "Busy";
  if (!isValidDate(start)) return NextResponse.json({ error: "Pick a start date." }, { status: 400 });

  // A repeat is asked for when weekdays (even an empty list) or an until date is sent.
  if (Array.isArray(weekdays) || until !== undefined) {
    const days = Array.isArray(weekdays) ? weekdays : [];
    if (days.length === 0 || !days.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) {
      return NextResponse.json({ error: "Pick at least one day of the week." }, { status: 400 });
    }
    const mask = maskOf(days as number[]);
    if (!isValidDate(until) || until < start) return NextResponse.json({ error: "Pick the date it repeats until (on or after the start)." }, { status: 400 });
    if (until > addDays(start, 731)) return NextResponse.json({ error: "A repeat can run for up to two years. Pick an earlier end date." }, { status: 400 });
    if (!firstOccurrence({ id: 0, start_date: start, end_date: until, label, weekdays: mask })) {
      return NextResponse.json({ error: "None of those days fall between the start and end dates." }, { status: 400 });
    }
    db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label, weekdays) VALUES (?, ?, ?, ?, ?)").run(user.id, start, until, label, mask);
  } else {
    const last = isValidDate(end) && end >= start ? end : start;
    db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label) VALUES (?, ?, ?, ?)").run(user.id, start, last, label);
  }
  rebuildPlan(user.id);
  return NextResponse.json({ ok: true });
}
