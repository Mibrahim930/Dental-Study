import { NextResponse } from "next/server";
import { getQuizMe } from "@/lib/quizMe";
import { apiUser, notFound, unauthorized } from "@/lib/user";

/** One "quiz me" quiz with the answers given so far (its owner only). */
export async function GET(_request: Request, ctx: RouteContext<"/api/quizme/[id]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const quiz = getQuizMe(user.id, Number((await ctx.params).id));
  return quiz ? NextResponse.json(quiz) : notFound();
}
