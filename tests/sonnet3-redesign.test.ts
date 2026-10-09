import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { examProgress, firstName, scoreContext } from "@/lib/readiness";
import { addReviewCard, nextReviewDates } from "@/lib/practice";
import { themeOf, THEMES } from "@/lib/themes";
import { config } from "@/proxy";
import { makeExam, makeUser } from "./helpers";

describe("firstName", () => {
  it("makes a friendly first name or null", () => {
    expect(firstName("lolo.smith@x.dev")).toBe("Lolo");
    expect(firstName("MINA_I@x.dev")).toBe("Mina");
    expect(firstName("lolo123@x.dev")).toBe("Lolo");
    expect(firstName("a@x.dev")).toBeNull();
    expect(firstName("12345@x.dev")).toBeNull();
    expect(firstName("averyveryverylongname@x.dev")).toBeNull();
    expect(firstName("")).toBeNull();
  });
});

describe("themes", () => {
  it("defaults to blocks and rejects unknown values", () => {
    expect(themeOf(undefined)).toBe("blocks");
    expect(themeOf(null)).toBe("blocks");
    expect(themeOf("nope")).toBe("blocks");
    for (const t of THEMES) expect(themeOf(t.id)).toBe(t.id);
  });
  it("new users get the blocks theme from the column default", () => {
    const u = makeUser();
    expect((db.prepare("SELECT theme FROM users WHERE id = ?").get(u) as { theme: string }).theme).toBe("blocks");
  });
});

describe("examProgress", () => {
  it("handles an exam without topics", () => {
    const u = makeUser();
    const { examId } = makeExam(u, null, []);
    expect(examProgress(u, examId)).toEqual({ mastery: null, studied: 0, readiness: 0, topics: 0 });
  });
  it("counts studied-but-untested topics as half ready and uses concept mastery otherwise", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [1, 1, 1, 1]);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(u, topicIds[0]);
    // topic 1 (index 1) has a concept with 3/4 correct -> mastery 4/6
    const cid = Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, 'C', 4, 3)").run(u).lastInsertRowid);
    db.prepare("INSERT INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(topicIds[1], cid);
    const p = examProgress(u, examId);
    expect(p.topics).toBe(4);
    expect(p.studied).toBeCloseTo(0.25);
    expect(p.mastery).toBeCloseTo(4 / 6);
    expect(p.readiness).toBeCloseTo((0.5 + 4 / 6) / 4);
    expect(p.readiness).toBeGreaterThanOrEqual(0);
    expect(p.readiness).toBeLessThanOrEqual(1);
  });
});

describe("scoreContext", () => {
  it("compares with the previous finished attempt and detects a best score", () => {
    const u = makeUser();
    const { examId } = makeExam(u, null, [1]);
    const add = (score: number | null, status = "finished") =>
      Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, score) VALUES (?, 'tutor', ?, ?)").run(examId, status, score).lastInsertRowid);
    const a1 = add(0.5);
    expect(scoreContext(a1)).toEqual({ previous: null, best: false });
    const a2 = add(0.7);
    expect(scoreContext(a2)).toEqual({ previous: 0.5, best: true });
    const a3 = add(0.6);
    expect(scoreContext(a3)).toEqual({ previous: 0.7, best: false });
    const a4 = add(0.7); // tie is not "best"
    expect(scoreContext(a4).best).toBe(false);
    const unfinished = add(null, "ready");
    expect(scoreContext(unfinished)).toEqual({ previous: null, best: false });
    expect(scoreContext(99999)).toEqual({ previous: null, best: false });
  });
});

describe("nextReviewDates", () => {
  it("returns three increasing ISO dates for Hard < Good < Easy", () => {
    const u = makeUser();
    const { examId } = makeExam(u, null, [1]);
    const qid = Number(
      db.prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e')").run(examId).lastInsertRowid,
    );
    addReviewCard(qid);
    const cardId = (db.prepare("SELECT id FROM review_cards WHERE question_id = ?").get(qid) as { id: number }).id;
    const n = nextReviewDates(cardId);
    const t = (s: string) => new Date(s).getTime();
    expect(Number.isNaN(t(n.hard))).toBe(false);
    expect(t(n.hard)).toBeLessThanOrEqual(t(n.good));
    expect(t(n.good)).toBeLessThanOrEqual(t(n.easy));
  });
  it("throws for an unknown card (the route would 500)", () => {
    expect(() => nextReviewDates(987654)).toThrow();
  });
});

describe("proxy matcher", () => {
  const re = new RegExp("^" + config.matcher[0] + "$");
  it("lets icons and the manifest through but guards app pages", () => {
    for (const p of ["/icon.svg", "/apple-icon", "/manifest.webmanifest", "/favicon.ico", "/login", "/api/ics/x.ics", "/_next/static/a.js"]) {
      expect(re.test(p), p).toBe(false);
    }
    for (const p of ["/", "/exams/1", "/review", "/settings", "/api/review"]) expect(re.test(p), p).toBe(true);
  });
  it.fails("KNOWN ISSUE: look-alike paths are exempt too (prefix matching; no real route affected today)", () => {
    // Negative lookahead is prefix based: these start with an exempt name but are different routes.
    for (const p of ["/icon.svg.bak", "/apple-icon-evil", "/manifest.webmanifest/x"]) {
      expect.soft(re.test(p), p).toBe(true);
    }
  });
});

describe("theme migration", () => {
  it("moves existing users to blocks exactly once, and keeps a later choice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-mig-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'classic');
      INSERT INTO users (email, password_hash, theme) VALUES ('a@x.dev', 'x', 'classic'), ('b@x.dev', 'x', 'evergreen');`);
    old.close();
    const prevDir = process.env.DATA_DIR;
    vi.resetModules();
    process.env.DATA_DIR = dir;
    delete (globalThis as { __db?: unknown }).__db;
    try {
      const { db: d1 } = await import("@/lib/db");
      expect((d1.prepare("SELECT theme FROM users ORDER BY id").all() as { theme: string }[]).map((r) => r.theme)).toEqual(["blocks", "blocks"]);
      d1.prepare("UPDATE users SET theme = 'slate' WHERE email = 'a@x.dev'").run();
      d1.close();
      vi.resetModules();
      delete (globalThis as { __db?: unknown }).__db;
      const { db: d2 } = await import("@/lib/db");
      expect((d2.prepare("SELECT theme FROM users WHERE email = 'a@x.dev'").get() as { theme: string }).theme).toBe("slate");
      d2.close();
    } finally {
      process.env.DATA_DIR = prevDir;
      delete (globalThis as { __db?: unknown }).__db;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
