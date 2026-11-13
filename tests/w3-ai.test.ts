// Wave 3, AI activity and the fake AI (docs/EXAM-PLAN.md "AI activity", "Fake AI for browser tests"): every call is
// logged (failures too, with a short masked reason and a ref), the Admin card's numbers, and AI_FAKE=1 driving the real
// library end to end (slides → sections → lesson → section quiz → practice exam → quiz me) with no SDK mock answering.
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  anthropic: null as null | (() => Promise<unknown>),
  openai: null as null | (() => Promise<unknown>),
  sdkCalls: 0,
  admin: 0,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  requireAdmin: async () => ({ id: h.admin }),
}));

// The SDKs, faked at the edge for the failure-logging tests (fake mode must never reach them: sdkCalls stays 0 there).
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    beta = {
      messages: {
        stream: () => {
          h.sdkCalls++;
          return { finalMessage: () => (h.anthropic ? h.anthropic() : Promise.reject(new Error("no fake reply"))) };
        },
      },
    };
    messages = { batches: {} };
  }
  return { default: Anthropic };
});
vi.mock("openai", () => {
  class OpenAI {
    responses = {
      parse: () => {
        h.sdkCalls++;
        return h.openai ? h.openai() : Promise.reject(new Error("no fake reply"));
      },
    };
  }
  return { default: OpenAI };
});

import { db, FILES_DIR, type Topic } from "@/lib/db";
import { encryptSecret } from "@/lib/auth";
import { generate, failureLine } from "@/lib/ai";
import { fakeAnswerNow } from "@/lib/aiFake";
import { aiActivity, purposeLabel } from "@/lib/aiActivity";
import { processDocument, pollBatches, parseNotes } from "@/lib/processing";
import { SlideNotes } from "@/lib/notes";
import { getLesson, getSectionQuiz } from "@/lib/study";
import { startAttempt } from "@/lib/practice";
import { createQuizMe } from "@/lib/quizMe";
import { readSchedule } from "@/lib/scheduleImport";
import { validateMcq } from "@/lib/mcq";
import { missingProductionConfig } from "@/instrumentation";
import { makeUser } from "./helpers";

const KEY = "sk-ant-test-0123456789abcdef";

function student(provider: "anthropic" | "openai"): number {
  const id = makeUser();
  db.prepare("UPDATE users SET provider = ?, api_key_enc = ?, must_change_password = 0 WHERE id = ?").run(provider, encryptSecret(KEY), id);
  return id;
}

const usage = (userId: number) =>
  db.prepare("SELECT purpose, model, ok, error, ref, cost_usd, input_tokens, output_tokens FROM ai_usage WHERE user_id = ? ORDER BY id").all(userId) as {
    purpose: string;
    model: string;
    ok: number;
    error: string | null;
    ref: string | null;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  }[];

