import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { addDays, MAX_DAY_MINUTES, setDayOverride, userToday } from "@/lib/planner";
import { isValidDate } from "@/lib/calendar";

/** "Study time this day": body { date, minutes } sets it (0 = day off), { date, minutes: null } goes back to the usual. */
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  let body: { date?: unknown; minutes?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Something went wrong sending that. Try again." }, { status: 400 });
  }
  const today = userToday(user.id);
  if (!isValidDate(body.date)) return NextResponse.json({ error: "Pick a day." }, { status: 400 });
  if (body.date < today) return NextResponse.json({ error: "That day has passed." }, { status: 400 });
  if (body.date > addDays(today, 731)) return NextResponse.json({ error: "Pick a day in the next two years." }, { status: 400 });
  if (body.minutes !== null && (typeof body.minutes !== "number" || !Number.isFinite(body.minutes) || body.minutes < 0 || body.minutes > MAX_DAY_MINUTES)) {
    return NextResponse.json({ error: "Enter between 0 and 16 hours." }, { status: 400 });
  }
  const warnings = setDayOverride(user.id, body.date, body.minutes as number | null);
  return NextResponse.json({ ok: true, warnings });
}
