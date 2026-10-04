"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";

export async function createExam(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const course = String(formData.get("course") ?? "").trim() || null;
  const date = String(formData.get("exam_date") ?? "").trim() || null;
  const id = db.prepare("INSERT INTO exams (name, course, exam_date) VALUES (?, ?, ?)").run(name, course, date).lastInsertRowid;
  redirect(`/exams/${id}`);
}

export async function updateExam(id: number, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  db.prepare("UPDATE exams SET name = ?, course = ?, exam_date = ? WHERE id = ?").run(
    name,
    String(formData.get("course") ?? "").trim() || null,
    String(formData.get("exam_date") ?? "").trim() || null,
    id,
  );
  revalidatePath(`/exams/${id}`);
}

export async function setArchived(id: number, archived: boolean) {
  db.prepare("UPDATE exams SET status = ? WHERE id = ?").run(archived ? "archived" : "active", id);
  revalidatePath("/");
  revalidatePath(`/exams/${id}`);
}
