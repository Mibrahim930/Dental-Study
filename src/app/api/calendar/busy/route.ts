import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, unauthorized } from "@/lib/user";
import { rebuildPlan } from "@/lib/planner";

const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { start, end, label } = (await request.json()) as { start?: string; end?: string; label?: string };
  if (!isDate(start)) return NextResponse.json({ error: "Pick a start date." }, { status: 400 });
  const last = isDate(end) && end >= start ? end : start;
  db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label) VALUES (?, ?, ?, ?)").run(user.id, start, last, label?.trim() || "Busy");
  rebuildPlan(user.id);
  return NextResponse.json({ ok: true });
}
