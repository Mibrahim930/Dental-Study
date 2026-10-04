import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsAttempt } from "@/lib/owner";

export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[id]/answer">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const ownedId = Number((await ctx.params).id);
  if (!ownsAttempt(user.id, ownedId)) return notFound();
  const attemptId = Number((await ctx.params).id);
  const { questionId, chosen } = (await request.json()) as { questionId: number; chosen: number };
  answerQuestion(attemptId, questionId, chosen);
  return NextResponse.json(attemptView(attemptId));
}
