import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsQuestion } from "@/lib/owner";
import { flagQuestionEverywhere } from "@/lib/classes";
import { cleanReason, saveReportedQuestion, slideOrigin } from "@/lib/reportedQuestions";

type QRow = { id: number; exam_id: number; topic_id: number | null; stem: string; options: string; correct_index: number; explanation: string; option_notes: string | null; source_page_id: number | null; concept: string | null; exam: string };

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
  const body = (await request.json().catch(() => ({}))) as { note?: unknown; reason?: unknown; source?: unknown };
  const reason = cleanReason(body.reason ?? body.note);
  flagQuestionEverywhere(questionId, reason);
  const q = db
    .prepare(
      `SELECT q.id, q.exam_id, q.topic_id, q.stem, q.options, q.correct_index, q.explanation, q.option_notes, q.source_page_id, c.name AS concept, e.name AS exam
       FROM questions q JOIN exams e ON e.id = q.exam_id LEFT JOIN concepts c ON c.id = q.concept_id WHERE q.id = ?`,
    )
    .get(questionId) as QRow;
  saveReportedQuestion({
    userId: user.id,
    examId: q.exam_id,
    topicId: q.topic_id,
    source: body.source === "practice" ? "practice" : "review",
    ref: `question:${q.id}`,
    question: {
      question: q.stem,
      options: JSON.parse(q.options) as string[],
      correct_index: q.correct_index,
      explanation: q.explanation,
      option_notes: q.option_notes ? (JSON.parse(q.option_notes) as string[]) : null,
      concept: q.concept,
      ...slideOrigin(q.source_page_id, q.topic_id),
      exam: q.exam,
    },
    reason,
  });
  return NextResponse.json({ ok: true });
}
