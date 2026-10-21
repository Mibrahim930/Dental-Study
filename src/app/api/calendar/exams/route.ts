import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, unauthorized } from "@/lib/user";
import { rebuildPlan } from "@/lib/planner";
import { isValidDate, kindOrDefault } from "@/lib/calendar";
import { cleanExamRows, createExams } from "@/lib/examImport";

// Adding an exam on the calendar creates its exam workspace.
// Body: one exam { name, course, kind, date }, or several { exams: [...] } (the "+ Add exams" table and the importers),
// which are all created in one go and re-planned once.
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return NextResponse.json({ error: "Something went wrong sending that. Try again." }, { status: 400 });
  }

  if ("exams" in body) {
    const cleaned = cleanExamRows(body.exams);
    if ("error" in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 });
    const ids = createExams(user.id, cleaned.rows);
    return NextResponse.json({ ids, added: ids.length });
  }

  const { name, course, kind, date } = body as { name?: unknown; course?: unknown; kind?: unknown; date?: unknown };
  if (typeof name !== "string" || !name.trim()) return NextResponse.json({ error: "Give the exam a name." }, { status: 400 });
  if (!isValidDate(date)) return NextResponse.json({ error: "Pick a date." }, { status: 400 });
  const id = Number(
    db
      .prepare("INSERT INTO exams (user_id, name, course, exam_date, kind) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, name.trim(), (typeof course === "string" && course.trim()) || null, date, kindOrDefault(kind)).lastInsertRowid,
  );
  rebuildPlan(user.id);
  return NextResponse.json({ id });
}
