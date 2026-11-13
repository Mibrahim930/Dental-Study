import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cleanMarks, emptyMarks, isEmpty, MARKS_KEY } from "@/lib/marks";
import { apiUser, unauthorized } from "@/lib/user";
import { readJson } from "@/lib/http";

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

/**
 * Marks that can be asked for together, by the start of their keys: one lesson's blocks ("lesson:<topic>:"), so opening
 * a section is one request instead of one per slide. Lesson keys are stored per student, like quiz keys.
 */
const MARKS_PREFIX = /^lesson:\d{1,12}:$/;

/** More rows than any lesson has blocks; a backstop. */
const MAX_PREFIX_ROWS = 500;

/** Marks read from a stored row: an unreadable row behaves like no marks (the next save replaces it). */
function parsed(json: string) {
  try {
    return cleanMarks(JSON.parse(json)) ?? emptyMarks();
  } catch {
    return emptyMarks();
  }
}

/**
 * Highlights and cross-outs on one question (`?key=`), or every block of one lesson (`?prefix=lesson:<topic>:`, answered
 * as `{ marks: { [key]: marks } }` with only the keys she has marks on).
 */
export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const params = new URL(request.url).searchParams;
  const prefix = params.get("prefix");
  if (prefix != null) {
    if (!MARKS_PREFIX.test(prefix)) return NextResponse.json({ error: "Unknown lesson" }, { status: 400 });
    const rows = db
      .prepare("SELECT key, json FROM question_marks WHERE user_id = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?")
      .all(user.id, prefix.length, prefix, MAX_PREFIX_ROWS) as { key: string; json: string }[];
    const marks: Record<string, ReturnType<typeof parsed>> = {};
    for (const r of rows) if (MARKS_KEY.test(r.key)) marks[r.key] = parsed(r.json);
    return NextResponse.json({ marks });
  }
  const key = params.get("key");
  if (!allowed(user.id, key)) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  const row = db.prepare("SELECT json, updated_at FROM question_marks WHERE user_id = ? AND key = ?").get(user.id, key) as
    | { json: string; updated_at: string }
    | undefined;
  return NextResponse.json({ marks: row ? parsed(row.json) : null, updated_at: row?.updated_at ?? null });
}

/** Save them (empty marks delete the row). */
export async function PUT(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const body = await readJson(request);
  const key = body.key;
  if (!allowed(user.id, key)) return NextResponse.json({ error: "Unknown question" }, { status: 400 });
  const marks = cleanMarks(body.marks);
  if (!marks) return NextResponse.json({ error: "Bad marks" }, { status: 400 });
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
