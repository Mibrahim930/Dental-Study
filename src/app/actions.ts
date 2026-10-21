"use server";
import { redirect } from "next/navigation";
import { refresh, revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/user";
import { rebuildPlan } from "@/lib/planner";
import { isValidDate } from "@/lib/calendar";
import type { ExamKind } from "@/lib/db";
import { themeOf } from "@/lib/themes";

export async function setTheme(formData: FormData) {
  const user = await requireUser();
  db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(themeOf(String(formData.get("theme") ?? "")), user.id);
  revalidatePath("/", "layout");
}

const KINDS: ExamKind[] = ["block", "quiz", "practical", "board", "other"];
const kindOf = (v: FormDataEntryValue | null): ExamKind => (KINDS.includes(v as ExamKind) ? (v as ExamKind) : "block");

export async function createExam(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const course = String(formData.get("course") ?? "").trim() || null;
  const date = String(formData.get("exam_date") ?? "").trim() || null;
  const user = await requireUser();
  const id = db
    .prepare("INSERT INTO exams (user_id, name, course, exam_date, kind) VALUES (?, ?, ?, ?, ?)")
    .run(user.id, name, course, date, kindOf(formData.get("kind"))).lastInsertRowid;
  rebuildPlan(user.id);
  redirect(`/exams/${id}`);
}

export async function updateExam(id: number, formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  db.prepare("UPDATE exams SET name = ?, course = ?, exam_date = ?, kind = ? WHERE id = ? AND user_id = ?").run(
    name,
    String(formData.get("course") ?? "").trim() || null,
    String(formData.get("exam_date") ?? "").trim() || null,
    kindOf(formData.get("kind")),
    id,
    user.id,
  );
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
