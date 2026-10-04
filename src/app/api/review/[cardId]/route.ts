import { NextResponse } from "next/server";
import { reviewCard } from "@/lib/practice";

export async function POST(request: Request, ctx: RouteContext<"/api/review/[cardId]">) {
  const { correct, confidence } = (await request.json()) as { correct: boolean; confidence: "hard" | "good" | "easy" };
  reviewCard(Number((await ctx.params).cardId), correct, confidence);
  return NextResponse.json({ ok: true });
}
