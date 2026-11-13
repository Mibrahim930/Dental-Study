// Daily off-disk backups to the Railway bucket (S3-compatible):
//   db/study-YYYY-MM-DD.db.gz   — a consistent snapshot of the database (last 14 kept)
//   pdfs/doc-<id>.pdf           — every uploaded lecture, copied once
//   files/reports/<id>/<n>.jpg  — screenshots sent with "Report a problem", copied once
//   files/reported-questions/<id>.json — reported questions, copied once
// Slide images aren't backed up; scripts/restore-backup.mts re-renders them from the PDFs.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { DATA_DIR, db, FILES_DIR, getMeta, setMeta } from "./db";
import { backupConfigured, s3 } from "./s3";
import { reportImagesAfter } from "./reports";
import { reportedFile, reportedIdsAfter } from "./reportedQuestions";

export { backupConfigured };

const KEEP_DAYS = 14;

export type BackupStatus = { at: string; ok: boolean; message: string };

export function lastBackup(): BackupStatus | null {
  const raw = getMeta("last_backup");
  return raw ? (JSON.parse(raw) as BackupStatus) : null;
}

let running = false;

export async function runBackup(): Promise<BackupStatus> {
  if (running) return { at: new Date().toISOString(), ok: false, message: "A backup is already running." };
  running = true;
  const status: BackupStatus = { at: new Date().toISOString(), ok: true, message: "" };
  const snapshot = path.join(DATA_DIR, "backup-snapshot.db");
  try {
    const { client, bucket } = s3();

    // 1. Database snapshot (better-sqlite3's online backup is safe while the app is running).
    await db.backup(snapshot);
    const day = status.at.slice(0, 10);
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: `db/study-${day}.db.gz`, Body: zlib.gzipSync(fs.readFileSync(snapshot)) }),
    );

    // 2. Lecture PDFs not yet copied.
    const docs = db.prepare("SELECT id FROM documents WHERE backed_up = 0").all() as { id: number }[];
    let pdfs = 0;
    for (const { id } of docs) {
      const file = path.join(FILES_DIR, `doc-${id}`, "original.pdf");
      if (!fs.existsSync(file)) continue;
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: `pdfs/doc-${id}.pdf`, Body: fs.readFileSync(file) }));
      db.prepare("UPDATE documents SET backed_up = 1 WHERE id = ?").run(id);
      pdfs++;
    }

    // 3. Report screenshots and reported-question files not yet copied.
    const files = await copyReportFiles(client, bucket);

    // 4. Keep only the newest database snapshots.
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "db/" }));
    const old = (listed.Contents ?? [])
      .map((o) => o.Key!)
      .sort()
      .reverse()
      .slice(KEEP_DAYS);
    if (old.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: old.map((Key) => ({ Key })) } }));

    const copied = [pdfs ? `${pdfs} new lecture PDF${pdfs === 1 ? "" : "s"}` : "", files ? `${files} report file${files === 1 ? "" : "s"}` : ""].filter(Boolean);
    status.message = `Database saved${copied.length ? `, ${copied.join(" and ")} copied` : ""}.`;
  } catch (err) {
    status.ok = false;
    status.message = err instanceof Error ? err.message : String(err);
    console.error("Backup failed", err);
  } finally {
    // A failed run must not leave a full copy of the database lying on the volume.
    fs.rmSync(snapshot, { force: true });
    running = false;
  }
  setMeta("last_backup", JSON.stringify(status));
  return status;
}

/**
 * Copy report screenshots and reported-question files made since the last backup. Both are written once and never
 * changed, and their ids only grow, so "copied up to id N" in meta (moved on after each one, so a failed run resumes
 * where it stopped) is all the bookkeeping needed. A file that's missing (never written, or its account deleted) is
 * skipped. The key is the file's path under FILES_DIR, after "files/". Returns how many files were copied.
 */
async function copyReportFiles(client: S3Client, bucket: string): Promise<number> {
  let copied = 0;
  const put = async (rel: string) => {
    const file = path.join(FILES_DIR, rel);
    if (!fs.existsSync(file)) return;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `files/${rel.split(path.sep).join("/")}`, Body: fs.readFileSync(file) }));
    copied++;
  };

  const images = reportImagesAfter(Number(getMeta("backup_reports_upto") ?? 0));
  for (const [i, img] of images.entries()) {
    await put(img.path);
    // A report's last screenshot done: the whole report is.
    if (images[i + 1]?.reportId !== img.reportId) setMeta("backup_reports_upto", String(img.reportId));
  }
  for (const id of reportedIdsAfter(Number(getMeta("backup_reported_upto") ?? 0))) {
    await put(reportedFile(id));
    setMeta("backup_reported_upto", String(id));
  }
  return copied;
}

/** Called hourly: back up if the last successful backup is more than a day old. */
export async function backupIfDue() {
  if (!backupConfigured()) return;
  const last = lastBackup();
  const age = last ? Date.now() - new Date(last.at).getTime() : Infinity;
  if (!last || !last.ok || age > 23 * 3600 * 1000) await runBackup();
}
