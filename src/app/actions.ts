"use server";
import { redirect } from "next/navigation";
import { refresh, revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/user";
import { rebuildPlan } from "@/lib/planner";
import { isValidDate } from "@/lib/calendar";
import type { ExamKind } from "@/lib/db";
import { themeOf } from "@/lib/themes";
import { examText, MAX_COURSE, MAX_NAME } from "@/lib/examImport";

export async function setTheme(formData: FormData) {
  const user = await requireUser();
  db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(themeOf(String(formData.get("theme") ?? "")), user.id);
  revalidatePath("/", "layout");
}

const KINDS: ExamKind[] = ["block", "quiz", "practical", "board", "other"];
const kindOf = (v: FormDataEntryValue | null): ExamKind => (KINDS.includes(v as ExamKind) ? (v as ExamKind) : "block");

/**
 * The exam form's fields, cleaned like a row of the "+ Add exams" table (one line, capped lengths). The date is optional
 * here, and these forms have no way to show an error, so a date that isn't a real day is saved as no date (the exam
 * then sits under "Exams without a date") instead of reaching the planner, which can't plan around "zzz".
 */
function examFields(formData: FormData) {
  const date = String(formData.get("exam_date") ?? "").trim();
  return {
    name: examText(formData.get("name"), MAX_NAME),
    course: examText(formData.get("course"), MAX_COURSE) || null,
    date: isValidDate(date) ? date : null,
    kind: kindOf(formData.get("kind")),
  };
}

export async function createExam(formData: FormData) {
  const { name, course, date, kind } = examFields(formData);
  if (!name) return;
  const user = await requireUser();
  const id = db.prepare("INSERT INTO exams (user_id, name, course, exam_date, kind) VALUES (?, ?, ?, ?, ?)").run(user.id, name, course, date, kind).lastInsertRowid;
  rebuildPlan(user.id);
  redirect(`/exams/${id}`);
}

export async function updateExam(id: number, formData: FormData) {
  const user = await requireUser();
  const { name, course, date, kind } = examFields(formData);
  if (!name) return;
  db.prepare("UPDATE exams SET name = ?, course = ?, exam_date = ?, kind = ? WHERE id = ? AND user_id = ?").run(name, course, date, kind, id, user.id);
  rebuildPlan(user.id);
  revalidatePath(`/exams/${id}`);
}

/**
 * Give a dateless exam its date from the calendar's "Exams without a date" list (same update and re-plan as updateExam,
 * date only). Used with useActionState: returns an error message, or null when saved.
 */
export async function setExamDate(_prev: { error: string } | null, formData: FormData): Promise<{ error: string } | null> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const date = String(formData.get("exam_date") ?? "").trim();
  if (!isValidDate(date)) return { error: "Pick a date first." };
  const changed = db.prepare("UPDATE exams SET exam_date = ? WHERE id = ? AND user_id = ?").run(date, id, user.id).changes;
  if (!changed) return { error: "That exam couldn't be found. Reload the page and try again." };
  rebuildPlan(user.id);
  revalidatePath("/");
  refresh();
  return null;
}

export async function setArchived(id: number, archived: boolean) {
  const user = await requireUser();
  db.prepare("UPDATE exams SET status = ? WHERE id = ? AND user_id = ?").run(archived ? "archived" : "active", id, user.id);
  rebuildPlan(user.id);
  revalidatePath("/");
  revalidatePath(`/exams/${id}`);
}
