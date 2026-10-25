import { NextResponse } from "next/server";
import { answerQuizMe, QuizMeError } from "@/lib/quizMe";
import { apiUser, notFound, unauthorized } from "@/lib/user";

/** Record one answer to a "quiz me" question. Correctness is decided here, not by the browser; the first answer stands. */
export async function POST(request: Request, ctx: RouteContext<"/api/quizme/[id]/answer">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const id = Number((await ctx.params).id);
  const body = (await request.json().catch(() => null)) as { index?: unknown; chosen?: unknown } | null;
  const { index, chosen } = body ?? {};
  if (!Number.isInteger(index) || !Number.isInteger(chosen)) return NextResponse.json({ error: "Unknown question or answer" }, { status: 400 });
  try {
    const result = answerQuizMe({ userId: user.id, id, index: index as number, chosen: chosen as number });
    return result ? NextResponse.json(result) : notFound();
  } catch (err) {
    if (err instanceof QuizMeError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
