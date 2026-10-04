import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/check">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  if (!ownsSession(user.id, Number((await ctx.params).id))) return notFound();
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
