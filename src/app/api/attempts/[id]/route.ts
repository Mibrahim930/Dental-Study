import { NextResponse } from "next/server";
import { attemptView } from "@/lib/attemptView";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsAttempt } from "@/lib/owner";

export async function GET(_request: Request, ctx: RouteContext<"/api/attempts/[id]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const ownedId = Number((await ctx.params).id);
  if (!ownsAttempt(user.id, ownedId)) return notFound();
  const view = attemptView(Number((await ctx.params).id));
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view);
}
