import { NextResponse } from "next/server";
import { startAttempt, type Mode, type Style } from "@/lib/practice";

export async function POST(request: Request, ctx: RouteContext<"/api/exams/[id]/attempts">) {
  const examId = Number((await ctx.params).id);
  const body = (await request.json()) as { size?: number; mode?: Mode; style?: Style; topicIds?: number[] };
  const size = Math.min(Math.max(Number(body.size) || 25, 5), 100);
  const id = startAttempt(examId, {
    size,
    mode: body.mode === "timed" ? "timed" : "tutor",
    style: body.style === "recall" || body.style === "case" ? body.style : "mixed",
    topicIds: body.topicIds,
  });
  return NextResponse.json({ id });
}
