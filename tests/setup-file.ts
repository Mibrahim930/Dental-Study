// Runs before each test file: gives the file its own empty database folder inside the run's throwaway folder, so no
// test can pass or fail because of rows another file left behind. (Workers are reused between files, so the database
// connection the previous file opened is closed and forgotten first.)
import fs from "fs";
import path from "path";

const g = globalThis as { __db?: { close(): void } };
try {
  g.__db?.close();
} catch {
  // already closed
}
g.__db = undefined;
const base = process.env.TEST_DATA_BASE!;
fs.mkdirSync(base, { recursive: true });
process.env.DATA_DIR = fs.mkdtempSync(path.join(base, "file-"));
