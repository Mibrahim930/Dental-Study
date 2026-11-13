import { NextResponse } from "next/server";
import { countDue, reviewCard } from "@/lib/practice";
import { db } from "@/lib/db";
import { userToday } from "@/lib/planner";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsCard } from "@/lib/owner";
import { readJson } from "@/lib/http";

export async function POST(request: Request, ctx: RouteContext<"/api/review/[cardId]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const cardId = Number((await ctx.params).cardId);
  if (!ownsCard(user.id, cardId)) return notFound();
  const { correct, confidence } = await readJson(request);
  if (typeof correct !== "boolean") return NextResponse.json({ error: "Something went wrong sending that. Try again." }, { status: 400 });
  reviewCard(cardId, correct, confidence === "hard" || confidence === "easy" ? confidence : "good");
  // Review queue cleared: tick off today's review task.
  if (countDue(user.id) === 0) {
    db.prepare("UPDATE plan_tasks SET status = 'done', completed_at = datetime('now') WHERE user_id = ? AND kind = 'review' AND date = ? AND status = 'todo'").run(
      user.id,
      userToday(user.id),
    );
  }
  return NextResponse.json({ ok: true });
}
