import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { getLesson, getSectionQuiz, lessonIsCurrent, quizNeedsWriting, recentFailure, slideNotes, topicPages } from "@/lib/study";
import { topicConcepts } from "@/lib/memory";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";
import { aiFailure } from "@/lib/http";
import { track } from "@/lib/inflight";
import { refuseCrossSite } from "../../crossSite";

export const maxDuration = 300;

/**
 * One section's lesson (written once and cached). When she opens a section herself (not a prefetch), its quiz is
 * started alongside the lesson so it is ready when she finishes reading; the page only asks once she has settled on
 * a section, so sections tapped past cost nothing. Her place and "studied" are NOT set here: the page reports the
 * lesson as shown with POST …/shown. `prefetch=1` (the page warming the next section) never starts a quiz and never
 * retries a lesson whose writing failed a moment ago: it answers 204 instead.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/lesson">) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
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
  if (prefetch && !lessonIsCurrent(topic) && recentFailure("lesson", topic.id)) return new NextResponse(null, { status: 204 });
  // The quiz is written while the lesson is (about a minute sooner than waiting for the lesson to be on screen). Not
  // when it failed a moment ago, and never over a quiz she has answered (quizNeedsWriting).
  if (!prefetch && quizNeedsWriting(topic) && !recentFailure("quiz", topic.id)) {
    void track(getSectionQuiz(topic)).catch((err) => console.error(`Section quiz for topic ${topic.id} (started with the lesson) failed`, err));
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
          const n = slideNotes(p);
          return {
            page_id: p.id,
            where: `${p.filename.replace(/\.pdf$/i, "")}, slide ${p.page_number}`,
            point: n?.emphasis_note ?? n?.key_facts[0] ?? n?.summary ?? p.title ?? "",
          };
        })
        .filter((s) => s.point),
    });
  } catch (err) {
    // The technical text goes to the server log; the student sees a plain message (key problems are worth saying).
    return aiFailure(err, `Lesson for topic ${topic.id}`, "Couldn't write this lesson right now. Try again in a moment.");
  }
}
