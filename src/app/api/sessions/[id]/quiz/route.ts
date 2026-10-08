import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { getSectionQuiz } from "@/lib/study";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

export const maxDuration = 300;

/** The section quiz for one topic of a study session, plus the answers already given in this session. */
export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/quiz">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  const position = Number(new URL(request.url).searchParams.get("position") ?? 0);
  const session = db.prepare("SELECT exam_id FROM study_sessions WHERE id = ?").get(sessionId) as { exam_id: number } | undefined;
  if (!session) return notFound();
  const topic = db.prepare("SELECT * FROM topics WHERE exam_id = ? AND position = ?").get(session.exam_id, position) as Topic | undefined;
  if (!topic) return notFound();

  try {
    const questions = await getSectionQuiz(topic);
    const answered = Object.fromEntries(
      (
        db
          .prepare("SELECT check_index, chosen FROM session_checks WHERE session_id = ? AND topic_id = ? AND check_index IS NOT NULL")
          .all(sessionId, topic.id) as { check_index: number; chosen: number }[]
      ).map((r) => [r.check_index, r.chosen]),
    );
    return NextResponse.json({ topicId: topic.id, questions, answered });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
