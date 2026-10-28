// "Write new questions" is the only way a section quiz changes; and the question writers follow the real-exam style.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { purpose: string; system: string; content: string }[] = [];
let tryNo = 0;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; system: string; content: string }) => {
    calls.push({ purpose: opts.purpose, system: opts.system, content: opts.content });
    if (opts.purpose === "section quiz") {
      tryNo++;
      const slots = [...opts.content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          question: `Q${s.n} on P${s.page} (try ${tryNo})`,
          options: ["right", "w1", "w2", "w3"],
          correct_index: 0,
          correct_answer: "right",
          explanation: "because",
          source_page_id: s.page,
          concept: "C",
        })),
      };
    }
    if (opts.purpose === "section quiz check") {
      const n = (opts.content.match(/^\d+\. /gm) ?? []).length;
      return { verdicts: Array.from({ length: n }, (_, i) => ({ n: i + 1, ok: true, reason: "" })) };
    }
    if (opts.purpose === "practice questions") return { questions: [] };
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db, type Topic } from "@/lib/db";
import { getSectionQuiz, type QuizQuestion } from "@/lib/study";
import { EXAM_STYLE } from "@/lib/examStyle";
import { startAttempt } from "@/lib/practice";
import { POST as regenPOST } from "@/app/api/sessions/[id]/quiz/regenerate/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { makeUser } from "./helpers";

const notes = (i: number) =>
  // Two distinct facts per slide: a 6-slide topic plans 12 questions (one per fact).
  JSON.stringify({ title: `slide ${i}`, summary: "s", image_description: null, key_facts: [`fact a${i}`, `fact b${i}`], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

function world(slides = 6) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = Array.from({ length: slides }, (_, i) =>
    Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(docId, i + 1, notes(i)).lastInsertRowid),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', '', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, topicId, sessionId, topic };
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const regen = (sessionId: number, body: unknown) => regenPOST(new Request("http://x/r", { method: "POST", body: JSON.stringify(body) }), ctx(sessionId));
const check = (sessionId: number, body: unknown) => checkPOST(new Request("http://x/c", { method: "POST", body: JSON.stringify(body) }), ctx(sessionId));

beforeEach(() => {
  calls.length = 0;
  tryNo = 0;
});

describe("a section quiz only changes through \"Write new questions\"", () => {
  it("reopening a topic (new day, new session) serves the same questions with no AI call", async () => {
    const w = world();
    const first = await getSectionQuiz(w.topic());
    const before = calls.length;
    db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId); // the next day's session
    const again = await getSectionQuiz(w.topic());
    expect(again.map((q) => q.id)).toEqual(first.map((q) => q.id));
    expect(calls.length).toBe(before);
  });

  it("regenerate writes a fresh set with new ids, detaches earlier answers, and the page gets a count back", async () => {
    const w = world();
    currentUserId = w.userId;
    const first = await getSectionQuiz(w.topic());
    expect((await check(w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 })).status).toBe(200);
    const res = await regen(w.sessionId, { topicId: w.topicId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 12 });
    const fresh = JSON.parse(w.topic().checks_json!) as QuizQuestion[];
    expect(fresh).toHaveLength(12);
    expect(fresh.map((q) => q.id)).not.toEqual(first.map((q) => q.id));
    expect(fresh.every((q) => !first.some((f) => f.question === q.question))).toBe(true); // really new text
    expect(w.topic().checks_version).toBe(5);
    const rows = db.prepare("SELECT check_index FROM session_checks WHERE session_id = ?").all(w.sessionId) as { check_index: number | null }[];
    expect(rows).toEqual([{ check_index: null }]); // kept for history, no longer tied to a question
  });

  it("refuses strangers, other exams' topics and bad bodies", async () => {
    const w = world();
    const other = world();
    currentUserId = other.userId;
    expect((await regen(w.sessionId, { topicId: w.topicId })).status).toBe(404);
    currentUserId = w.userId;
    expect((await regen(w.sessionId, { topicId: other.topicId })).status).toBe(400);
    expect((await regen(w.sessionId, { topicId: "1" })).status).toBe(400);
    expect((await regen(w.sessionId, {})).status).toBe(400);
    currentUserId = 0;
    expect((await regen(w.sessionId, { topicId: w.topicId })).status).toBe(401);
  });
});

describe("question writers follow the real-exam style", () => {
  it("the quiz writer and the checking pass carry the style rules", async () => {
    const w = world();
    await getSectionQuiz(w.topic());
    const writer = calls.find((c) => c.purpose === "section quiz")!;
    expect(writer.system).toContain("EVERY option is the same kind of thing as the correct answer");
    expect(writer.system).toContain(EXAM_STYLE);
    const judge = calls.find((c) => c.purpose === "section quiz check")!;
    expect(judge.system).toContain("not the same kind of thing as the keyed answer");
  });

  it("the practice-exam writer carries the style rules too", async () => {
    const w = world();
    startAttempt(w.examId, { size: 5, mode: "tutor", style: "recall", adaptive: false });
    await new Promise((r) => setTimeout(r, 50));
    const writer = calls.find((c) => c.purpose === "practice questions");
    expect(writer?.system).toContain(EXAM_STYLE);
  });
});
