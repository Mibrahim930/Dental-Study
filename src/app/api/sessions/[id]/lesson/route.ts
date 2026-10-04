import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { getLesson } from "@/lib/study";
import { topicConcepts } from "@/lib/memory";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

export const maxDuration = 300;

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/lesson">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  if (!ownsSession(user.id, Number((await ctx.params).id))) return notFound();
  const sessionId = Number((await ctx.params).id);
  const url = new URL(request.url);
  const position = Number(url.searchParams.get("position") ?? 0);
  const prefetch = url.searchParams.get("prefetch") === "1";
  const session = db.prepare("SELECT exam_id FROM study_sessions WHERE id = ?").get(sessionId) as { exam_id: number } | undefined;
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const topic = db.prepare("SELECT * FROM topics WHERE exam_id = ? AND position = ?").get(session.exam_id, position) as Topic | undefined;
  if (!topic) return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  if (!prefetch) db.prepare("UPDATE study_sessions SET current_position = ? WHERE id = ?").run(position, sessionId);

  try {
    const lesson = await getLesson(topic);
    const aspects = Object.fromEntries(
      (db.prepare(`SELECT id, aspect FROM pages WHERE id IN (${lesson.slides.map(() => "?").join(",") || "NULL"})`).all(
        ...lesson.slides.map((s) => s.page_id),
      ) as { id: number; aspect: number }[]).map((r) => [r.id, r.aspect]),
    );
    return NextResponse.json({
      topic: { id: topic.id, title: topic.title, summary: topic.summary, emphasized: !!topic.emphasized },
      concepts: topicConcepts(topic.id, session.exam_id),
      lesson,
      aspects,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
