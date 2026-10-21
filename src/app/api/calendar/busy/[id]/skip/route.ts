import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { rebuildPlan } from "@/lib/planner";
import { isValidDate } from "@/lib/calendar";
import { coversDate, isRepeating, type BusyRow } from "@/lib/busy";

/** "Skip this week" on a repeating busy day (body { date }), or put the week back (body { date, undo: true }). */
export async function POST(request: Request, ctx: RouteContext<"/api/calendar/busy/[id]/skip">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const id = Number((await ctx.params).id);
  const row = db.prepare("SELECT id, start_date, end_date, label, weekdays FROM busy_days WHERE id = ? AND user_id = ?").get(id, user.id) as BusyRow | undefined;
  if (!row) return notFound();
  let body: { date?: unknown; undo?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!isValidDate(body.date)) return NextResponse.json({ error: "Pick a day." }, { status: 400 });
  if (!isRepeating(row) || !coversDate(row, body.date)) return NextResponse.json({ error: `${row.label} doesn't happen on that day.` }, { status: 400 });
  if (body.undo === true) db.prepare("DELETE FROM busy_skips WHERE busy_id = ? AND date = ?").run(id, body.date);
  else db.prepare("INSERT OR IGNORE INTO busy_skips (busy_id, date) VALUES (?, ?)").run(id, body.date);
  rebuildPlan(user.id);
  return NextResponse.json({ ok: true });
}
