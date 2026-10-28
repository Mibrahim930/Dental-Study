import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getQuizMe, hideQuizMeQuestion } from "@/lib/quizMe";
import { cleanReason, saveReportedQuestion, slideOrigin } from "@/lib/reportedQuestions";
import { apiUser, notFound, unauthorized } from "@/lib/user";

/** Report a "quiz me" / lecture-review question: it leaves the quiz and its score, and the owner gets the record. */
export async function POST(request: Request, ctx: RouteContext<"/api/quizme/[id]/report">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const id = Number((await ctx.params).id);
  const body = (await request.json().catch(() => null)) as { index?: unknown; reason?: unknown } | null;
  const index = body?.index;
  if (!Number.isInteger(index)) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  const reason = cleanReason(body?.reason);
  const hidden = hideQuizMeQuestion(user.id, id, index as number, reason);
  if (!hidden) return notFound();
  const { row, question } = hidden;
  const exam = db.prepare("SELECT name FROM exams WHERE id = ?").get(row.exam_id) as { name: string } | undefined;
  saveReportedQuestion({
    userId: user.id,
    examId: row.exam_id,
    topicId: row.topic_id,
    source: row.kind === "lecture" ? "lecture_review" : "quizme",
    ref: `quizme:${row.id}:${index}`,
    question: {
      question: question.question,
      options: question.options,
      correct_index: question.correct_index,
      explanation: question.explanation,
      option_notes: question.option_notes,
      concept: question.concept,
      ...slideOrigin(question.source_page_id, row.topic_id),
      exam: exam?.name ?? null,
    },
    reason,
  });
  return NextResponse.json({ ok: true, quiz: getQuizMe(user.id, id) });
}
