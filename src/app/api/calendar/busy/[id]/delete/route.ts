import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, unauthorized } from "@/lib/user";
import { rebuildPlan } from "@/lib/planner";

export async function POST(_request: Request, ctx: RouteContext<"/api/calendar/busy/[id]/delete">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  db.prepare("DELETE FROM busy_days WHERE id = ? AND user_id = ?").run(Number((await ctx.params).id), user.id);
  rebuildPlan(user.id);
  return NextResponse.json({ ok: true });
}
