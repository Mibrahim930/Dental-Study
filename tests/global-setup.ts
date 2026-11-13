// Removes the run's throwaway data folder (see `test.env.DATA_DIR` in vitest.config.ts) once every test file is done,
// so repeated runs don't pile up databases in the temp folder.
import fs from "fs";
import os from "os";
import path from "path";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject) {
  const dir = project.config.env?.TEST_DATA_BASE;
  return () => {
    // Only ever a folder this config made in the temp dir, never a real data folder.
    if (dir && path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith("dental-study-test-")) fs.rmSync(dir, { recursive: true, force: true });
  };
}
