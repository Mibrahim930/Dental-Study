// Browser tests (e2e/): the student journeys that matter, on a phone-sized screen, against a real `next dev` server
// with the fake AI (AI_FAKE=1: no network, no cost) and a throwaway data folder made fresh for every run. Never port
// 3000, never ./data. Run with `npm run e2e`.
import fs from "fs";
import os from "os";
import path from "path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3210;
const CI = !!process.env.CI;

// One data folder per run, made by the main process; the test workers inherit these variables (the config is loaded
// again in each worker, and must not make a second folder there). The seeding in e2e/support/seed.ts reads them.
if (!process.env.E2E_DATA_DIR) process.env.E2E_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dental-study-e2e-"));
const DATA_DIR = process.env.E2E_DATA_DIR;
const server = {
  DATA_DIR,
  SECRET_KEY: "e2e-secret",
  APP_PASSCODE: "e2e",
  AI_FAKE: "1",
  // Every fake answer waits this long, so "writing…" screens are on screen long enough to be seen.
  AI_FAKE_DELAY_MS: "1500",
  NEXT_TELEMETRY_DISABLED: "1",
};
// The tests sign cookies and write rows with the same settings the server runs with.
Object.assign(process.env, { DATA_DIR, SECRET_KEY: server.SECRET_KEY, APP_PASSCODE: server.APP_PASSCODE, E2E_PORT: String(PORT) });

// A Chromium already on this machine (set PW_CHROMIUM to its path) instead of the one `playwright install` puts in place.
const executablePath = process.env.PW_CHROMIUM || undefined;

export default defineConfig({
  testDir: "e2e",
  // Not *.spec.ts / *.test.ts: Vitest would pick those up as unit tests.
  testMatch: "**/*.e2e.ts",
  outputDir: "e2e/.results",
  globalSetup: "./e2e/support/warmup.ts",
  globalTeardown: "./e2e/support/teardown.ts",
  timeout: 90_000,
  // CI machines are slower, and `next dev` compiles on first use.
  expect: { timeout: CI ? 30_000 : 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]] : [["list"]],
  use: {
    ...devices["iPhone 13"],
    // Chromium with a phone's screen, touch and user agent (devices["iPhone 13"] would ask for WebKit).
    browserName: "chromium",
    viewport: { width: 375, height: 812 },
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: { executablePath },
  },
  webServer: {
    // The database is created before the server starts, so the two never race to build it.
    command: `npx tsx e2e/support/prepare.ts && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    env: server,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
