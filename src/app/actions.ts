"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/user";

export async function createExam(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const course = String(formData.get("course") ?? "").trim() || null;
  const date = String(formData.get("exam_date") ?? "").trim() || null;
  const user = await requireUser();
  const id = db.prepare("INSERT INTO exams (user_id, name, course, exam_date) VALUES (?, ?, ?, ?)").run(user.id, name, course, date).lastInsertRowid;
  redirect(`/exams/${id}`);
}

export async function updateExam(id: number, formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  db.prepare("UPDATE exams SET name = ?, course = ?, exam_date = ? WHERE id = ? AND user_id = ?").run(
    name,
    String(formData.get("course") ?? "").trim() || null,
    String(formData.get("exam_date") ?? "").trim() || null,
    id,
    user.id,
  );
  revalidatePath(`/exams/${id}`);
}

export async function setArchived(id: number, archived: boolean) {
  const user = await requireUser();
  db.prepare("UPDATE exams SET status = ? WHERE id = ? AND user_id = ?").run(archived ? "archived" : "active", id, user.id);
  revalidatePath("/");
  revalidatePath(`/exams/${id}`);
}
