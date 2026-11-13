import { defineConfig } from "vitest/config";
import path from "path";
import os from "os";

const base = path.join(os.tmpdir(), `dental-study-test-${process.pid}`);

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    // Each run gets a throwaway folder and each test file its own database inside it; tests/global-setup.ts deletes it when the run ends.
    // TEST_DATA_BASE is the run's folder; tests/setup-file.ts points DATA_DIR at a fresh subfolder for every test file.
    env: { TEST_DATA_BASE: base, DATA_DIR: base, SECRET_KEY: "test-secret", APP_PASSCODE: "test" },
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-file.ts"],
    pool: "forks",
    fileParallelism: false,
  },
});
