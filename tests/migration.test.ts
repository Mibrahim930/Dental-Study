import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

// The schema from before user accounts existed (commit b60ebd7). Live databases were created with it.
const OLD_SCHEMA = (() => {
  const src = execSync("git show b60ebd7:src/lib/db.ts", { encoding: "utf8" });
  return src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
})();

describe("database upgrade", () => {
  it("upgrades a pre-accounts database in place, and the first account claims the old data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(OLD_SCHEMA);
    old.exec(`INSERT INTO exams (name) VALUES ('Old exam');
      INSERT INTO documents (exam_id, filename, status) VALUES (1, 'Lecture', 'done');
      INSERT INTO concepts (name, attempts, correct) VALUES ('Pulpitis', 3, 2);
      INSERT INTO topics (exam_id, position, title, summary) VALUES (1, 0, 'T', 'S');
      INSERT INTO topic_concepts VALUES (1, 1);
      INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (1, 'recall', 's', '[]', 0, 'e');
      INSERT INTO glossary VALUES ('PN', 'pulp necrosis');`);
    old.close();

    vi.resetModules();
    process.env.DATA_DIR = dir;
    delete (globalThis as { __db?: unknown }).__db;
    const { db } = await import("@/lib/db");
    const { claimLegacyData } = await import("@/lib/credentials");
    const userId = Number(db.prepare("INSERT INTO users (email, password_hash) VALUES ('first@x.dev', 'x')").run().lastInsertRowid);
    claimLegacyData(userId);

    expect(db.prepare("SELECT user_id, kind FROM exams").get()).toEqual({ user_id: userId, kind: "block" });
    expect(db.prepare("SELECT user_id, name, attempts FROM concepts").get()).toEqual({ user_id: userId, name: "Pulpitis", attempts: 3 });
    expect(db.prepare("SELECT * FROM topic_concepts").get()).toEqual({ topic_id: 1, concept_id: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT user_id FROM glossary").get()).toEqual({ user_id: userId });
    for (const [table, col] of [["documents", "batch_id"], ["documents", "backed_up"], ["questions", "case_id"], ["attempts", "task_id"], ["exams", "source_exam_id"]]) {
      expect((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)).toContain(col);
    }
    for (const t of ["users", "planner_settings", "plan_tasks", "busy_days", "classes", "cases", "ai_usage", "meta"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t)).toBeTruthy();
    }
    db.close();
    delete (globalThis as { __db?: unknown }).__db;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
