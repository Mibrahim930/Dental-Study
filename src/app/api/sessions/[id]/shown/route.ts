import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { getSectionQuiz, quizNeedsWriting, recentFailure, recordShown } from "@/lib/study";
import { markTopicStudied } from "@/lib/planner";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";
import { readJson } from "@/lib/http";
import { track } from "@/lib/inflight";

/**
 * The page says a section's lesson is on screen. Only now does the section count: her place moves there, it is marked
 * studied, and its quiz is started in the background (when there is none yet, or an out-of-date one nobody answered)
 * so it is ready when she reaches it. Sections skipped past are never paid for. Answers at once; never waits for the quiz.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/shown">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  const position = (await readJson(request)).position;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0) return NextResponse.json({ error: "Unknown section" }, { status: 400 });
  const topic = db
    .prepare("SELECT t.* FROM topics t JOIN study_sessions s ON s.exam_id = t.exam_id WHERE s.id = ? AND t.position = ?")
    .get(sessionId, position) as Topic | undefined;
  if (!topic) return notFound();
  // A session she already ended (the page was left open): nothing moves and nothing is paid for.
  const ended = db.prepare("SELECT ended_at FROM study_sessions WHERE id = ?").get(sessionId) as { ended_at: string | null };
  if (ended.ended_at) return NextResponse.json({ ok: true });

  db.prepare("UPDATE study_sessions SET current_position = ? WHERE id = ?").run(position, sessionId);
  markTopicStudied(user.id, topic.id);
  recordShown(sessionId, topic.id);
  // A quiz whose writing failed a moment ago isn't started again on its own (she can still ask for it from the quiz).
  if (quizNeedsWriting(topic) && !recentFailure("quiz", topic.id)) {
    void track(getSectionQuiz(topic)).catch((err) => console.error(`Section quiz for topic ${topic.id} (started when the lesson showed) failed`, err));
  }
  return NextResponse.json({ ok: true });
}
