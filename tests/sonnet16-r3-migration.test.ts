// Sonnet QA 16: upgrading a database created by the code before Release 3 Jobs B-E (commit e028d13~1).
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

// The schema as it was before Release 3 B-E; live databases were created with it.
const PRE_SCHEMA = (() => {
  const src = execSync("git show e028d13~1:src/lib/db.ts", { encoding: "utf8", cwd: path.join(import.meta.dirname, "..") });
  return src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
})();

describe("upgrade from the pre-Release-3-B..E database", () => {
  it("adds questions.option_notes and quiz_answers, keeps data, and the startup copy of session_checks works on it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig16-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(PRE_SCHEMA.replace(/CREATE TABLE IF NOT EXISTS quiz_answers[\s\S]*?\);\n/, ""));
    expect((old.prepare("PRAGMA table_info(questions)").all() as { name: string }[]).map((c) => c.name)).not.toContain("option_notes");
    old.exec(`
      INSERT INTO users (email, password_hash) VALUES ('a@x.dev', 'x');
      INSERT INTO exams (user_id, name) VALUES (1, 'E');
      INSERT INTO topics (exam_id, position, title, summary, page_ids, checks_json, checks_version) VALUES (1, 0, 'T', 's', '[]', '[{"question":"q","options":["a","b"],"correct_index":0}]', 2);
      INSERT INTO study_sessions (exam_id) VALUES (1);
      INSERT INTO study_sessions (exam_id) VALUES (1);
      INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen, created_at) VALUES (1, 1, 'q', 0, 0, 1, '2026-10-01 10:00:00');
      INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen, created_at) VALUES (2, 1, 'q', 1, 0, 0, '2026-10-02 10:00:00');
      INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (1, 'recall', 's', '["a","b"]', 0, 'e');`);
    old.close();

    vi.resetModules();
    process.env.DATA_DIR = dir;
    delete (globalThis as { __db?: unknown }).__db;
    const { db } = await import("@/lib/db");
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("questions")).toContain("option_notes");
    expect(cols("quiz_answers")).toEqual(expect.arrayContaining(["user_id", "topic_id", "check_index", "chosen", "correct"]));
    expect(db.prepare("SELECT option_notes FROM questions").get()).toEqual({ option_notes: null });
    const { migrateSessionChecks, quizAnswers } = await import("@/lib/quizProgress");
    expect(migrateSessionChecks()).toBe(2);
    expect(quizAnswers(1, 1)).toEqual({ 0: 0 }); // the later answer
    expect(migrateSessionChecks()).toBe(0);
    // the old (version 2) quiz is flagged for a rewrite
    const { quizIsCurrent } = await import("@/lib/study");
    expect(quizIsCurrent(db.prepare("SELECT * FROM topics").get() as never)).toBe(false);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    delete (globalThis as { __db?: unknown }).__db;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
