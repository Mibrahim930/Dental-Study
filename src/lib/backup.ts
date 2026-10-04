// Daily off-disk backups to the Railway bucket (S3-compatible):
//   db/study-YYYY-MM-DD.db.gz   — a consistent snapshot of the database (last 14 kept)
//   pdfs/doc-<id>.pdf           — every uploaded lecture, copied once
// Slide images aren't backed up; scripts/restore-backup.mts re-renders them from the PDFs.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { DATA_DIR, db, FILES_DIR, getMeta, setMeta } from "./db";
import { backupConfigured, s3 } from "./s3";

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
  try {
    const { client, bucket } = s3();

    // 1. Database snapshot (better-sqlite3's online backup is safe while the app is running).
    const snapshot = path.join(DATA_DIR, "backup-snapshot.db");
    await db.backup(snapshot);
    const day = status.at.slice(0, 10);
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: `db/study-${day}.db.gz`, Body: zlib.gzipSync(fs.readFileSync(snapshot)) }),
    );
    fs.rmSync(snapshot, { force: true });

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

    // 3. Keep only the newest database snapshots.
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "db/" }));
    const old = (listed.Contents ?? [])
      .map((o) => o.Key!)
      .sort()
      .reverse()
      .slice(KEEP_DAYS);
    if (old.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: old.map((Key) => ({ Key })) } }));

    status.message = `Database saved${pdfs ? `, ${pdfs} new lecture PDF${pdfs === 1 ? "" : "s"} copied` : ""}.`;
  } catch (err) {
    status.ok = false;
    status.message = err instanceof Error ? err.message : String(err);
    console.error("Backup failed", err);
  } finally {
    running = false;
  }
  setMeta("last_backup", JSON.stringify(status));
  return status;
}

/** Called hourly: back up if the last successful backup is more than a day old. */
export async function backupIfDue() {
  if (!backupConfigured()) return;
  const last = lastBackup();
  const age = last ? Date.now() - new Date(last.at).getTime() : Infinity;
  if (!last || !last.ok || age > 23 * 3600 * 1000) await runBackup();
}
