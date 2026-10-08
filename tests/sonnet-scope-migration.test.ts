import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

const OLD_SCHEMA = (() => {
  const src = execSync("git show b60ebd7:src/lib/db.ts", { encoding: "utf8" });
  return src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
})();

describe("migration of an old database with finished attempts", () => {
  it("adds the new columns with safe defaults, and old attempts still render and count as answered", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonnet-mig-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(OLD_SCHEMA);
    old.exec(`INSERT INTO exams (name) VALUES ('Old exam');
      INSERT INTO topics (exam_id, position, title, summary) VALUES (1, 0, 'T', 'S');
      INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (1, 1, 'recall', 's', '["a","b","c"]', 0, 'e');
      INSERT INTO attempts (exam_id, mode, status) VALUES (1, 'tutor', 'finished');
      INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (1, 1, 0, 1, 0);`);
    old.close();

    vi.resetModules();
    process.env.DATA_DIR = dir;
    delete (globalThis as { __db?: unknown }).__db;
    const { db } = await import("@/lib/db");
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("users")).toContain("focus_weak");
    expect(cols("attempts")).toContain("adaptive");
    expect(cols("attempt_questions")).toEqual(expect.arrayContaining(["confidence", "option_order"]));
    expect(db.prepare("SELECT adaptive FROM attempts").get()).toEqual({ adaptive: 1 });
    expect(db.prepare("SELECT confidence, option_order FROM attempt_questions").get()).toEqual({ confidence: null, option_order: null });

    // Opening the database a second time (a restart) must not fail on the already-added columns.
    vi.resetModules();
    delete (globalThis as { __db?: unknown }).__db;
    const again = await import("@/lib/db");
    const { attemptView } = await import("@/lib/attemptView");
    const { retryQuestions } = await import("@/lib/practicePlan");
    const v = attemptView(1)!.questions[0];
    expect([v.chosen_index, v.retry, v.confidence]).toEqual([1, false, null]);
    // The old wrong answer is eligible to come back (exam 1, topic 1).
    expect(retryQuestions(1, [1], 5)).toEqual([1]);
    again.db.close();
    delete (globalThis as { __db?: unknown }).__db;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may keep the file locked briefly; the OS temp folder is cleaned later */
    }
  });
});
