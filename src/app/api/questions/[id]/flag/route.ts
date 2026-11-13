import { NextResponse } from "next/server";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsQuestion } from "@/lib/owner";
import { flagQuestionEverywhere } from "@/lib/classes";
import { cleanReason } from "@/lib/reportedQuestions";
import { saveQuestionReport } from "@/lib/practice";
import { readJson } from "@/lib/http";

/**
 * Report a practice question outside an exam (daily review, an old results page): flagged everywhere (own and class
 * copies; never in a new exam or the review again), and the owner gets the record. Mid-exam, the attempt's own report
 * route is used instead, so the exam's score drops it too.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/questions/[id]/flag">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const questionId = Number((await ctx.params).id);
  if (!ownsQuestion(user.id, questionId)) return notFound();
  const body = await readJson(request);
  const reason = cleanReason(typeof body.reason === "string" ? body.reason : body.note);
  flagQuestionEverywhere(questionId, reason);
  saveQuestionReport(user.id, questionId, body.source === "practice" ? "practice" : "review", reason);
  return NextResponse.json({ ok: true });
}
