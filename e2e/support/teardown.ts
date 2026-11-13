// Removes the run's throwaway data folder once the browser tests are done (only ever a dental-study-e2e-* folder in the
// temp dir that playwright.config.ts made, never a real data folder).
import fs from "fs";
import os from "os";
import path from "path";

export default function teardown() {
  const dir = process.env.E2E_DATA_DIR;
  if (dir && path.dirname(path.resolve(dir)) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("dental-study-e2e-")) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
