// Perf batch 2: (1) a live database from before `users.session_epoch` upgrades in place and nobody is signed out;
// (2) the practice-exam view carries each source slide's aspect so the picture's space is reserved before it loads.
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

const BEFORE = (() => {
  const src = execSync("git show 742cc18:src/lib/db.ts", { encoding: "utf8" });
  return src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
})();

describe("database upgrade: users.session_epoch", () => {
  it("adds the column with 0 for existing users, so their current cookies keep working", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epochmig-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(BEFORE);
    old.exec("INSERT INTO users (email, password_hash) VALUES ('a@x.dev', 'x'), ('b@x.dev', 'x');");
    old.close();

    vi.resetModules();
    process.env.DATA_DIR = dir;
    delete (globalThis as { __db?: unknown }).__db;
    const { db } = await import("@/lib/db");
    const { sessionToken } = await import("@/lib/auth");
    const { userForSession, revokeSessions } = await import("@/lib/user");

    const cols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("session_epoch");
    expect(db.prepare("SELECT id, session_epoch FROM users ORDER BY id").all()).toEqual([
      { id: 1, session_epoch: 0 },
      { id: 2, session_epoch: 0 },
    ]);
    // An epoch-0 cookie (what older cookies count as) still signs in until that user changes their password.
    expect(userForSession(sessionToken(1, 0))?.email).toBe("a@x.dev");
    expect(revokeSessions(1)).toBe(1);
    expect(userForSession(sessionToken(1, 0))).toBeNull();
    expect(userForSession(sessionToken(2, 0))?.email).toBe("b@x.dev");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("attemptView: source slide aspect", () => {
  it("includes the source page's width/height ratio once the answer is revealed", async () => {
    const { db } = await import("@/lib/db");
    const { attemptView } = await import("@/lib/attemptView");
    const userId = Number(db.prepare("INSERT INTO users (email, password_hash) VALUES (?, 'x')").run(`asp-${Date.now()}@test.dev`).lastInsertRowid);
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Endo')").run(userId).lastInsertRowid);
    const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, 'Lect 1.pdf', 1, 'done')").run(examId).lastInsertRowid);
    const pageId = Number(
      db.prepare("INSERT INTO pages (document_id, page_number, image_path, aspect, status) VALUES (?, 7, 'p7.jpg', 1.777, 'done')").run(docId).lastInsertRowid,
    );
    const withSource = Number(
      db
        .prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, 'recall', 'Q1', '[\"a\",\"b\"]', 0, 'because', ?)")
        .run(examId, pageId).lastInsertRowid,
    );
    const withoutSource = Number(
      db.prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (?, 'recall', 'Q2', '[\"a\",\"b\"]', 1, 'because')").run(examId)
        .lastInsertRowid,
    );
    const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, score) VALUES (?, 'tutor', 'finished', 0.5)").run(examId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, 0, 0, 1), (?, ?, 1, 0, 0)").run(
      attemptId,
      withSource,
      attemptId,
      withoutSource,
    );

    const view = attemptView(attemptId)!;
    expect(view.questions[0].source).toEqual({ page_id: pageId, filename: "Lect 1.pdf", page_number: 7, aspect: 1.777 });
    expect(view.questions[1].source).toBeNull();
  });

  it("hides the source (and its aspect) while a timed exam is still running", async () => {
    const { db } = await import("@/lib/db");
    const { attemptView } = await import("@/lib/attemptView");
    const userId = Number(db.prepare("INSERT INTO users (email, password_hash) VALUES (?, 'x')").run(`asp2-${Date.now()}@test.dev`).lastInsertRowid);
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Perio')").run(userId).lastInsertRowid);
    const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, 'L.pdf', 1, 'done')").run(examId).lastInsertRowid);
    const pageId = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, aspect, status) VALUES (?, 1, 'p1.jpg', 1.5, 'done')").run(docId).lastInsertRowid);
    const qId = Number(
      db
        .prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, 'recall', 'Q', '[\"a\",\"b\"]', 0, 'e', ?)")
        .run(examId, pageId).lastInsertRowid,
    );
    const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, time_limit_sec) VALUES (?, 'timed', 'ready', 600)").run(examId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, 0, 0, 1)").run(attemptId, qId);
    const q = attemptView(attemptId)!.questions[0] as { source?: unknown; correct_index?: number };
    expect(q.source).toBeUndefined();
    expect(q.correct_index).toBeUndefined();
  });
});
