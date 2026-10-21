// The calendar release adds columns/tables; a live database from before it (schema at 840b758) must upgrade in place.
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

const BEFORE = (() => {
  const src = execSync("git show 840b758:src/lib/db.ts", { encoding: "utf8" });
  return src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
})();

describe("calendar release database upgrade", () => {
  it("keeps existing busy days (as one-off ranges) and adds the new tables", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calmig-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(BEFORE);
    old.exec(`INSERT INTO users (email, password_hash) VALUES ('a@x.dev', 'x');
      INSERT INTO busy_days (user_id, start_date, end_date, label) VALUES (1, '2026-11-01', '2026-11-03', 'Trip');`);
    old.close();

    vi.resetModules();
    process.env.DATA_DIR = dir;
    delete (globalThis as { __db?: unknown }).__db;
    const { db } = await import("@/lib/db");
    expect(db.prepare("SELECT start_date, end_date, label, weekdays FROM busy_days").get()).toEqual({
      start_date: "2026-11-01",
      end_date: "2026-11-03",
      label: "Trip",
      weekdays: null,
    });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("busy_skips");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
