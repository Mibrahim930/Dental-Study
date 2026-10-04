import { NextResponse } from "next/server";
import { db, type ExamKind } from "@/lib/db";
import { apiUser, unauthorized } from "@/lib/user";
import { rebuildPlan } from "@/lib/planner";

const KINDS: ExamKind[] = ["block", "quiz", "practical", "board", "other"];

// Adding an exam on the calendar creates its exam workspace.
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { name, course, kind, date } = (await request.json()) as { name?: string; course?: string; kind?: ExamKind; date?: string };
  if (!name?.trim()) return NextResponse.json({ error: "Give the exam a name." }, { status: 400 });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Pick a date." }, { status: 400 });
  const id = Number(
    db
      .prepare("INSERT INTO exams (user_id, name, course, exam_date, kind) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, name.trim(), course?.trim() || null, date, KINDS.includes(kind as ExamKind) ? kind : "block").lastInsertRowid,
  );
  rebuildPlan(user.id);
  return NextResponse.json({ id });
}
