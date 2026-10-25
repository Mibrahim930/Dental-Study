import { NextResponse } from "next/server";
import { openQuizMe } from "@/lib/quizMe";
import { ownsExam } from "@/lib/owner";
import { apiUser, notFound, unauthorized } from "@/lib/user";

/** The newest unfinished "quiz me" quiz for an exam, so it can be resumed: `{ quiz }`, null when there's none. */
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const examId = Number(new URL(request.url).searchParams.get("examId"));
  if (!Number.isInteger(examId) || !ownsExam(user.id, examId)) return notFound();
  return NextResponse.json({ quiz: openQuizMe(user.id, examId) });
}
