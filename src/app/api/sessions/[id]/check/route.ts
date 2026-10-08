import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { recordConceptResult, upsertConcept } from "@/lib/memory";
import type { QuizQuestion } from "@/lib/study";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

/** Record one answer to a section-quiz question. Correctness is decided here, not by the browser. */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/check">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  const { topicId, index, chosen } = (await request.json()) as { topicId: number; index: number; chosen: number };

  const topic = db
    .prepare("SELECT t.* FROM topics t JOIN study_sessions s ON s.exam_id = t.exam_id WHERE s.id = ? AND t.id = ?")
    .get(sessionId, topicId) as Topic | undefined;
  const q = topic?.checks_json ? (JSON.parse(topic.checks_json) as QuizQuestion[])[index] : undefined;
  if (!topic || !q || !Number.isInteger(chosen) || chosen < 0 || chosen >= q.options.length) {
    return NextResponse.json({ error: "Unknown question or answer" }, { status: 400 });
  }
  const already = db.prepare("SELECT 1 FROM session_checks WHERE session_id = ? AND topic_id = ? AND check_index = ?").get(sessionId, topicId, index);
  if (already) return NextResponse.json({ ok: true });

  const correct = chosen === q.correct_index;
  db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, ?, ?, ?, ?)").run(
    sessionId,
    topicId,
    q.question,
    correct ? 1 : 0,
    index,
    chosen,
  );
  // Section quiz answers count toward concept mastery, like practice exams.
  if (q.concept) recordConceptResult(upsertConcept(user.id, q.concept), correct);
  return NextResponse.json({ ok: true, correct });
}
