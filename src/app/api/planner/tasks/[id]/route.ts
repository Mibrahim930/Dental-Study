import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { setTaskStatus } from "@/lib/planner";

// Manually tick a task on or off.
export async function POST(request: Request, ctx: RouteContext<"/api/planner/tasks/[id]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { status } = (await request.json()) as { status?: string };
  setTaskStatus(user.id, Number((await ctx.params).id), status === "done" ? "done" : "todo");
  return NextResponse.json({ ok: true });
}
