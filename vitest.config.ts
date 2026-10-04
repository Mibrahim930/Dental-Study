import { defineConfig } from "vitest/config";
import path from "path";
import os from "os";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    // Each test file gets a throwaway database.
    env: { DATA_DIR: path.join(os.tmpdir(), `dental-study-test-${process.pid}`), SECRET_KEY: "test-secret", APP_PASSCODE: "test" },
    pool: "forks",
    fileParallelism: false,
  },
});
