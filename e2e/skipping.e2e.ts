// Journey 2: tapping "Next section" quickly several times. Only the section she lands on has its lesson written; the
// sections tapped past are never asked for and never count as studied.
import { test, expect, expectNoOverflow, lessonRequests } from "./support/fixtures";
import { isStudied, seedExam } from "./support/seed";

test("skipping quickly through sections writes only the last one's lesson", async ({ page, signIn, apiLog }) => {
  const w = seedExam({ name: "Endodontics block (skipping)" });
  await signIn(w.userId);
  const last = w.topicIds.length - 1;

  // Hold section 1's lesson so she skips past it before it is ever shown.
  await page.route(/\/api\/sessions\/\d+\/lesson\?position=0$/, () => {});
  await page.goto(`/exams/${w.examId}/study`);
  await expect(page.getByRole("heading", { name: "Pulpal diagnosis", level: 1 })).toBeVisible();
  await expect.poll(() => lessonRequests(apiLog, 0).opened).toBe(1);

  // Three quick taps: section 2, the next lecture's first section, its second section.
  const next = page.getByRole("button", { name: /^Next (section|lecture) →$/ });
  for (const title of ["Periapical diagnosis", "Cleaning and shaping", "Obturation and follow-up"]) {
    await next.click();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  }
  await expect(page.getByText("Lecture 2 · Section 2 of 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish session" })).toBeVisible();

  // The last section's lesson arrives and is the only one asked for after the first.
  await expect(page.getByRole("button", { name: /^Zoom slide \d+$/ })).toHaveCount(w.pageIds[last].length, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Zoom slide 4" })).toBeVisible();
  await expectNoOverflow(page, "the last section's lesson");
  for (let p = 1; p < last; p++) expect(lessonRequests(apiLog, p), `section ${p + 1} was asked for`).toEqual({ opened: 0, prefetched: 0 });
  expect(lessonRequests(apiLog, last).opened).toBe(1);
  await expect.poll(() => isStudied(w.userId, w.topicIds[last])).toBe(true);
  for (let p = 0; p < last; p++) expect(isStudied(w.userId, w.topicIds[p]), `section ${p + 1} counted as studied`).toBe(false);

  // The exam page agrees: nothing in lecture 1 studied, one section of lecture 2.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto(`/exams/${w.examId}`);
  await expect(page.getByRole("progressbar", { name: "Pulp and Periapical Diagnosis: 0 of 2 sections done" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Root Canal Treatment: 1 of 2 sections done" })).toBeVisible();
  // Section rows say "studied" to a screen reader; only the last section has it.
  await expect(page.getByText(/^Section \d+, studied:$/)).toHaveCount(1);
  await expectNoOverflow(page, "the exam page after skipping");
});
