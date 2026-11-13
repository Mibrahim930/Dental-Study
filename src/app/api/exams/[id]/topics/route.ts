import { NextResponse } from "next/server";
import { buildTopicMap } from "@/lib/topics";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsExam } from "@/lib/owner";
import { readJson } from "@/lib/http";

/**
 * Build or update the exam's sections. `{ mode: "auto" }` (the default, also for no body) maps only lectures that have
 * no section yet and puts leftover slides in their nearest section without an AI call. `{ mode: "full" }` re-splits
 * every lecture (one AI call each); sections that mostly match an old one keep it (and the student's progress).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/exams/[id]/topics">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const examId = Number((await ctx.params).id);
  if (!ownsExam(user.id, examId)) return notFound();
  const body = await readJson(request);
  if (body.mode !== undefined && body.mode !== "auto" && body.mode !== "full") return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
  void buildTopicMap(examId, body.mode === "full" ? "full" : "auto");
  return NextResponse.json({ ok: true });
}
