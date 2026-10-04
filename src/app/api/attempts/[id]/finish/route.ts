import { NextResponse } from "next/server";
import { finishAttempt } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsAttempt } from "@/lib/owner";

export async function POST(_request: Request, ctx: RouteContext<"/api/attempts/[id]/finish">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const ownedId = Number((await ctx.params).id);
  if (!ownsAttempt(user.id, ownedId)) return notFound();
  const attemptId = Number((await ctx.params).id);
  finishAttempt(attemptId);
  return NextResponse.json(attemptView(attemptId));
}
