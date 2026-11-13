// Journey 6: the end-of-lecture review. Section-quiz questions she got wrong (seeded straight into the database) come
// back as one quiz; one she misses again comes round once more after the between-rounds page, and gets done.
import type { Locator } from "@playwright/test";
import { QUIZ_VERSION } from "@/lib/study";
import { test, expect, expectNoOverflow } from "./support/fixtures";
import { db, seedExam } from "./support/seed";

type Q = { question: string; options: string[]; concept: string };
const QUIZ: Q[][] = [
  [
    {
      question: "Which finding means the pulp is irreversibly inflamed?",
      options: ["Pain to cold that lingers for more than thirty seconds", "Sharp pain to cold that stops at once", "No response to cold at all", "Pain only on biting"],
      concept: "Irreversible pulpitis",
    },
    {
      question: "What does electric pulp testing check?",
      options: ["The nerve response of the pulp", "The blood supply of the pulp", "The periapical bone", "The periodontal ligament"],
      concept: "Sensibility testing",
    },
  ],
  [
    {
      question: "Which cold test is the most reliable?",
      options: ["Refrigerant spray at minus fifty degrees", "An ice stick held on the crown", "Cold water from a syringe", "A blast of air"],
      concept: "Sensibility testing",
    },
  ],
];

/** Pick an option by its text (the review shuffles the options). */
async function choose(panel: Locator, text: string) {
  const option = panel.getByRole("radio", { name: new RegExp(`^[A-D]\\. ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  await option.click();
  await expect(option).toHaveAttribute("aria-checked", "true");
}

test("lecture review: missed questions, a second round for the one missed again", async ({ page, signIn }) => {
  const w = seedExam({ name: "Endodontics block (review)" });
  // Lecture 1's two sections have quizzes; she got the first question of each wrong and the second of section 1 right.
  const answer = db.prepare("INSERT INTO quiz_answers (user_id, topic_id, check_index, chosen, correct) VALUES (?, ?, ?, ?, ?)");
  QUIZ.forEach((qs, s) => {
    const topic = w.topicIds[s];
    const checks = qs.map((q, i) => ({
      id: `e2e-${topic}-${i}`,
      question: q.question,
      options: q.options,
      correct_index: 0,
      explanation: `${q.options[0]}.`,
      option_notes: q.options.map((_, k) => (k === 0 ? "Right: this is what the slide says." : "Wrong: the slide says otherwise.")),
      concept: q.concept,
      source_page_id: w.pageIds[s][0],
      kind: "recall",
    }));
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = ? WHERE id = ?").run(JSON.stringify(checks), QUIZ_VERSION, topic);
    qs.forEach((_, i) => {
      const right = s === 0 && i === 1;
      answer.run(w.userId, topic, i, right ? 0 : 2, right ? 1 : 0);
    });
  });
  const missedAgain = QUIZ[0][0];
  const fixedNow = QUIZ[1][0];
  await signIn(w.userId);

  await page.goto(`/exams/${w.examId}`);
  // Lecture 1's row opens to show its sections and the review button.
  await page.getByText("Pulp and Periapical Diagnosis", { exact: true }).click();
  const start = page.getByRole("button", { name: "Review 2 missed questions" });
  await expect(start).toBeVisible();
  await expectNoOverflow(page, "the exam page with the review button");
  await start.click();

  const panel = page.getByRole("dialog", { name: /^Lecture review · / });
  await expect(panel.getByText("Question 1 of 2")).toBeVisible();
  await expectNoOverflow(page, "the lecture review");
  // Round 1: whichever question comes first, miss the irreversible-pulpitis one again and get the cold-test one right.
  for (let i = 1; i <= 2; i++) {
    await expect(panel.getByText(`Question ${i} of 2`)).toBeVisible();
    const isMissed = await panel.getByText(missedAgain.question).isVisible();
    await choose(panel, isMissed ? missedAgain.options[3] : fixedNow.options[0]);
    await panel.getByRole("button", { name: "Check answer" }).click();
    await expect(panel.getByText(isMissed ? /^✗ Why [A-D]\b/ : "✓ Correct").first()).toBeVisible();
    await panel.getByRole("button", { name: "Next →" }).click();
  }

  // Between rounds: what she missed again comes round once more.
  await expect(panel.getByText("Round 1 done · 50% · 1/2 right")).toBeVisible();
  await expect(panel.getByText("One question you missed again.")).toBeVisible();
  await expectNoOverflow(page, "the between-rounds page");
  await panel.getByRole("button", { name: "Next →" }).click();

  // Round 2: the same question, right this time.
  await expect(panel.getByText("Round 2 · Question 1 of 1")).toBeVisible();
  await expect(panel.getByText(missedAgain.question)).toBeVisible();
  await choose(panel, missedAgain.options[0]);
  await panel.getByRole("button", { name: "Check answer" }).click();
  await expect(panel.getByText("✓ Correct").first()).toBeVisible();
  await panel.getByRole("button", { name: "See my score" }).click();
  await expect(panel.getByText("50% · 1/2 right on the first pass.")).toBeVisible();
  await expect(panel.getByText("1 got right on a later try · all done")).toBeVisible();
  await expectNoOverflow(page, "the review score");
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel).toBeHidden();

  // Both are done: the lecture has nothing left to review.
  await expect(page.getByRole("button", { name: /Review \d+ missed question/ })).toBeHidden();
});
