import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { getSectionQuiz } from "@/lib/study";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

export const maxDuration = 300;

/**
 * "Write new questions": the only way a topic's section quiz changes once written. The fresh quiz is written first and
 * swapped in only when it's ready (answers to the old one stay in history, detached), so a failed rewrite loses nothing.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/quiz/regenerate">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  const body = (await request.json().catch(() => null)) as { topicId?: unknown } | null;
  const topicId = body?.topicId;
  if (!Number.isInteger(topicId)) return NextResponse.json({ error: "Unknown topic" }, { status: 400 });
  const topic = db
    .prepare("SELECT t.* FROM topics t JOIN study_sessions s ON s.exam_id = t.exam_id WHERE s.id = ? AND t.id = ?")
    .get(sessionId, topicId) as Topic | undefined;
  if (!topic) return NextResponse.json({ error: "Unknown topic" }, { status: 400 });

  try {
    // Passing the topic without its cached quiz makes getSectionQuiz write a new one; it replaces the old quiz and
    // detaches its answers in one transaction at the very end, so the old questions stay until the new ones exist.
    const questions = await getSectionQuiz({ ...topic, checks_json: null, checks_version: null });
    return NextResponse.json({ ok: true, count: questions.length });
  } catch (err) {
    console.error(`Rewriting the section quiz for topic ${topic.id} failed`, err);
    const msg = err instanceof Error ? err.message : String(err);
    const keyProblem = /key|auth|401|403|credit|billing/i.test(msg);
    return NextResponse.json({ error: keyProblem ? msg : "The AI didn't answer in time. Try again in a moment." }, { status: 500 });
  }
}
