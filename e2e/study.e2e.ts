// Journey 1: studying a section. The lesson is written once (one request), shows one entry per slide with its picture,
// counts as studied only once it is on screen, its quiz scores "N% · a/b", and the next section is written ahead only
// when the quiz comes into view.
import { test, expect, expectNoOverflow, lessonRequests, pickOption } from "./support/fixtures";
import { isStudied, seedExam } from "./support/seed";

test("study a section: lesson, studied mark, quiz score, next section written ahead", async ({ page, signIn, apiLog }) => {
  const w = seedExam({ name: "Endodontics block (study)" });
  await signIn(w.userId);

  await page.goto(`/exams/${w.examId}`);
  await expect(page.getByRole("heading", { name: "Guided study with lessons, slides and quizzes" })).toBeVisible();
  await expectNoOverflow(page, "the exam page");

  // Hold the first lesson's answer until the database has been checked: written, but not on screen yet, so not studied.
  let lessonWritten!: () => void;
  const written = new Promise<void>((r) => (lessonWritten = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/sessions\/\d+\/lesson\?position=0$/, async (route) => {
    const response = await route.fetch();
    lessonWritten();
    await released;
    await route.fulfill({ response });
  });

  await page.getByRole("link", { name: /Start studying/ }).click();
  await expect(page).toHaveURL(new RegExp(`/exams/${w.examId}/study$`));
  await expect(page.getByRole("heading", { name: "Pulpal diagnosis", level: 1 })).toBeVisible();
  await expect(page.getByText(/Writing this section.s lesson from every slide/)).toBeVisible();
  await written;
  expect(isStudied(w.userId, w.topicIds[0]), "studied before the lesson was shown").toBe(false);
  expect(apiLog.filter((l) => l.includes("/shown")), "lesson reported as shown before it arrived").toEqual([]);
  release();

  // One entry per slide, each with its slide number and picture.
  const slides = w.pageIds[0].length;
  // A lesson entry is the list item holding a slide's zoom button (the key points are a list too).
  const entries = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /^Zoom slide \d+$/ }) });
  await expect(entries).toHaveCount(slides);
  for (let i = 0; i < slides; i++) {
    const entry = entries.nth(i);
    await expect(entry.getByText(`Slide ${i + 1}`, { exact: true })).toBeVisible();
    await expect(entry.getByText(w.sections[0].slides[i].title).first()).toBeVisible();
    const img = entry.getByRole("img", { name: `Slide ${i + 1}` });
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(entries.getByText("★ You emphasized this", { exact: true })).toHaveCount(1);
  expect(lessonRequests(apiLog, 0).opened, "lesson requests for section 1").toBe(1);

  // Studied once on screen (the page reports it), not before.
  await expect.poll(() => isStudied(w.userId, w.topicIds[0])).toBe(true);
  expect(isStudied(w.userId, w.topicIds[1])).toBe(false);
  await expectNoOverflow(page, "the lesson");

  // Nothing written ahead until the quiz is reached.
  expect(lessonRequests(apiLog, 1).prefetched + lessonRequests(apiLog, 1).opened, "section 2 asked for before the quiz was reached").toBe(0);
  const quiz = page.locator("section").filter({ hasText: /^Section quiz · \d+ of \d+/ }).or(page.getByText(/Writing this section.s quiz/));
  await quiz.first().scrollIntoViewIfNeeded();
  await expect(page.getByText(/^Section quiz · 1 of \d+$/)).toBeVisible({ timeout: 30_000 });
  await page.getByText(/^Section quiz · 1 of \d+$/).scrollIntoViewIfNeeded();
  await expect.poll(() => lessonRequests(apiLog, 1).prefetched).toBe(1);

  // Answer every question: every third one wrong.
  const total = Number((await page.getByText(/^Section quiz · 1 of \d+$/).textContent())!.match(/of (\d+)/)![1]);
  expect(total).toBeGreaterThanOrEqual(slides);
  let right = 0;
  for (let i = 0; i < total; i++) {
    await expect(page.getByText(`Section quiz · ${i + 1} of ${total}`)).toBeVisible();
    const card = page.locator("section").filter({ has: page.getByText(`Section quiz · ${i + 1} of ${total}`) });
    const good = i % 3 !== 1;
    await pickOption(card, good);
    await card.getByRole("button", { name: "Check answer" }).click();
    await expect(card.getByText(good ? "✓ Correct" : /✗ Why [A-D]/).first()).toBeVisible();
    if (good) right++;
    await card.getByRole("button", { name: i + 1 < total ? "Next question →" : "See my score", exact: true }).click();
  }
  const pct = Math.round((right / total) * 100);
  await expect(page.getByText(`${pct}% · ${right}/${total} right`)).toBeVisible();
  await expect(page.getByText("Look again at")).toBeVisible();
  await expectNoOverflow(page, "the quiz score");

  // Still exactly one lesson request for section 1, and section 2 was written ahead once (never opened).
  expect(lessonRequests(apiLog, 0)).toEqual({ opened: 1, prefetched: 0 });
  expect(lessonRequests(apiLog, 1)).toEqual({ opened: 0, prefetched: 1 });

  // The exam page shows section 1 studied and the place she is at.
  await page.goto(`/exams/${w.examId}`);
  await expect(page.getByRole("progressbar", { name: "Pulp and Periapical Diagnosis: 1 of 2 sections done" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Continue/ })).toBeVisible();
  await expectNoOverflow(page, "the exam page after studying");
});
