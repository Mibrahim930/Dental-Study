// Journey 4: a practice exam that comes up short (some planned questions could not be written: a busy AI service)
// opens with what it has, says the rest is coming, and finishes itself: the rest are written and added at the end.
import { test, expect, expectNoOverflow, pickOption } from "./support/fixtures";
import { db, seedExam } from "./support/seed";
import type { ExamPlan } from "@/lib/examPlan";

// The failure itself (a call failing part-way, the key rule, the retry limits) is covered call by call in
// tests/w3-writer.test.ts and tests/sonnet28-exam-plan.test.ts. Here the short state is seeded, because the fake AI's
// failure switch (AI_FAKE_FAIL) counts calls for the whole server and would disturb the other journeys.
test("a short exam (rest seeded as not yet written) finishes itself while she answers", async ({ page, signIn }) => {
  const w = seedExam({ name: "Endodontics block (short exam)" });
  await signIn(w.userId);

  // A complete 10-question exam, written by the fake AI through the real form.
  await page.goto(`/exams/${w.examId}`);
  const form = page.locator("section").filter({ has: page.getByRole("heading", { name: "Practice exam" }) });
  await form.getByRole("group", { name: "Length" }).getByRole("button", { name: "10", exact: true }).click();
  await form.getByRole("button", { name: "Write my practice exam" }).click();
  await page.waitForURL(/\/attempts\/\d+$/);
  const attemptId = Number(page.url().match(/\/attempts\/(\d+)$/)![1]);
  await expect(page.getByRole("heading", { name: "Practice exam · Learn" })).toBeVisible({ timeout: 45_000 });

  // Make it short, as a busy AI service would have left it: its last three planned questions never written, the exam
  // marked short for that reason, and its last try long enough ago that the next look at it writes the rest.
  db.transaction(() => {
    const row = db.prepare("SELECT slots_json FROM attempts WHERE id = ?").get(attemptId) as { slots_json: string };
    const plan = JSON.parse(row.slots_json) as ExamPlan;
    const last = (db.prepare("SELECT question_id FROM attempt_questions WHERE attempt_id = ? ORDER BY position DESC LIMIT 3").all(attemptId) as { question_id: number }[]).map(
      (r) => r.question_id,
    );
    expect(last).toHaveLength(3);
    for (const s of plan.slots) if (s.question_id != null && last.includes(s.question_id)) Object.assign(s, { state: "failed", question_id: null });
    expect(plan.slots.filter((s) => s.state === "failed")).toHaveLength(3);
    db.prepare(`DELETE FROM attempt_questions WHERE attempt_id = ? AND question_id IN (${last.join(",")})`).run(attemptId);
    db.prepare(`DELETE FROM questions WHERE id IN (${last.join(",")})`).run();
    db.prepare("UPDATE attempts SET slots_json = ?, short_reason = 'busy', resumed_at = datetime('now', '-10 minutes') WHERE id = ?").run(JSON.stringify(plan), attemptId);
  })();

  // She opens it: seven questions, and a line saying the rest is coming.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Practice exam · Learn" })).toBeVisible();
  const grid = page.getByRole("list", { name: "Questions" }).getByRole("listitem");
  await expect(page.getByText(/^7 of 10 questions so far\. The rest (will be written shortly|are being written and will appear at the end)\.$/)).toBeVisible();
  await expectNoOverflow(page, "a short exam");
  // She answers the first while the rest is written (no reload: the page fetches the exam every 10 s).
  await pickOption(page, true);
  await page.getByRole("button", { name: "Confident", exact: true }).click();
  await expect(page.getByText("✓ Correct").first()).toBeVisible();

  await expect(page.getByText("3 more questions were added at the end")).toBeVisible({ timeout: 40_000 });
  await expect(grid).toHaveCount(10);
  await expect(page.getByText("All 10 questions are in.")).toBeVisible();
  await expect(page.getByText("Question 1 of 10")).toBeVisible();
  await expectNoOverflow(page, "the exam once complete");

  // Finish: the results count all ten.
  await page.getByRole("button", { name: "Finish · 1/10" }).click();
  await page.getByRole("alertdialog", { name: "Finish the exam?" }).getByRole("button", { name: "Yes, finish" }).click();
  await expect(page.getByRole("img", { name: /^Score 10 percent, 1 of 10 right/ })).toBeVisible();
  await expect(page.getByText("10% · 1/10", { exact: true }).first()).toBeVisible();
});
