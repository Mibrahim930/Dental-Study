import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { setTaskStatus } from "@/lib/planner";
import { readJson } from "@/lib/http";

// Manually tick a task on or off.
export async function POST(request: Request, ctx: RouteContext<"/api/planner/tasks/[id]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { status } = await readJson(request);
  // Only an explicit status: a garbled body must not untick a task.
  if (status !== "done" && status !== "todo") return NextResponse.json({ error: "Something went wrong sending that. Try again." }, { status: 400 });
  setTaskStatus(user.id, Number((await ctx.params).id), status);
  return NextResponse.json({ ok: true });
}
