// Adding several exams at once: the "+ Add exams" table and both importers (AI read, .ics file) end here.
import { db, type ExamKind } from "./db";
import { duplicateKey, isValidDate, kindOrDefault } from "./calendar";
import { rebuildPlan } from "./planner";

export type NewExam = { name: string; date: string; kind: ExamKind; course: string | null };

export const MAX_EXAMS_PER_ADD = 60;
const MAX_NAME = 120;
const MAX_COURSE = 80;

/** Check rows sent by the browser. Every row needs a name and a real date; the first problem is reported with its row number. */
export function cleanExamRows(input: unknown): { rows: NewExam[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) return { error: "Add at least one exam." };
  if (input.length > MAX_EXAMS_PER_ADD) return { error: `That's more than ${MAX_EXAMS_PER_ADD} exams at once. Add them in two goes.` };
  const rows: NewExam[] = [];
  for (const [i, raw] of input.entries()) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
    const date = typeof r.date === "string" ? r.date.trim() : "";
    const course = typeof r.course === "string" ? r.course.replace(/\s+/g, " ").trim().slice(0, MAX_COURSE) : "";
    if (!name) return { error: `Row ${i + 1} needs a name.` };
    if (!date) return { error: `Row ${i + 1} (${name}) needs a date.` };
    if (!isValidDate(date)) return { error: `Row ${i + 1} (${name}) has a date that doesn't exist.` };
    rows.push({ name, date, kind: kindOrDefault(r.kind), course: course || null });
  }
  return { rows };
}

/** The student's active exams as duplicate keys (name + date), to warn before adding the same exam twice. */
export function existingExamKeys(userId: number): Set<string> {
  return new Set(
    (db.prepare("SELECT name, exam_date FROM exams WHERE user_id = ? AND status = 'active'").all(userId) as { name: string; exam_date: string | null }[]).map(
      (e) => duplicateKey(e.name, e.exam_date),
    ),
  );
}

/** Create every exam in one transaction (all or nothing), then re-plan once. Returns the new exam ids. */
export function createExams(userId: number, rows: NewExam[]): number[] {
  const insert = db.prepare("INSERT INTO exams (user_id, name, course, exam_date, kind) VALUES (?, ?, ?, ?, ?)");
  const ids = db.transaction(() => rows.map((r) => Number(insert.run(userId, r.name, r.course, r.date, r.kind).lastInsertRowid)))();
  rebuildPlan(userId);
  return ids;
}
