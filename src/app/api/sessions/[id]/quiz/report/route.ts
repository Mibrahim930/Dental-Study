import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import type { QuizQuestion } from "@/lib/study";
import { cleanReason, saveReportedQuestion, slideOrigin } from "@/lib/reportedQuestions";
import { hideQuizQuestionEverywhere } from "@/lib/quizProgress";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

/**
 * Report a section-quiz question: it's hidden from this quiz from now on (out of the score too) in every copy of the
 * exam (own and class copies share question ids), and the owner gets the record. The question stays in place (hidden)
 * so positions, and the answers that refer to them, never shift.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/quiz/report">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  const body = (await request.json().catch(() => null)) as { topicId?: unknown; questionId?: unknown; note?: unknown; reason?: unknown } | null;
  const { topicId, questionId } = body ?? {};
  const reason = cleanReason(typeof body?.reason === "string" ? body.reason : body?.note);
  if (!Number.isInteger(topicId) || typeof questionId !== "string" || !questionId) {
    return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  }

  const reported = db.transaction((): QuizQuestion | null => {
    const topic = db
      .prepare("SELECT t.* FROM topics t JOIN study_sessions s ON s.exam_id = t.exam_id WHERE s.id = ? AND t.id = ?")
      .get(sessionId, topicId) as Topic | undefined;
    if (!topic?.checks_json) return null;
    const own = (JSON.parse(topic.checks_json) as QuizQuestion[]).find((q) => q.id === questionId);
    if (!own) return null;
    // Already reported (a double tap): nothing more to hide, and no second record.
    if (hideQuizQuestionEverywhere(topic.id, questionId, reason) === 0) return null;
    saveReportedQuestion({
      userId: user.id,
      examId: topic.exam_id,
      topicId: topic.id,
      source: "quiz",
      ref: `quiz:${topic.id}:${questionId}`,
      question: {
        question: own.question,
        options: own.options,
        correct_index: own.correct_index,
        explanation: own.explanation,
        option_notes: own.option_notes ?? null,
        concept: own.concept,
        ...slideOrigin(own.source_page_id, topic.id),
        exam: (db.prepare("SELECT name FROM exams WHERE id = ?").get(topic.exam_id) as { name: string }).name,
      },
      reason,
    });
    return own;
  })();
  if (!reported) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
