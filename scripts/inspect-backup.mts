// Prints a summary of the latest backed-up database (no PDFs downloaded). For checking production health.
//   railway run npx tsx scripts/inspect-backup.mts
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import Database from "better-sqlite3";
import { downloadObject, listObjects } from "../src/lib/s3";

const key = (await listObjects("db/")).sort().at(-1)!;
const file = path.join(os.tmpdir(), `inspect-${Date.now()}.db`);
fs.writeFileSync(file, zlib.gunzipSync(await downloadObject(key)));
const db = new Database(file, { readonly: true });
console.log(`Snapshot: ${key}`);
console.log("Users:", db.prepare("SELECT id, is_admin, provider IS NOT NULL AS has_key FROM users").all());
console.log(
  "Exams:",
  db
    .prepare(
      `SELECT e.id, e.user_id, e.name, e.exam_date, e.topic_status,
        (SELECT COUNT(*) FROM topics t WHERE t.exam_id = e.id) topics,
        (SELECT COUNT(*) FROM documents d WHERE d.exam_id = e.id) docs FROM exams e`,
    )
    .all(),
);
console.log(
  "Lectures:",
  db
    .prepare(
      `SELECT d.id, d.exam_id, substr(d.filename, 1, 40) file, d.status, d.page_count, d.batch_id IS NOT NULL AS in_batch,
        (SELECT COUNT(*) FROM pages p WHERE p.document_id = d.id AND p.status = 'done') read, substr(d.error, 1, 80) error FROM documents d`,
    )
    .all(),
);
db.close();
fs.rmSync(file);
