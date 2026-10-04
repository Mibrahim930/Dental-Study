import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";

export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[id]/answer">) {
  const attemptId = Number((await ctx.params).id);
  const { questionId, chosen } = (await request.json()) as { questionId: number; chosen: number };
  answerQuestion(attemptId, questionId, chosen);
  return NextResponse.json(attemptView(attemptId));
}
