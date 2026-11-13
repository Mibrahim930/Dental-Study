// Runs (with tsx) just before the test server starts, in the run's throwaway DATA_DIR: creates the database with its
// whole schema, so the server and the tests never race to create it. Refuses any folder outside the temp dir.
import fs from "fs";
import os from "os";
import path from "path";

const dir = process.env.DATA_DIR;
if (!dir || path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("dental-study-e2e-")) {
  console.error(`e2e prepare: refusing DATA_DIR ${dir ?? "(unset)"}: it must be a dental-study-e2e-* folder in ${os.tmpdir()}`);
  process.exit(1);
}
fs.mkdirSync(path.join(dir, "files"), { recursive: true });
const { db } = await import("@/lib/db");
const tables = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
console.log(`e2e prepare: database ready in ${dir} (${tables} tables)`);
