// Journey 3: a 10-question practice exam. The writing screen shows the plan, the exam has 10 questions, Finish asks
// first ("Keep going" keeps her there), the results show the score and what the exam covered, and a second exam does
// not repeat the questions she got right in the first.
import type { Page } from "@playwright/test";
import { test, expect, expectNoOverflow, pickOption } from "./support/fixtures";
import { db, seedExam } from "./support/seed";

/** The stem of the question on screen (the fake AI's stems start "Fake question" or "Fake case"). */
const stemOf = (page: Page) =>
  page
    .locator("main p")
    .filter({ hasText: /^Fake (question|case) [0-9a-f]{6}-\d+/ })
    .first()
    .innerText();

async function startExam(page: Page, examId: number): Promise<number> {
  await page.goto(`/exams/${examId}`);
  const form = page.locator("section").filter({ has: page.getByRole("heading", { name: "Practice exam" }) });
  await form.getByRole("group", { name: "Length" }).getByRole("button", { name: "10", exact: true }).click();
  await expect(form.getByRole("group", { name: "Length" }).getByRole("button", { name: "10", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectNoOverflow(page, "the exam page with the practice form");
  await form.getByRole("button", { name: "Write my practice exam" }).click();
  await page.waitForURL(/\/attempts\/\d+$/);
  return Number(page.url().match(/\/attempts\/(\d+)$/)![1]);
}

/** Wait for the exam to open; when writing failed, fail with the reason the server stored (it is not shown in full). */
async function examOpens(page: Page, attemptId: number) {
  const opened = page.getByRole("heading", { name: "Practice exam · Learn" });
  const failed = page.getByText("Couldn't write this exam.");
  await expect(opened.or(failed)).toBeVisible({ timeout: 45_000 });
  if (await failed.isVisible()) {
    const row = db.prepare("SELECT error FROM attempts WHERE id = ?").get(attemptId) as { error: string | null };
    throw new Error(`Practice exam ${attemptId} failed to write: ${row.error}`);
  }
}

test("practice exam: plan, answer some, finish, results, a second exam without the first one's right answers", async ({ page, signIn }) => {
  const w = seedExam({ name: "Endodontics block (practice)" });
  await signIn(w.userId);

  const firstId = await startExam(page, w.examId);
  // The writing screen, with the plan: 10 questions over the 4 sections.
  await expect(page.getByRole("heading", { name: "Writing your practice exam…" })).toBeVisible();
  await expect(page.getByText("Planned 10 questions across 4 sections")).toBeVisible();
  await expectNoOverflow(page, "the writing screen");

  // The exam opens with 10 questions.
  await examOpens(page, firstId);
  await expect(page.getByRole("list", { name: "Questions" }).getByRole("listitem")).toHaveCount(10);
  await expect(page.getByText("Question 1 of 10")).toBeVisible();
  await expectNoOverflow(page, "a practice question");

  // Answer six (two wrong) with a confidence each, leave four.
  const plan: ("right" | "wrong" | "skip")[] = ["right", "wrong", "skip", "right", "right", "skip", "wrong", "right", "skip", "skip"];
  const confidence = ["Confident", "Unsure", "Guessed"];
  const first: { stem: string; how: (typeof plan)[number] }[] = [];
  for (let i = 0; i < plan.length; i++) {
    await expect(page.getByText(`Question ${i + 1} of 10`)).toBeVisible();
    first.push({ stem: await stemOf(page), how: plan[i] });
    if (plan[i] !== "skip") {
      await pickOption(page, plan[i] === "right");
      await expect(page.getByText("How sure are you? This locks in your answer.")).toBeVisible();
      await page.getByRole("button", { name: confidence[i % 3], exact: true }).click();
      await expect(page.getByText(plan[i] === "right" ? "✓ Correct" : /^✗ Why [A-E]\b/).first()).toBeVisible();
      await expect(page.getByText("You said you were")).toBeVisible();
    }
    if (i + 1 < plan.length) await page.getByRole("button", { name: "Next question →" }).click();
  }
  expect(new Set(first.map((q) => q.stem)).size, "the first exam repeats a question").toBe(10);

  // Finish asks first; "Keep going" keeps her in the exam.
  await page.getByRole("button", { name: "Finish · 6/10" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Finish the exam?" });
  await expect(confirm.getByText("4 questions still unanswered. Finish anyway?")).toBeVisible();
  await expectNoOverflow(page, "the finish dialog");
  await confirm.getByRole("button", { name: "Keep going" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText("Question 10 of 10")).toBeVisible();
  await page.getByRole("button", { name: "Finish exam" }).click();
  await confirm.getByRole("button", { name: "Yes, finish" }).click();

  // Results: 4 right of 10 (skipped count against), and what the exam covered.
  await expect(page.getByRole("img", { name: /^Score 40 percent, 4 of 10 right/ })).toBeVisible();
  await expect(page.getByText("40% · 4/10", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/This exam covers \d+ of the \d+ facts in these lectures\. You have been tested on \d+ so far\./)).toBeVisible();
  await expectNoOverflow(page, "the results");

  // A second exam: nothing she got right comes back, and no question appears twice in it.
  const secondId = await startExam(page, w.examId);
  await examOpens(page, secondId);
  const count = await page.getByRole("list", { name: "Questions" }).getByRole("listitem").count();
  expect(count).toBe(10);
  const second: { stem: string; tagged: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    await expect(page.getByText(`Question ${i + 1} of ${count}`)).toBeVisible();
    second.push({ stem: await stemOf(page), tagged: await page.getByText("↺ Missed last time").isVisible() });
    if (i + 1 < count) await page.getByRole("button", { name: "Next question →" }).click();
  }
  expect(new Set(second.map((q) => q.stem)).size, "the second exam repeats a question").toBe(count);
  // By design a question she missed or skipped comes back in the next exam ("Unanswered questions count as skipped and
  // come back in a later exam"; a miss "comes back in your next practice exam with the choices shuffled"). Nothing she
  // got right may come back, and every other question must be new.
  const repeated = first.filter((q) => second.some((s) => s.stem === q.stem));
  test.info().annotations.push({ type: "came back", description: JSON.stringify(repeated.map((q) => q.how)) });
  expect(repeated.filter((q) => q.how === "right"), "questions she got right came back").toEqual([]);
  expect(repeated.every((q) => q.how === "wrong" || q.how === "skip")).toBe(true);
  // A missed question that comes back says so.
  for (const q of repeated.filter((r) => r.how === "wrong")) expect(second.find((s) => s.stem === q.stem)!.tagged, `"${q.stem}" not marked as missed last time`).toBe(true);
  await expectNoOverflow(page, "the second exam");
});
