// Journey 5: "Quiz me on this" on the lesson, a report with its "Are you sure?", Escape closing only the top dialog,
// and resuming the quiz after closing the panel.
import { test, expect, expectNoOverflow, pickOption } from "./support/fixtures";
import { seedExam } from "./support/seed";

test("quiz me on selected lesson text: answer, report, Escape, resume, finish", async ({ page, signIn, apiLog }) => {
  const w = seedExam({ name: "Endodontics block (quiz me)" });
  await signIn(w.userId);
  await page.goto(`/exams/${w.examId}/study`);
  const intro = page.getByText(/^A made-up lesson \(fake AI\) about /);
  await expect(intro).toBeVisible({ timeout: 30_000 });

  // Select the lesson's opening sentence: the pill comes up under it.
  await intro.selectText();
  const pill = page.getByRole("button", { name: "Quiz me on this" });
  await expect(pill).toBeVisible();
  await expectNoOverflow(page, "the lesson with the quiz pill");
  await pill.click();

  const panel = page.getByRole("dialog", { name: "Quiz me on this" });
  await expect(panel.getByText(/^“A made-up lesson \(fake AI\) about /)).toBeVisible();
  const sizes = panel.getByRole("group", { name: "How many questions?" });
  await sizes.getByRole("button", { name: "3", exact: true }).click();
  await expect(sizes.getByRole("button", { name: "3", exact: true })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("dialog").getByText("Writing 3 questions about this… about a minute.")).toBeVisible();
  await expectNoOverflow(page, "the quiz panel while writing");

  const quiz = page.getByRole("dialog", { name: "Quiz on what you selected" });
  await expect(quiz.getByText("Question 1 of 3")).toBeVisible({ timeout: 30_000 });
  expect(apiLog.filter((l) => l === "POST /api/quizme"), "quizzes asked for").toHaveLength(1);

  // Answer the first (right).
  await pickOption(quiz, true);
  await quiz.getByRole("button", { name: "Check answer" }).click();
  await expect(quiz.getByText("✓ Correct").first()).toBeVisible();
  await quiz.getByRole("button", { name: "Next →" }).click();
  await expect(quiz.getByText("Question 2 of 3")).toBeVisible();
  await expectNoOverflow(page, "a quiz-me question");

  // Report the second: the "Are you sure?" opens over the panel; Escape closes only it.
  await quiz.getByRole("button", { name: "Report this question" }).click();
  const report = page.getByRole("alertdialog", { name: "Report this question?" });
  await expect(report.getByText("It will be removed from this quiz and your score.", { exact: false })).toBeVisible();
  await expectNoOverflow(page, "the report dialog");
  await page.keyboard.press("Escape");
  await expect(report).toBeHidden();
  await expect(quiz).toBeVisible();
  await expect(quiz.getByText("Question 2 of 3")).toBeVisible();

  // Report it for real: it leaves the quiz (two questions now).
  await quiz.getByRole("button", { name: "Report this question" }).click();
  await report.getByRole("textbox").fill("e2e: checking the report flow");
  await report.getByRole("button", { name: "Yes, report it" }).click();
  await expect(report).toBeHidden();
  await expect(page.getByText("Reported. It's out of this quiz and your score.")).toBeVisible();
  await expect(quiz.getByText("Question 2 of 2")).toBeVisible();

  // Close the panel: "Resume your quiz" offers the one left.
  await quiz.getByRole("button", { name: "Close" }).click();
  await expect(quiz).toBeHidden();
  const resume = page.getByRole("button", { name: "Resume your quiz (1 of 2 left)" });
  await expect(resume).toBeVisible();
  await expectNoOverflow(page, "the lesson with Resume your quiz");

  // Resume and finish (wrong this time): one of two right.
  await resume.click();
  await expect(quiz.getByText("Question 2 of 2")).toBeVisible();
  await pickOption(quiz, false);
  await quiz.getByRole("button", { name: "Check answer" }).click();
  await expect(quiz.getByText(/^✗ Why [A-D]\b/).first()).toBeVisible();
  await quiz.getByRole("button", { name: "See my score" }).click();
  await expect(quiz.getByText("50% · 1/2 right.")).toBeVisible();
  await quiz.getByRole("button", { name: "Done" }).click();
  await expect(quiz).toBeHidden();
  await expect(page.getByRole("button", { name: /^Resume your quiz/ })).toBeHidden();
});
