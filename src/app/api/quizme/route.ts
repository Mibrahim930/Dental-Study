import { NextResponse } from "next/server";
import { createQuizMe, QuizMeError } from "@/lib/quizMe";
import { ownsExam } from "@/lib/owner";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { aiFailure, readJson } from "@/lib/http";

export const maxDuration = 300;

/** "Quiz me on this": write 3, 5 or 10 questions about the text the student highlighted. */
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { examId, text, size, topicId } = await readJson(request);
  if (!Number.isInteger(examId)) return NextResponse.json({ error: "That exam wasn't found." }, { status: 400 });
  if (!ownsExam(user.id, examId as number)) return notFound();
  if (topicId != null && !Number.isInteger(topicId)) return NextResponse.json({ error: "That section wasn't found. Reload the page and try again." }, { status: 400 });
  if (typeof text !== "string") return NextResponse.json({ error: "Highlight a little more, a sentence or so, to be quizzed on it." }, { status: 400 });
  if (typeof size !== "number") return NextResponse.json({ error: "Pick 3, 5 or 10 questions." }, { status: 400 });

  try {
    const quiz = await createQuizMe({ userId: user.id, examId: examId as number, topicId: (topicId as number | null | undefined) ?? null, text, size });
    return NextResponse.json(quiz);
  } catch (err) {
    if (err instanceof QuizMeError) return NextResponse.json({ error: err.message }, { status: 400 });
    // The technical text goes to the server log; the student sees a plain message (key problems are worth saying).
    return aiFailure(err, `Quiz me for exam ${examId}`, "The AI didn't answer in time. Try again in a moment.");
  }
}
