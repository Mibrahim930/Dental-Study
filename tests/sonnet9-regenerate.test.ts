// QA round 9: "Write new questions" and the exam-style prompts.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { purpose: string; system: string; content: string }[] = [];
let tryNo = 0;
let failWriter = false;
let gate: Promise<void> | null = null;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; system: string; content: string }) => {
    calls.push({ purpose: opts.purpose, system: opts.system, content: opts.content });
    if (opts.purpose === "section quiz") {
      if (gate) await gate;
      if (failWriter) throw new Error("overloaded");
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
import { POST as regenPOST } from "@/app/api/sessions/[id]/quiz/regenerate/route";
import { POST as checkPOST } from "@/app/api/sessions/[id]/check/route";
import { POST as reportPOST } from "@/app/api/sessions/[id]/quiz/report/route";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { makeUser } from "./helpers";

const notes = (i: number) =>
  JSON.stringify({ title: `slide ${i}`, summary: "s", image_description: null, key_facts: ["a", "b"], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

function world(userId = makeUser(), slides = 6) {
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
const post = (h: (r: Request, c: never) => Promise<Response>, id: number, body: unknown) =>
  h(new Request("http://x/r", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(id));
const count = (p: string) => calls.filter((c) => c.purpose === p).length;
const stored = (w: { topic: () => Topic }) => JSON.parse(w.topic().checks_json!) as QuizQuestion[];

beforeEach(() => {
  calls.length = 0;
  tryNo = 0;
  failWriter = false;
  gate = null;
});

describe("stability of a cached version-2 quiz", () => {
  it("no AI call across repeats, answering, reporting, GETs", async () => {
    const w = world();
    currentUserId = w.userId;
    await getSectionQuiz(w.topic());
    const before = calls.length;
    const ids = stored(w).map((q) => q.id);
    await getSectionQuiz(w.topic());
    expect((await post(checkPOST, w.sessionId, { topicId: w.topicId, index: 0, chosen: 1 })).status).toBe(200);
    expect((await post(reportPOST, w.sessionId, { topicId: w.topicId, questionId: ids[2], note: "bad" })).status).toBe(200);
    const res = await quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId));
    expect(res.status).toBe(200);
    db.prepare("UPDATE topics SET lesson_json = NULL WHERE id = ?").run(w.topicId);
    db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId);
    await getSectionQuiz(w.topic());
    expect(calls.length).toBe(before);
    expect(stored(w).map((q) => q.id)).toEqual(ids);
    expect(w.topic().checks_version).toBe(2);
  });
});

describe("regenerate", () => {
  it("two simultaneous POSTs end in one consistent 20-question v2 quiz", async () => {
    const w = world();
    currentUserId = w.userId;
    await getSectionQuiz(w.topic());
    await post(checkPOST, w.sessionId, { topicId: w.topicId, index: 0, chosen: 0 });
    const initial = count("section quiz");
    const [a, b] = await Promise.all([post(regenPOST, w.sessionId, { topicId: w.topicId }), post(regenPOST, w.sessionId, { topicId: w.topicId })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(stored(w)).toHaveLength(20);
    expect(w.topic().checks_version).toBe(2);
    expect(count("section quiz") - initial).toBe(2); // one deduped generation (two half calls)
    const rows = db.prepare("SELECT check_index FROM session_checks WHERE topic_id = ?").all(w.topicId) as { check_index: number | null }[];
    expect(rows.every((r) => r.check_index === null)).toBe(true);
  });

  it("regenerate while the first-ever generation is in flight joins it and leaves a good quiz", async () => {
    const w = world();
    currentUserId = w.userId;
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const first = getSectionQuiz(w.topic());
    const regen = post(regenPOST, w.sessionId, { topicId: w.topicId });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await first;
    expect((await regen).status).toBe(200);
    expect(stored(w)).toHaveLength(20);
    expect(count("section quiz")).toBe(2);
  });

  it("AI failure keeps the old quiz and its answers (plain 500); the old questions are still served afterwards", async () => {
    const w = world();
    currentUserId = w.userId;
    const old = await getSectionQuiz(w.topic());
    failWriter = true;
    const res = await post(regenPOST, w.sessionId, { topicId: w.topicId });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).not.toMatch(/overloaded/);
    expect(stored(w).map((q) => q.id)).toEqual(old.map((q) => q.id)); // nothing lost
    failWriter = false;
    expect((await quizGET(new Request("http://x/q?position=0"), ctx(w.sessionId))).status).toBe(200);
    expect(stored(w).map((q) => q.id)).toEqual(old.map((q) => q.id)); // and no silent rewrite either
  });

  it("new quiz has no hidden flags", async () => {
    const w = world();
    currentUserId = w.userId;
    await getSectionQuiz(w.topic());
    await post(reportPOST, w.sessionId, { topicId: w.topicId, questionId: stored(w)[0].id, note: "n" });
    expect(stored(w).some((q) => q.hidden)).toBe(true);
    await post(regenPOST, w.sessionId, { topicId: w.topicId });
    expect(stored(w).some((q) => q.hidden)).toBe(false);
  });

  it("touches only its own topic row", async () => {
    const a = world();
    const b = world();
    currentUserId = a.userId;
    await getSectionQuiz(a.topic());
    await getSectionQuiz(b.topic());
    const bBefore = b.topic().checks_json;
    await post(regenPOST, a.sessionId, { topicId: a.topicId });
    expect(b.topic().checks_json).toBe(bBefore);
  });

  it("abuse: bad bodies, ids, no body", async () => {
    const w = world();
    currentUserId = w.userId;
    for (const body of [{ topicId: 1.5 }, { topicId: null }, { topicId: [w.topicId] }, { topicId: 1e300 }, "not json", "", "null", "[]", { topicId: -1 }]) {
      expect((await post(regenPOST, w.sessionId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(regenPOST, NaN, { topicId: w.topicId })).status).toBe(404);
    expect((await regenPOST(new Request("http://x/r", { method: "POST" }), ctx(w.sessionId))).status).toBe(400);
    expect((await post(regenPOST, w.sessionId, { topicId: "x".repeat(2_000_000) })).status).toBe(400);
    expect(w.topic().checks_json).toBeNull();
    expect(count("section quiz")).toBe(0);
  });
});

describe("exam style in prompts", () => {
  it("quiz writer and judge carry it; no leftover contradictory rule", async () => {
    const w = world();
    await getSectionQuiz(w.topic());
    const writer = calls.find((c) => c.purpose === "section quiz")!.system;
    expect(writer).toContain(EXAM_STYLE);
    expect(writer).not.toMatch(/No "all of the above"/);
    expect(calls.find((c) => c.purpose === "section quiz check")!.system).toContain("not the same kind of thing as the keyed answer");
  });

  it("practice-exam and case-set writers carry it", () => {
    const src = readFileSync("src/lib/practice.ts", "utf8");
    expect(src).toMatch(/const SYSTEM = `[\s\S]*?\$\{EXAM_STYLE\}`/);
    expect(src).toMatch(/const CASE_SYSTEM = `[\s\S]*?\$\{EXAM_STYLE\}`/);
    expect(src).not.toMatch(/no "all\/none of the above"/i);
  });
});
