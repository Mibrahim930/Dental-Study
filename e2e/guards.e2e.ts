// Journey 7: guard rails. Signed out, pages send her to sign in; a stranger gets the not-found page for someone else's
// exam; /admin is not found for a student and shows the AI activity card to the owner.
import { test, expect, expectNoOverflow } from "./support/fixtures";
import { db, seedExam, seedUser } from "./support/seed";

test("signed out: /exams goes to sign-in (account page past the passcode, passcode page before it)", async ({ page, signIn, context }) => {
  // Past the passcode gate but not signed in: the account sign-in form.
  await signIn(null);
  await page.goto("/exams");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" }).last()).toBeVisible();
  await expectNoOverflow(page, "the account sign-in page");

  // Not even past the passcode: the passcode page.
  await context.clearCookies();
  await page.goto("/exams/1");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Passcode")).toBeVisible();
  await expectNoOverflow(page, "the passcode page");
});

test("a stranger opening another student's exam gets the not-found page", async ({ page, signIn }) => {
  const owner = seedExam({ name: "Someone else's exam" });
  const stranger = seedUser({ label: "stranger" });
  await signIn(stranger);
  for (const path of [`/exams/${owner.examId}`, `/exams/${owner.examId}/study`]) {
    // (The status is 200: the page streams its loading screen before it knows, so only the content can say "not found".)
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "We couldn't find that page." })).toBeVisible();
    await expect(page.getByText("Someone else's exam")).toHaveCount(0);
    await expect(page.getByText("Pulpal diagnosis")).toHaveCount(0);
    await expectNoOverflow(page, `the not-found page (${path})`);
  }
  // Her slides' pictures are not served to him either.
  const img = await page.request.get(`/api/pages/${owner.pageIds[0][0]}/image`);
  expect(img.status()).toBe(404);
});

test("/admin: not found for a student, the AI activity card for the owner", async ({ page, signIn, context }) => {
  // A student gets the not-found page.
  const student = seedUser();
  await signIn(student);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "We couldn't find that page." })).toBeVisible();
  await expect(page.getByText(/AI activity/)).toHaveCount(0);

  // The owner, with one AI call on record (the fake AI logs every call with model "fake" at no cost).
  const owner = seedUser({ admin: true, label: "owner" });
  db.prepare("INSERT INTO ai_usage (user_id, provider, model, purpose, input_tokens, output_tokens, cost_usd, ok, ref) VALUES (?, 'openai', 'fake', 'lesson', 1200, 800, 0, 1, 'topic:1')").run(
    student,
  );
  await context.clearCookies();
  await signIn(owner);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible();
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: /^AI activity \(last \d+ days\)$/ }) });
  await expect(card).toBeVisible();
  await expect(card.getByText(/No AI calls in the last/)).toHaveCount(0);
  const rows = card.getByRole("table").getByRole("row");
  // A header row and at least one purpose.
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expectNoOverflow(page, "the admin page");
});
