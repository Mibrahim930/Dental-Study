import { NextResponse } from "next/server";
import { reportAttemptQuestion } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { cleanReason } from "@/lib/reportedQuestions";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsAttempt } from "@/lib/owner";

/**
 * Report a question during (or after) a practice exam: it leaves this exam and its score, is flagged everywhere (own
 * and class copies, never in a new exam or the daily review), and the owner gets the record.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[id]/report">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const attemptId = Number((await ctx.params).id);
  if (!ownsAttempt(user.id, attemptId)) return notFound();
  const body = (await request.json().catch(() => null)) as { questionId?: unknown; reason?: unknown } | null;
  if (!Number.isInteger(body?.questionId)) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  if (!reportAttemptQuestion(user.id, attemptId, body!.questionId as number, cleanReason(body?.reason))) {
    return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  }
  return NextResponse.json(attemptView(attemptId));
}
