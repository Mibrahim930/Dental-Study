import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsQuestion } from "@/lib/owner";

// Student reports a wrong/unclear question. Flagged questions are hidden from review.
export async function POST(request: Request, ctx: RouteContext<"/api/questions/[id]/flag">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const questionId = Number((await ctx.params).id);
  if (!ownsQuestion(user.id, questionId)) return notFound();
  const { note } = (await request.json().catch(() => ({}))) as { note?: string };
  db.prepare("UPDATE questions SET flagged = 1, flag_note = ? WHERE id = ?").run(note ?? null, questionId);
  return NextResponse.json({ ok: true });
}
