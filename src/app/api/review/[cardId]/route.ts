import { NextResponse } from "next/server";
import { reviewCard } from "@/lib/practice";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsCard } from "@/lib/owner";

export async function POST(request: Request, ctx: RouteContext<"/api/review/[cardId]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const cardId = Number((await ctx.params).cardId);
  if (!ownsCard(user.id, cardId)) return notFound();
  const { correct, confidence } = (await request.json()) as { correct: boolean; confidence: "hard" | "good" | "easy" };
  reviewCard(cardId, correct, confidence);
  return NextResponse.json({ ok: true });
}
