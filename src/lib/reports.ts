// Bug reports and ideas sent from the little button on every page. Stored on the site (text + JPEG screenshots under
// FILES_DIR/reports/<id>/) and listed on the owner's Admin page; nothing is emailed.
import fs from "fs";
import path from "path";
import { db, FILES_DIR } from "./db";

export const REPORT_MAX_CHARS = 4000;
export const REPORT_MAX_IMAGES = 5;
export const REPORT_MAX_IMAGE_MB = 8;
export const REPORT_KINDS = ["problem", "idea"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

// The feature's own tables, created on first use (idempotent), so the module is self-contained.
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'problem',            -- problem | idea
  message TEXT NOT NULL,
  page TEXT,                                       -- path of the page she was on
  meta_json TEXT,                                  -- viewport, theme, user agent
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT
);
CREATE TABLE IF NOT EXISTS report_images (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,                              -- 1-based position in the report
  path TEXT NOT NULL,                              -- relative to FILES_DIR
  UNIQUE(report_id, n)
);`);

export type ReportMeta = { viewport?: string; theme?: string; userAgent?: string };

export type ReportRow = {
  id: number;
  user_id: number;
  email: string;
  kind: ReportKind;
  message: string;
  page: string | null;
  meta: ReportMeta;
  created_at: string;
  seen_at: string | null;
  images: number;
};

/** Saves a report and its (already JPEG-encoded) screenshots. Returns the report id. */
export function createReport(input: { userId: number; kind: ReportKind; message: string; page: string | null; meta: ReportMeta; images: Uint8Array[] }): number {
  return db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO reports (user_id, kind, message, page, meta_json) VALUES (?, ?, ?, ?, ?)")
        .run(input.userId, input.kind, input.message, input.page, JSON.stringify(input.meta)).lastInsertRowid,
    );
    const dir = path.join(FILES_DIR, "reports", String(id));
    if (input.images.length) fs.mkdirSync(dir, { recursive: true });
    input.images.forEach((jpeg, i) => {
      const rel = path.join("reports", String(id), `${i + 1}.jpg`);
      fs.writeFileSync(path.join(FILES_DIR, rel), jpeg);
      db.prepare("INSERT INTO report_images (report_id, n, path) VALUES (?, ?, ?)").run(id, i + 1, rel);
    });
    return id;
  })();
}

/** Newest first. */
export function listReports(limit = 100): ReportRow[] {
  const rows = db
    .prepare(
      `SELECT r.*, u.email, (SELECT COUNT(*) FROM report_images i WHERE i.report_id = r.id) images
       FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?`,
    )
    .all(limit) as (Omit<ReportRow, "meta"> & { meta_json: string | null })[];
  return rows.map((r) => {
    let meta: ReportMeta = {};
    try {
      meta = r.meta_json ? (JSON.parse(r.meta_json) as ReportMeta) : {};
    } catch {
      meta = {};
    }
    return { ...r, meta };
  });
}

export function unseenReportCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM reports WHERE seen_at IS NULL").get() as { n: number }).n;
}

/** Absolute path of a report's n-th screenshot, or null. */
export function reportImagePath(reportId: number, n: number): string | null {
  if (!Number.isInteger(reportId) || !Number.isInteger(n)) return null;
  const row = db.prepare("SELECT path FROM report_images WHERE report_id = ? AND n = ?").get(reportId, n) as { path: string } | undefined;
  if (!row) return null;
  const file = path.join(FILES_DIR, row.path);
  return fs.existsSync(file) ? file : null;
}

export function markReportSeen(reportId: number): boolean {
  return db.prepare("UPDATE reports SET seen_at = datetime('now') WHERE id = ? AND seen_at IS NULL").run(reportId).changes > 0;
}
