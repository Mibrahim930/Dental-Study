import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import type { QuizQuestion } from "@/lib/study";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

/**
 * Report a problem with a section-quiz question: it's hidden from this copy of the exam from now on.
 * The question stays in place (hidden) so positions, and the answers that refer to them, never shift.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/quiz/report">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  const body = (await request.json().catch(() => null)) as { topicId?: unknown; questionId?: unknown; note?: unknown } | null;
  const { topicId, questionId } = body ?? {};
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  if (!Number.isInteger(topicId) || typeof questionId !== "string" || !questionId) {
    return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  }

  const ok = db.transaction(() => {
    const topic = db
      .prepare("SELECT t.* FROM topics t JOIN study_sessions s ON s.exam_id = t.exam_id WHERE s.id = ? AND t.id = ?")
      .get(sessionId, topicId) as Topic | undefined;
    if (!topic?.checks_json) return false;
    const qs = JSON.parse(topic.checks_json) as QuizQuestion[];
    const i = qs.findIndex((q) => q.id === questionId);
    if (i === -1) return false;
    qs[i] = { ...qs[i], hidden: true, report_note: qs[i].report_note ?? note };
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(qs), topic.id);
    return true;
  })();
  if (!ok) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
