import { defineConfig } from "vitest/config";
import path from "path";
import os from "os";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    // Each run gets a throwaway database folder; tests/global-setup.ts deletes it when the run ends.
    env: { DATA_DIR: path.join(os.tmpdir(), `dental-study-test-${process.pid}`), SECRET_KEY: "test-secret", APP_PASSCODE: "test" },
    globalSetup: ["tests/global-setup.ts"],
    pool: "forks",
    fileParallelism: false,
  },
});
