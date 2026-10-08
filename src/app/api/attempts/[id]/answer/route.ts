import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { CONFIDENCE, type Confidence } from "@/lib/practicePlan";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsAttempt } from "@/lib/owner";

export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[id]/answer">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const ownedId = Number((await ctx.params).id);
  if (!ownsAttempt(user.id, ownedId)) return notFound();
  const attemptId = Number((await ctx.params).id);
  const { questionId, chosen, confidence } = (await request.json()) as { questionId: number; chosen: number; confidence?: string };
  answerQuestion(attemptId, questionId, chosen, CONFIDENCE.includes(confidence as Confidence) ? (confidence as Confidence) : null);
  return NextResponse.json(attemptView(attemptId));
}
