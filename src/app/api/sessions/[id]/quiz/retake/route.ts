import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";
import { clearQuizAnswers } from "@/lib/quizProgress";

/** "Retake this quiz": forgets the student's answers for one section's quiz. The questions stay the same. */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/quiz/retake">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  const body = (await request.json().catch(() => null)) as { topicId?: unknown } | null;
  const topicId = body?.topicId;
  if (!Number.isInteger(topicId)) return NextResponse.json({ error: "Unknown section" }, { status: 400 });
  const topic = db.prepare("SELECT t.id FROM topics t JOIN study_sessions s ON s.exam_id = t.exam_id WHERE s.id = ? AND t.id = ?").get(sessionId, topicId);
  if (!topic) return notFound();
  const cleared = clearQuizAnswers(user.id, topicId as number);
  return NextResponse.json({ ok: true, cleared });
}
