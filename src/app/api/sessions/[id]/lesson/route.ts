import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { getLesson, getSectionQuiz, quizIsCurrent, topicPages } from "@/lib/study";
import { parseNotes } from "@/lib/processing";
import { markTopicStudied } from "@/lib/planner";
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
  if (!prefetch) {
    db.prepare("UPDATE study_sessions SET current_position = ? WHERE id = ?").run(position, sessionId);
    markTopicStudied(user.id, topic.id);
    // Start writing this topic's section quiz now, alongside the lesson, instead of after it (saves ~30 s on a first
    // open). The quiz request the page sends once the lesson shows joins this same run (getSectionQuiz shares one
    // generation per topic). Only for the topic she actually opened, never for a prefetch: a cached quiz costs nothing,
    // and the next topic's quiz isn't written until she goes there.
    if (!quizIsCurrent(topic)) {
      void getSectionQuiz(topic).catch((err) => console.error(`Section quiz for topic ${topic.id} (started with the lesson) failed`, err));
    }
  }

  try {
    const lesson = await getLesson(topic);
    const pages = topicPages(topic);
    // Every slide of the section: its width/height ratio (space reserved before the picture loads) and, for the slides
    // the lesson walks through, the number and lecture shown above the picture.
    const aspects = Object.fromEntries(pages.map((p) => [p.id, p.aspect]));
    const slideInfo = Object.fromEntries(
      pages.map((p) => [p.id, { number: p.page_number, lecture: p.filename.replace(/\.pdf$/i, ""), emphasized: !!p.emphasized }]),
    );
    return NextResponse.json({
      topic: { id: topic.id, title: topic.title, summary: topic.summary, emphasized: !!topic.emphasized },
      concepts: topicConcepts(topic.id, session.exam_id),
      // Only slides that are still in this section (a stored lesson can predate a slide's removal).
      lesson: { ...lesson, slides: (lesson.slides ?? []).filter((s) => s.page_id in slideInfo) },
      aspects,
      slideInfo,
      // Slides the professor emphasized, with what was stressed, for the "Your professor stressed this" block.
      stressed: pages
        .filter((p) => p.emphasized)
        .map((p) => {
          const n = parseNotes(p);
          return {
            page_id: p.id,
            where: `${p.filename.replace(/\.pdf$/i, "")}, slide ${p.page_number}`,
            point: n?.emphasis_note ?? n?.key_facts?.[0] ?? n?.summary ?? p.title ?? "",
          };
        })
        .filter((s) => s.point),
    });
  } catch (err) {
    // The technical text goes to the server log; the student sees a plain message (key problems are worth saying).
    console.error(`Lesson for topic ${topic.id} failed`, err);
    const msg = err instanceof Error ? err.message : String(err);
    const keyProblem = /key|auth|401|403|credit|billing/i.test(msg);
    return NextResponse.json({ error: keyProblem ? msg : "Couldn't write this lesson right now. Try again in a moment." }, { status: 500 });
  }
}
