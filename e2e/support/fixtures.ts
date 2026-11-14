// What every browser test shares: a phone-sized page that fails the test on any uncaught page error or console error
// (each harmless one allowed by name, with why), a sign-in helper, the overflow check, and a request log.
import { test as base, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { cookiesFor } from "./seed";

/** Console errors that are not the app's fault, allowed in every test. Each entry says why it is harmless. (None so far.) */
const ALLOWED_CONSOLE: RegExp[] = [];

type Fixtures = {
  /** Console error patterns allowed in this test only (push one, with a comment saying why it is expected). */
  allowedConsole: RegExp[];
  /** Sign this browser context in as the user (null: only past the passcode gate; `gate: false`: not even that). */
  signIn: (userId: number | null, opts?: { gate?: boolean; context?: BrowserContext }) => Promise<void>;
  /** Every API request the page sends, in order, as "GET /api/…". */
  apiLog: string[];
};

// Each fixture's callback is called `provide`, not Playwright's usual `use`: the React lint rules take `use` for a hook.
export const test = base.extend<Fixtures>({
  allowedConsole: async ({}, provide) => {
    await provide([...ALLOWED_CONSOLE]);
  },
  apiLog: [
    async ({ page }, provide) => {
      const log: string[] = [];
      page.on("request", (r: Request) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith("/api/")) log.push(`${r.method()} ${u.pathname}${u.search}`);
      });
      await provide(log);
    },
    { auto: true },
  ],
  signIn: async ({ context }, provide) => {
    await provide(async (userId, opts = {}) => {
      await (opts.context ?? context).addCookies(cookiesFor(userId, { gate: opts.gate }));
    });
  },
  page: async ({ page, allowedConsole: allowed }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (allowed.some((re) => re.test(text))) return;
      errors.push(`console error: ${text.slice(0, 400)}`);
    });
    await provide(page);
    expect(errors, "uncaught page errors and console errors").toEqual([]);
  },
});

/** The page's own width fits the phone: nothing makes the whole page scroll sideways. */
export async function expectNoOverflow(page: Page, where: string) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, `horizontal overflow on ${where} (scrollWidth ${scroll} > clientWidth ${client})`).toBeLessThanOrEqual(client);
}

/** The lesson requests in the log for one section: what she opened, and what was written ahead. */
export function lessonRequests(log: string[], position: number) {
  const mine = log.filter((l) => /^GET \/api\/sessions\/\d+\/lesson\?/.test(l) && new URLSearchParams(l.split("?")[1]).get("position") === String(position));
  return { opened: mine.filter((l) => !l.includes("prefetch=1")).length, prefetched: mine.filter((l) => l.includes("prefetch=1")).length };
}

/** Pick an option in a question: the right one (the fake AI's distractors all say "fake distractor") or a wrong one. */
export async function pickOption(scope: Page | ReturnType<Page["locator"]>, right: boolean) {
  const options = scope.getByRole("radiogroup", { name: "Answer choices" }).getByRole("radio");
  const option = right ? options.filter({ hasNotText: "fake distractor" }).first() : options.filter({ hasText: "fake distractor" }).first();
  await option.click();
  await expect(option).toHaveAttribute("aria-checked", "true");
}

export { expect };