/** A lecture as uploaded: pages rendered (an image on disk and a text layer) but not read yet. */
function uploaded(examId: number, name: string, texts: string[]): { doc: number; pages: number[] } {
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, ?, ?, 'processing')").run(examId, name, texts.length).lastInsertRowid);
  fs.mkdirSync(path.join(FILES_DIR, `doc-${doc}`), { recursive: true });
  const pages = texts.map((text, i) => {
    const rel = path.join(`doc-${doc}`, `p${i + 1}.jpg`);
    fs.writeFileSync(path.join(FILES_DIR, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return Number(db.prepare("INSERT INTO pages (document_id, page_number, text, image_path, status) VALUES (?, ?, ?, ?, 'pending')").run(doc, i + 1, text, rel).lastInsertRowid);
  });
  return { doc, pages };
}

async function until<T>(get: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const topicsOf = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];

beforeEach(() => {
  vi.stubEnv("AI_FAKE", "1");
  h.anthropic = null;
  h.openai = null;
  h.sdkCalls = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fake AI, end to end through the real library", () => {
  it("reads slides, maps sections, writes a lesson, a section quiz, a practice exam and a quiz-me, all logged as model fake at no cost", async () => {
    const userId = student("openai");
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Endo')").run(userId).lastInsertRowid);
    const texts = [
      "Pulpitis\nReversible pulpitis hurts briefly with cold\nIrreversible pulpitis lingers",
      "Pulp tests\nCold test is the first test\nEPT checks nerve response",
      "Necrosis\nA necrotic pulp does not respond\nImportant: know this",
      "Case: lingering pain after cold, what is it?\nAnswer: symptomatic irreversible pulpitis",
      "Abscess\nAcute apical abscess swells",
      "Treatment\nRoot canal treatment removes the pulp",
    ];
    const lec = uploaded(examId, "Endo1.pdf", texts);
    await processDocument(lec.doc);

    const pages = db.prepare("SELECT * FROM pages WHERE document_id = ? ORDER BY page_number").all(lec.doc) as { status: string; notes_json: string; emphasized: number; has_case: number }[];
    expect(pages.every((p) => p.status === "done")).toBe(true);
    for (const p of pages) expect(SlideNotes.safeParse(parseNotes(p)).success).toBe(true);
    expect(pages[2].emphasized).toBe(1);
    expect(pages[3].has_case).toBe(1);
    expect((db.prepare("SELECT status FROM documents WHERE id = ?").get(lec.doc) as { status: string }).status).toBe("done");

    // The finished lecture starts its section map by itself.
    await until(() => (db.prepare("SELECT topic_status FROM exams WHERE id = ?").get(examId) as { topic_status: string }).topic_status === "ready");
    const topics = topicsOf(examId);
    expect(topics.map((t) => (JSON.parse(t.page_ids) as number[]).length)).toEqual([3, 3]);
    expect(topics.flatMap((t) => JSON.parse(t.page_ids) as number[])).toEqual(lec.pages);

    // The lesson: every slide explained, every fact claimed, so no fix-up call.
    const lesson = await getLesson(topics[0]);
    expect(lesson.slides.map((s) => s.page_id)).toEqual(JSON.parse(topics[0].page_ids));
    expect(lesson.intro).toMatch(/fake/i);
    expect(lesson.key_points.length).toBeGreaterThanOrEqual(5);
    expect(lesson.key_points[0]).toMatch(/^★ /);
    expect(usage(userId).some((u) => u.purpose === "lesson repair")).toBe(false);

    // The section quiz: one question per planned slot, each kept by the app's own checks and the judge.
    const quiz = await getSectionQuiz(db.prepare("SELECT * FROM topics WHERE id = ?").get(topics[0].id) as Topic);
    const own = new Set(JSON.parse(topics[0].page_ids) as number[]);
    expect(quiz.length).toBeGreaterThanOrEqual(5);
    for (const q of quiz) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(own.has(q.source_page_id!)).toBe(true);
      expect(q.question).toMatch(/^Fake question \d+/);
    }
    expect(usage(userId).some((u) => u.purpose === "section quiz check")).toBe(true);

    // A practice exam and a case-set exam.
    for (const style of ["mixed", "caseset"] as const) {
      const attempt = startAttempt(examId, { size: style === "caseset" ? 4 : 6, mode: "tutor", style });
      const a = await until(() => {
        const r = db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(attempt) as { status: string; error: string | null };
        return r.status !== "generating" && r;
      });
      expect(a).toMatchObject({ status: "ready" });
      const qs = db.prepare("SELECT q.* FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ?").all(attempt) as {
        options: string;
        correct_index: number;
        type: string;
      }[];
      expect(qs.length).toBeGreaterThanOrEqual(style === "caseset" ? 3 : 6);
      for (const q of qs) {
        const options = JSON.parse(q.options) as string[];
        expect(options).toHaveLength(5);
        expect(new Set(options).size).toBe(5);
        expect(options[q.correct_index]).not.toMatch(/fake distractor/);
      }
      if (style === "caseset") expect(qs.every((q) => q.type === "case")).toBe(true);
      // The fake writer answers every planned question of the exam: nothing is left to write.
      const plan = JSON.parse((db.prepare("SELECT slots_json FROM attempts WHERE id = ?").get(attempt) as { slots_json: string }).slots_json) as { slots: { state: string }[] };
      expect(plan.slots.every((s) => s.state === "done")).toBe(true);
      expect(qs).toHaveLength(plan.slots.length);
    }

    // Quiz me on a highlighted passage.
    const qm = await createQuizMe({ userId, examId, topicId: topics[1].id, text: "Acute apical abscess swells and root canal treatment removes the pulp", size: 3 });
    expect(qm.questions).toHaveLength(3);

    const rows = usage(userId);
    expect(rows.length).toBeGreaterThan(8);
    expect(rows.every((r) => r.model === "fake" && r.cost_usd === 0 && r.ok === 1)).toBe(true);
    expect(new Set(rows.map((r) => r.purpose))).toEqual(
      new Set(["read slides", "topic map", "lesson", "section quiz", "section quiz check", "practice questions", "case sets", "quiz me"]),
    );
    expect(h.sdkCalls).toBe(0);
  });

  it("Claude keys: the slide batch is answered at once from memory and collected by the next poll", async () => {
    const userId = student("anthropic");
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Perio')").run(userId).lastInsertRowid);
    const lec = uploaded(examId, "Perio.pdf", ["Gingiva\nHealthy gingiva is pink", "Pockets\nProbing over 4 mm is a pocket", "Bone\nBone loss shows on films", "Plaque\nPlaque causes gingivitis", "Thanks\nThank you"]);
    await processDocument(lec.doc);
    expect((db.prepare("SELECT batch_id FROM documents WHERE id = ?").get(lec.doc) as { batch_id: string | null }).batch_id).toMatch(/^fake-batch-/);
    await pollBatches();
    const doc = db.prepare("SELECT status, batch_id FROM documents WHERE id = ?").get(lec.doc) as { status: string; batch_id: string | null };
    expect(doc).toEqual({ status: "done", batch_id: null });
    const filler = db.prepare("SELECT is_filler FROM pages WHERE document_id = ? AND page_number = 5").get(lec.doc) as { is_filler: number };
    expect(filler.is_filler).toBe(1);
    expect(usage(userId).filter((u) => u.purpose === "read slides (batch)")).toMatchObject([{ model: "fake", ok: 1, cost_usd: 0 }]);
    expect(h.sdkCalls).toBe(0);
  });

  it("schedule import: dated lines become exams", async () => {
    const userId = student("openai");
    const out = await readSchedule({ creds: { userId, provider: "openai", apiKey: KEY }, today: "2026-11-13", timezone: "UTC", text: "Endo block exam 2026-12-01\nPerio quiz 2026-12-05\nLecture on Monday", images: [] });
    expect(out.exams).toMatchObject([
      { name: "Endo block exam", date: "2026-12-01", kind: "block" },
      { name: "Perio quiz", date: "2026-12-05", kind: "quiz" },
    ]);
  });

  it("practice questions to a plan: one per numbered slot, its number echoed, 5 valid options", async () => {
    const userId = student("openai");
    const Out = z.object({
      questions: z.array(
        z.object({
          slot: z.number(),
          type: z.enum(["recall", "case", "image"]),
          image_page_id: z.number().nullable(),
          patient_box: z.object({ patient: z.string() }).passthrough().nullable(),
          stem: z.string(),
          options: z.array(z.string()),
          correct_index: z.number(),
          correct_answer: z.string(),
          explanation: z.string(),
          option_notes: z.array(z.string()),
          source_page_id: z.number(),
          concept: z.string(),
        }),
      ),
    });
    const content = `Topic: T\nConcept names: Pulpitis\n\nWrite these 3 questions:\nQ4: slide P7 — fact: "Cold test is the first test" — recall\nQ5: slide P8 — fact: "A necrotic pulp does not respond" — case\nQ9: slide P7 — recall\n\nSlides:\n[P7] L.pdf slide 1: Tests\n- Cold test is the first test\n\n[P8] L.pdf slide 2: Necrosis\n- A necrotic pulp does not respond`;
    const out = await generate({ creds: { userId, provider: "openai", apiKey: KEY }, purpose: "practice questions", schema: Out, system: "S", content, ref: "attempt:12" });
    expect(out.questions.map((q) => [q.slot, q.source_page_id, q.type])).toEqual([
      [4, 7, "recall"],
      [5, 8, "case"],
      [9, 7, "recall"],
    ]);
    for (const q of out.questions) {
      const v = validateMcq(q, { optionCount: 5, validPageIds: new Set([7, 8]) });
      expect(typeof v).not.toBe("string");
    }
    expect(out.questions[0].options[out.questions[0].correct_index]).toBe("Cold test is the first test");
    expect(out.questions[0].stem).toMatch(/cold, test, first/);
    expect(usage(userId).at(-1)).toMatchObject({ purpose: "practice questions", ref: "attempt:12", model: "fake" });
  });

  it("a writer that drifts from the caller's schema fails loudly, and so does a purpose no writer knows", () => {
    expect(() => fakeAnswerNow({ purpose: "topic map", schema: z.object({ sections: z.array(z.string()) }), system: "", content: "[P1] slide 1: A — a | concepts: c" })).toThrow(/doesn't fit/);
    expect(() => fakeAnswerNow({ purpose: "mystery", schema: z.object({}), system: "", content: "" })).toThrow(/no writer/);
  });

  it("is refused in production, at start-up and by generate()", async () => {
    expect(missingProductionConfig({ NODE_ENV: "production", SECRET_KEY: "s", APP_PASSCODE: "p", DATA_DIR: "/data", AI_FAKE: "1" })).toBe("AI_FAKE must not be set in production");
    expect(missingProductionConfig({ NODE_ENV: "production", SECRET_KEY: "s", APP_PASSCODE: "p", DATA_DIR: "/data" })).toBeNull();
    expect(missingProductionConfig({ NODE_ENV: "development", AI_FAKE: "1" })).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    const userId = student("openai");
    await expect(generate({ creds: { userId, provider: "openai", apiKey: KEY }, purpose: "quiz me", schema: z.object({}), system: "", content: "" })).rejects.toThrow(
      /AI_FAKE must not be set in production/,
    );
    expect(h.sdkCalls).toBe(0);
  });

  it("AI_FAKE_DELAY_MS makes every answer wait", async () => {
    vi.stubEnv("AI_FAKE_DELAY_MS", "150");
    const userId = student("openai");
    const t = Date.now();
    await generate({ creds: { userId, provider: "openai", apiKey: KEY }, purpose: "section quiz check", schema: z.object({ verdicts: z.array(z.object({ n: z.number() })) }), system: "", content: "Slides:\n\n\nQuestions:\n1. a" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(140);
  });
});

describe("failed calls are logged", () => {
  const schema = z.object({ ok: z.number() });
  const apiError = (status: number, message: string) => Object.assign(new Error(`${status} ${JSON.stringify({ type: "error", error: { type: "x", message } })}`), { status, error: { type: "error", error: { type: "x", message } } });
  beforeEach(() => vi.stubEnv("AI_FAKE", ""));

  it("a thrown 401, 429 and 529: ok 0, status and the provider's short message, no cost, key text masked, the error rethrown as it was", async () => {
    const userId = student("anthropic");
    const creds = { userId, provider: "anthropic" as const, apiKey: KEY };
    const cases: [number, string][] = [
      [401, `invalid x-api-key ${KEY}`],
      [429, "rate limited, key sk-other-secret-999 used too much"],
      [529, "Overloaded"],
    ];
    for (const [status, message] of cases) {
      const err = apiError(status, message);
      h.anthropic = () => Promise.reject(err);
      await expect(generate({ creds, purpose: "lesson", schema, system: "S", content: "c", ref: "topic:3" })).rejects.toBe(err);
    }
    const rows = usage(userId);
    expect(rows.map((r) => [r.ok, r.error, r.cost_usd, r.ref])).toEqual([
      [0, "401 invalid x-api-key [key]", 0, "topic:3"],
      [0, "429 rate limited, key [key] used too much", 0, "topic:3"],
      [0, "529 Overloaded", 0, "topic:3"],
    ]);
    expect(rows.every((r) => !r.error!.includes("sk-"))).toBe(true);
  });

  it("a cut-off and a refusal were billed: their tokens and cost are logged with ok 0", async () => {
    const userId = student("anthropic");
    const creds = { userId, provider: "anthropic" as const, apiKey: KEY };
    for (const stop of ["max_tokens", "refusal"]) {
      h.anthropic = async () => ({ model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 500 }, stop_reason: stop, parsed_output: null });
      await expect(generate({ creds, purpose: "section quiz", schema, system: "S", content: "c" })).rejects.toThrow(stop === "refusal" ? /declined/ : /cut off/);
    }
    const rows = usage(userId);
    expect(rows.map((r) => [r.ok, r.error, r.input_tokens, r.output_tokens])).toEqual([
      [0, "cut off", 1000, 500],
      [0, "refused", 1000, 500],
    ]);
    for (const r of rows) expect(r.cost_usd).toBeCloseTo((1000 * 2 + 500 * 10) / 1e6, 10);
  });

  it("ChatGPT: a thrown error and an incomplete answer", async () => {
    const userId = student("openai");
    const creds = { userId, provider: "openai" as const, apiKey: KEY };
    h.openai = () => Promise.reject(Object.assign(new Error("401 Incorrect API key provided"), { status: 401, error: { message: `Incorrect API key provided: ${KEY}` } }));
    await expect(generate({ creds, purpose: "quiz me", schema, system: "S", content: "c" })).rejects.toThrow(/401/);
    h.openai = async () => ({ model: "gpt-6.1-sol", status: "incomplete", output_parsed: null, output: [], usage: { input_tokens: 100, output_tokens: 50 } });
    await expect(generate({ creds, purpose: "quiz me", schema, system: "S", content: "c" })).rejects.toThrow(/cut off/);
    expect(usage(userId).map((r) => [r.ok, r.error, r.output_tokens])).toEqual([
      [0, "401 Incorrect API key provided: [key]", 0],
      [0, "cut off", 50],
    ]);
  });

  it("a call that works is logged ok with its ref", async () => {
    const userId = student("anthropic");
    h.anthropic = async () => ({ model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn", parsed_output: { ok: 1 } });
    await generate({ creds: { userId, provider: "anthropic", apiKey: KEY }, purpose: "lesson", schema, system: "S", content: "c", ref: "topic:9" });
    expect(usage(userId)).toMatchObject([{ ok: 1, error: null, ref: "topic:9", model: "claude-sonnet-5-5" }]);
  });

  it("when logging itself fails, the caller still gets the original error (and a success its answer)", async () => {
    const userId = student("anthropic");
    const creds = { userId, provider: "anthropic" as const, apiKey: KEY };
    const real = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("INSERT INTO ai_usage")) throw new Error("disk full");
      return real(sql);
    }) as typeof db.prepare);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = apiError(500, "Internal error");
    h.anthropic = () => Promise.reject(err);
    await expect(generate({ creds, purpose: "lesson", schema, system: "S", content: "c" })).rejects.toBe(err);
    h.anthropic = async () => ({ model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", parsed_output: { ok: 7 } });
    await expect(generate({ creds, purpose: "lesson", schema, system: "S", content: "c" })).resolves.toEqual({ ok: 7 });
  });

  it("failureLine: one line, at most 200 characters, masked", () => {
    const line = failureLine(new Error(`boom ${"x".repeat(300)}\nsecond line`));
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).not.toContain("\n");
    expect(failureLine(new Error(`token ${"A1b2".repeat(12)} here`))).toBe("token [key] here");
    expect(failureLine(new Error("my key abcdef123 leaked"), "abcdef123")).toBe("my key [key] leaked");
  });
});

describe("aiActivity (the Admin card)", () => {
  it("per purpose: calls, failures, the most common error, costs and output tokens; a lessons line; old rows and empty purposes left out", () => {
    db.prepare("DELETE FROM ai_usage").run(); // (the card is site-wide: earlier tests in this file logged calls too)
    const userId = makeUser();
    const ins = db.prepare(
      "INSERT INTO ai_usage (user_id, provider, model, purpose, output_tokens, cost_usd, ok, error, ref, created_at) VALUES (?, 'anthropic', 'm', ?, ?, ?, ?, ?, ?, datetime('now', ?))",
    );
    const row = (purpose: string, cost: number, out: number, ok = 1, error: string | null = null, ref: string | null = null, age = "-1 hours") =>
      ins.run(userId, purpose, out, cost, ok, error, ref, age);
    // Lessons: topic 1 twice (two parts) with a repair, topic 2 once with a failed part, one old call without a ref.
    row("lesson", 0.02, 100, 1, null, "topic:1");
    row("lesson", 0.02, 100, 1, null, "topic:1");
    row("lesson repair", 0.01, 50, 1, null, "topic:1");
    row("lesson", 0.0, 0, 0, "529 Overloaded", "topic:2");
    row("lesson", 0.03, 120, 1, null, "topic:2");
    row("lesson", 0.01, 10, 1, null, null);
    // Section quizzes: two failures with one error, one with another.
    row("section quiz", 0.1, 300);
    row("section quiz", 0, 0, 0, "429 rate limited");
    row("section quiz", 0, 0, 0, "429 rate limited");
    row("section quiz", 0.05, 200, 0, "cut off");
    // Too old to count.
    row("quiz me", 1, 999, 0, "old", null, "-8 days");

    const a = aiActivity(7);
    expect(a.purposes.map((p) => p.purpose)).toEqual(["lesson", "section quiz", "lesson repair"]);
    const lesson = a.purposes[0];
    expect(lesson).toMatchObject({ label: "Lessons", calls: 5, failed: 1, topError: "529 Overloaded", outputTokens: 330 });
    expect(lesson.totalCost).toBeCloseTo(0.08, 10);
    expect(lesson.avgCost).toBeCloseTo(0.016, 10);
    expect(a.purposes[1]).toMatchObject({ label: "Section quizzes", calls: 4, failed: 3, topError: "429 rate limited", outputTokens: 500 });
    expect(a.purposes[2]).toMatchObject({ label: "Lesson fix-up", calls: 1, failed: 0, topError: null });
    expect(a.lessons).toEqual({ written: 3, repaired: 1, failed: 1 });
    expect(purposeLabel("read slides")).toBe("Reading slides");
    expect(purposeLabel("something new")).toBe("something new");
  });

  it("the Admin page shows the card: a row per purpose, failures in coral with the error under the row, and the lessons line", async () => {
    db.prepare("DELETE FROM ai_usage").run();
    const userId = makeUser();
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(userId);
    h.admin = userId;
    const ins = db.prepare("INSERT INTO ai_usage (user_id, provider, model, purpose, cost_usd, ok, error, ref) VALUES (?, 'anthropic', 'm', ?, ?, ?, ?, ?)");
    ins.run(userId, "read slides", 0.004, 1, null, "doc:1");
    ins.run(userId, "lesson repair", 0.01, 0, "cut off", "topic:1");
    ins.run(userId, "lesson", 0.02, 1, null, "topic:1");
    const { default: AdminPage } = await import("@/app/admin/page");
    const html = renderToStaticMarkup(await AdminPage());
    expect(html).toContain("AI activity (last 7 days)");
    expect(html).toContain("Reading slides");
    expect(html).toContain("Lesson fix-up");
    expect(html).toMatch(/chip cb-coral">1</);
    expect(html).toContain("Most often: cut off");
    expect(html).toContain("Lessons: 1 written, 1 needed a fix-up");

    db.prepare("DELETE FROM ai_usage").run();
    expect(renderToStaticMarkup(await AdminPage())).toContain("No AI calls in the last 7 days.");
  });

  it("nothing logged: no purposes and no lessons line", () => {
    db.prepare("DELETE FROM ai_usage").run();
    expect(aiActivity()).toEqual({ days: 7, purposes: [], lessons: null });
  });
});
