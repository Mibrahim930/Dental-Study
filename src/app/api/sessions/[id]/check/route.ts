import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/check">) {
  const sessionId = Number((await ctx.params).id);
  const { topicId, question, correct } = (await request.json()) as { topicId: number; question: string; correct: boolean };
  db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct) VALUES (?, ?, ?, ?)").run(
    sessionId,
    topicId,
    question,
    correct ? 1 : 0,
  );
  return NextResponse.json({ ok: true });
}
