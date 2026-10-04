// Restore the site from the backup bucket into DATA_DIR (an empty volume).
//   npx tsx scripts/restore-backup.mts [YYYY-MM-DD] [--force]
// Needs BACKUP_S3_* variables (on Railway: run inside the service, e.g. `railway ssh`).
// Steps: download the database snapshot (latest, or the given day) → download lecture PDFs → re-render slide images.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import Database from "better-sqlite3";
import { downloadObject, listObjects } from "../src/lib/s3";
import { openPdf, renderPage } from "../src/lib/pdf";

const args = process.argv.slice(2);
const force = args.includes("--force");
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const filesDir = path.join(dataDir, "files");
const dbFile = path.join(dataDir, "study.db");

async function main() {
  if (fs.existsSync(dbFile) && !force) throw new Error(`${dbFile} already exists. Pass --force to overwrite it.`);
  const snapshots = (await listObjects("db/")).sort();
  const key = day ? `db/study-${day}.db.gz` : snapshots.at(-1);
  if (!key || !snapshots.includes(key)) throw new Error(`No snapshot found${day ? ` for ${day}` : ""}. Available: ${snapshots.join(", ")}`);
  console.log(`Restoring ${key}…`);
  fs.mkdirSync(filesDir, { recursive: true });
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(dbFile, zlib.gunzipSync(await downloadObject(key)));

  const db = new Database(dbFile);
  const docs = db.prepare("SELECT id FROM documents").all() as { id: number }[];
  const pages = db.prepare("SELECT page_number, image_path FROM pages WHERE document_id = ? ORDER BY page_number");
  for (const { id } of docs) {
    const dir = path.join(filesDir, `doc-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    let bytes: Buffer;
    try {
      bytes = await downloadObject(`pdfs/doc-${id}.pdf`);
    } catch {
      console.warn(`  doc ${id}: PDF not in backup (uploaded after the last backup); its slides won't have images`);
      continue;
    }
    fs.writeFileSync(path.join(dir, "original.pdf"), bytes);
    const pdf = openPdf(bytes);
    for (const p of pages.all(id) as { page_number: number; image_path: string }[]) {
      fs.writeFileSync(path.join(filesDir, p.image_path), renderPage(pdf, p.page_number - 1).jpeg);
    }
    console.log(`  doc ${id}: restored`);
  }
  db.close();
  console.log("Done. Restart the app.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
