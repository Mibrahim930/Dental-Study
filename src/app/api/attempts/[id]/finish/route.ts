import { NextResponse } from "next/server";
import { finishAttempt } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";

export async function POST(_request: Request, ctx: RouteContext<"/api/attempts/[id]/finish">) {
  const attemptId = Number((await ctx.params).id);
  finishAttempt(attemptId);
  return NextResponse.json(attemptView(attemptId));
}
