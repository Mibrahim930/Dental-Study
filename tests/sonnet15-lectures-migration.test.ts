// Sonnet QA 15 — a database written by the code before Job A (schema of 8939987) opens in place with the new code.
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { content: string }) => {
    const ids = [...opts.content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
    return { topics: [{ title: "Sec", summary: "s", page_ids: ids, emphasized: false, concepts: ["Pulp"] }] };
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

const OLD_SCHEMA = (() => {
  const src = execSync("git show 8939987:src/lib/db.ts", { encoding: "utf8", cwd: path.resolve(import.meta.dirname, "..") });
  return src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
})();

describe("upgrade from the schema before topics.document_id", () => {
  it("adds the column in place, keeps every row, is harmless on a second open, and the startup upgrade then maps the old exam by lecture", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig15-"));
    const old = new Database(path.join(dir, "study.db"));
    old.pragma("foreign_keys = ON");
    old.exec(OLD_SCHEMA);
    expect((old.prepare("PRAGMA table_info(topics)").all() as { name: string }[]).map((c) => c.name)).not.toContain("document_id");
    const notes = JSON.stringify({ title: "t", summary: "s", image_description: null, key_facts: ["f"], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: ["c"], is_filler: false });
    old.exec(`INSERT INTO users (email, password_hash) VALUES ('a@x.dev', 'x');
      INSERT INTO exams (user_id, name, topic_status) VALUES (1, 'Old exam', 'ready');
      INSERT INTO documents (exam_id, filename, status, page_count) VALUES (1, 'L1.pdf', 'done', 2), (1, 'L2.pdf', 'done', 2);`);
    const ins = old.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, 'x.jpg', 'done', ?)");
    for (const [d, n] of [[1, 1], [1, 2], [2, 1], [2, 2]]) ins.run(d, n, notes);
    old.exec(`INSERT INTO topics (exam_id, position, title, summary, page_ids, lesson_json, checks_json, checks_version) VALUES
        (1, 0, 'Mixed A', 's', '[1,2,3]', 'LESSON', '[1]', 2), (1, 1, 'Mixed B', 's', '[4]', NULL, NULL, NULL);
      INSERT INTO topic_study (user_id, topic_id) VALUES (1, 1);`);
    old.close();

    vi.resetModules();
    process.env.DATA_DIR = dir;
    delete (globalThis as { __db?: unknown }).__db;
    const { db, getMeta } = await import("@/lib/db");
    const cols = (db.prepare("PRAGMA table_info(topics)").all() as { name: string; notnull: number; dflt_value: string | null }[]).find((c) => c.name === "document_id");
    expect(cols).toBeTruthy();
    expect(cols!.notnull).toBe(0);
    const rows = db.prepare("SELECT id, title, lesson_json, checks_version, document_id FROM topics ORDER BY position").all();
    expect(rows).toEqual([
      { id: 1, title: "Mixed A", lesson_json: "LESSON", checks_version: 2, document_id: null },
      { id: 2, title: "Mixed B", lesson_json: null, checks_version: null, document_id: null },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM topic_study").get()).toEqual({ n: 1 });

    // The cascade works on the new column.
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id) VALUES (1, 9, 'tmp', 's', '[]', 2)").run();
    db.prepare("DELETE FROM topics WHERE title = 'tmp'").run();

    // The startup upgrade, on the migrated file.
    const { rebuildLectureMaps, lectureMapsKey } = await import("@/lib/topics");
    expect(await rebuildLectureMaps()).toBe(1);
    expect(getMeta(lectureMapsKey(1))).toBe("done");
    const now = db.prepare("SELECT id, title, document_id, lesson_json FROM topics ORDER BY position").all() as { id: number; title: string; document_id: number; lesson_json: string | null }[];
    expect(now.map((x) => x.document_id)).toEqual([1, 2]);
    expect(db.prepare("SELECT topic_status FROM exams WHERE id = 1").get()).toEqual({ topic_status: "ready" });

    // Second open of the same file: nothing is added twice, nothing changes.
    db.close();
    delete (globalThis as { __db?: unknown }).__db;
    vi.resetModules();
    const again = (await import("@/lib/db")).db;
    expect((again.prepare("PRAGMA table_info(topics)").all() as { name: string }[]).filter((c) => c.name === "document_id")).toHaveLength(1);
    expect(again.prepare("SELECT COUNT(*) n FROM topics").get()).toEqual({ n: 2 });
    const mod = await import("@/lib/topics");
    expect(await mod.rebuildLectureMaps()).toBe(0);
    again.close();
    delete (globalThis as { __db?: unknown }).__db;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
