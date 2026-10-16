import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cleanMarks, emptyMarks, isEmpty, MARKS_KEY } from "@/lib/marks";
import { apiUser, unauthorized } from "@/lib/user";

/** Questions with marks one student can keep (thousands of questions; stops runaway scripts). */
const MAX_ROWS = 20000;

/** Forget marks on practice exams that were deleted (with their exam). */
function pruneDeleted(userId: number) {
  db.prepare(
    `DELETE FROM question_marks WHERE user_id = ? AND key LIKE 'attempt:%'
     AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.id = CAST(substr(question_marks.key, 9, instr(substr(question_marks.key, 9), ':') - 1) AS INTEGER))`,
  ).run(userId);
}

/** A key is usable when it's well formed and, for a practice exam, the exam is this student's. */
function allowed(userId: number, key: unknown): key is string {
  if (typeof key !== "string" || !MARKS_KEY.test(key)) return false;
  if (key.startsWith("attempt:")) {
    const attemptId = Number(key.split(":")[1]);
    return !!db.prepare("SELECT 1 FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.id = ? AND e.user_id = ?").get(attemptId, userId);
  }
  return true; // quiz keys are stored per student, so nobody else's data can be reached through them
}

/** Highlights and cross-outs on one question. */
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const key = new URL(request.url).searchParams.get("key");
  if (!allowed(user.id, key)) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  const row = db.prepare("SELECT json, updated_at FROM question_marks WHERE user_id = ? AND key = ?").get(user.id, key) as
    | { json: string; updated_at: string }
    | undefined;
  return NextResponse.json({ marks: row ? (cleanMarks(JSON.parse(row.json)) ?? emptyMarks()) : null, updated_at: row?.updated_at ?? null });
}

/** Save them (empty marks delete the row). */
export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => null)) as { key?: unknown; marks?: unknown } | null;
  if (!allowed(user.id, body?.key)) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  const marks = cleanMarks(body?.marks);
  if (!marks) return NextResponse.json({ error: "Bad marks" }, { status: 400 });
  const key = body!.key as string;
  if (isEmpty(marks)) {
    db.prepare("DELETE FROM question_marks WHERE user_id = ? AND key = ?").run(user.id, key);
  } else {
    const json = JSON.stringify(marks);
    // cleanMarks already caps each text at 100 highlights (about 17,000 characters for a full question); this is a backstop.
    if (json.length > 40000) return NextResponse.json({ error: "Too many highlights" }, { status: 400 });
    const exists = db.prepare("SELECT 1 FROM question_marks WHERE user_id = ? AND key = ?").get(user.id, key);
    if (!exists && (db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ?").get(user.id) as { n: number }).n >= MAX_ROWS) {
      // Make room by forgetting marks on practice exams that no longer exist, then check again.
      pruneDeleted(user.id);
      if ((db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ?").get(user.id) as { n: number }).n >= MAX_ROWS) {
        return NextResponse.json({ error: "Too many highlighted questions" }, { status: 400 });
      }
    }
    db.prepare(
      `INSERT INTO question_marks (user_id, key, json) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET json = excluded.json, updated_at = datetime('now')`,
    ).run(user.id, key, json);
  }
  return NextResponse.json({ ok: true });
}
