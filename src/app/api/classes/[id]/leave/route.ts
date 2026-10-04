import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { leaveClass } from "@/lib/classes";

export async function POST(_request: Request, ctx: RouteContext<"/api/classes/[id]/leave">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  leaveClass(user.id, Number((await ctx.params).id));
  return NextResponse.json({ ok: true });
}
