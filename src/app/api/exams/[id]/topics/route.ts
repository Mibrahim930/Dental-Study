import { NextResponse } from "next/server";
import { buildTopicMap } from "@/lib/topics";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsExam } from "@/lib/owner";

export async function POST(_request: Request, ctx: RouteContext<"/api/exams/[id]/topics">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const examId = Number((await ctx.params).id);
  if (!ownsExam(user.id, examId)) return notFound();
  void buildTopicMap(examId);
  return NextResponse.json({ ok: true });
}
