import { NextResponse } from "next/server";
import { lectureReviewStatus, openLectureReview, QuizMeError } from "@/lib/quizMe";
import { ownsExam } from "@/lib/owner";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { readJson } from "@/lib/http";

const ids = (examId: unknown, documentId: unknown) => (Number.isInteger(examId) && Number.isInteger(documentId) ? { examId: examId as number, documentId: documentId as number } : null);

/** Lecture review status: `{ missed, open }` — how many missed questions wait, and the unfinished review to resume. */
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const p = ids(Number(url.searchParams.get("examId")), Number(url.searchParams.get("documentId")));
  if (!p || !ownsExam(user.id, p.examId)) return notFound();
  return NextResponse.json(lectureReviewStatus(user.id, p.examId, p.documentId));
}

/** Open the lecture review (resume the unfinished one, or make it from every current miss). No AI call. */
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const body = await readJson(request);
  const p = ids(body.examId, body.documentId);
  if (!p) return NextResponse.json({ error: "That lecture wasn't found." }, { status: 400 });
  if (!ownsExam(user.id, p.examId)) return notFound();
  try {
    return NextResponse.json(openLectureReview(user.id, p.examId, p.documentId));
  } catch (err) {
    if (err instanceof QuizMeError) return NextResponse.json({ error: err.message }, { status: 400 });
    // Anything else is ours, not hers: the detail goes to the log, she gets a plain sentence.
    console.error(`Lecture review for exam ${p.examId}, lecture ${p.documentId} failed`, err);
    return NextResponse.json({ error: "The review couldn't be opened. Try again in a moment." }, { status: 500 });
  }
}
