import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, unauthorized } from "@/lib/user";
import { plannerSettings, rebuildPlan } from "@/lib/planner";
import { readJson } from "@/lib/http";

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  // Fields that are missing or of the wrong type keep their saved value.
  const body = await readJson(request);
  const s = plannerSettings(user.id);
  const minutes =
    Array.isArray(body.weekdayMinutes) && body.weekdayMinutes.length === 7
      ? body.weekdayMinutes.map((m) => Math.min(16 * 60, Math.max(0, Math.round(Number(m) || 0))))
      : (JSON.parse(s.weekday_minutes) as number[]);
  const review = Math.min(120, Math.max(0, Math.round(typeof body.reviewMinutes === "number" && Number.isFinite(body.reviewMinutes) ? body.reviewMinutes : s.review_minutes)));
  let tz = s.timezone;
  if (typeof body.timezone === "string" && body.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
      tz = body.timezone;
    } catch {
      /* keep the old time zone */
    }
  }
  db.prepare("UPDATE planner_settings SET weekday_minutes = ?, review_minutes = ?, timezone = ? WHERE user_id = ?").run(
    JSON.stringify(minutes),
    review,
    tz,
    user.id,
  );
  return NextResponse.json({ warnings: rebuildPlan(user.id) });
}
