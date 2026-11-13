import { NextResponse } from "next/server";
import { attemptView } from "@/lib/attemptView";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsAttempt } from "@/lib/owner";
import { resumeAttempt } from "@/lib/practice";

export async function GET(_request: Request, ctx: RouteContext<"/api/attempts/[id]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const ownedId = Number((await ctx.params).id);
  if (!ownsAttempt(user.id, ownedId)) return notFound();
  // A short exam finishes itself: opening it (or the page polling it) starts writing what is missing, in the
  // background. resumeAttempt decides whether it is time to try; the answer never waits for it.
  resumeAttempt(ownedId);
  const view = attemptView(ownedId);
  if (!view) return notFound();
  return NextResponse.json(view);
}
