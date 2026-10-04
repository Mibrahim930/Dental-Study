import { NextResponse } from "next/server";
import { buildTopicMap } from "@/lib/topics";

export async function POST(_request: Request, ctx: RouteContext<"/api/exams/[id]/topics">) {
  void buildTopicMap(Number((await ctx.params).id));
  return NextResponse.json({ ok: true });
}
