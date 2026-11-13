// What every browser test shares: a phone-sized page that fails the test on any uncaught page error or console error
// (each harmless one allowed by name, with why), a sign-in helper, the overflow check, and a request log.
import { test as base, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { cookiesFor } from "./seed";

/** Console errors that are not the app's fault. Each entry says why it is harmless. */
const ALLOWED_CONSOLE: RegExp[] = [
  // Chrome logs every non-2xx response as a console error. Pages that are meant to answer 404 (the not-found page a
  // stranger gets) or 401 (an API call after signing out) trigger it; the tests that visit them assert the page itself.
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
];

type Fixtures = {
  /** Console error patterns allowed in this test only (push one, with a comment saying why it is expected). */
  allowedConsole: RegExp[];
  /** Sign this browser context in as the user (null: only past the passcode gate; `gate: false`: not even that). */
  signIn: (userId: number | null, opts?: { gate?: boolean; context?: BrowserContext }) => Promise<void>;
  /** Every API request the page sends, in order, as "GET /api/…". */
  apiLog: string[];
};

export const test = base.extend<Fixtures>({
  allowedConsole: async ({}, use) => {
    await use([...ALLOWED_CONSOLE]);
  },
  apiLog: [
    async ({ page }, use) => {
      const log: string[] = [];
      page.on("request", (r: Request) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith("/api/")) log.push(`${r.method()} ${u.pathname}${u.search}`);
      });
      await use(log);
    },
    { auto: true },
  ],
  signIn: async ({ context }, use) => {
    await use(async (userId, opts = {}) => {
      await (opts.context ?? context).addCookies(cookiesFor(userId, { gate: opts.gate }));
    });
  },
  page: async ({ page, allowedConsole: allowed }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (allowed.some((re) => re.test(text))) return;
      errors.push(`console error: ${text.slice(0, 400)}`);
    });
    await use(page);
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
