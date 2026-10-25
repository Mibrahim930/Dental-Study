// Release 3, Job F: "Quiz me on this" — lib/quizMe.ts and the /api/quizme routes.
import { beforeEach, describe, expect, it, vi } from "vitest";

type GenOpts = { purpose: string; tier?: string; content: string; system: string };
type Q = {
  question: string;
  options: string[];
  correct_index: number;
  correct_answer: string;
  explanation: string;
  option_notes: string[];
  concept: string;
  source_page_id: number | null;
  image_page_id: number | null;
};
const gen = vi.hoisted(() => ({
  calls: [] as { purpose: string; tier?: string; content: string; system: string }[],
  questions: (() => []) as (opts: GenOpts) => unknown[],
  fail: null as Error | null,
}));
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: GenOpts) => {
    gen.calls.push({ purpose: opts.purpose, tier: opts.tier, content: opts.content, system: opts.system });
    if (gen.fail) throw gen.fail;
    return { questions: gen.questions(opts) };
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});

import { sessionToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { EXAM_STYLE } from "@/lib/examStyle";
import { answerQuizMe, createQuizMe, getQuizMe, openQuizMe, QuizMeError, searchExamPages, type QuizMeQuestion } from "@/lib/quizMe";
import { POST as createPOST } from "@/app/api/quizme/route";
import { GET as quizGET } from "@/app/api/quizme/[id]/route";
import { POST as answerPOST } from "@/app/api/quizme/[id]/answer/route";
import { GET as openGET } from "@/app/api/quizme/open/route";
import { makeUser } from "./helpers";

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const get = (url = "http://x/api") => new Request(url);

const notes = (i: number) =>
  JSON.stringify({
    title: `slide ${i}`,
    summary: "s",
    image_description: null,
    key_facts: ["a", "b"],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
  });

function apiReadyUser(): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc', must_change_password = 0 WHERE id = ?").run(id);
  return id;
}
function signIn(userId: number | null) {
  if (userId == null) return void (jar.cookie = undefined);
  const { session_epoch } = db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(userId) as { session_epoch: number };
  jar.cookie = sessionToken(userId, session_epoch);
}

function addPage(docId: number, n: number, fts: string | null): number {
  const id = Number(
    db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(docId, n, notes(n)).lastInsertRowid,
  );
  if (fts) db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)").run(id, `slide ${n}`, fts);
  return id;
}

/** A user with one exam: a topic over 3 slides, 8 other slides that mention "hypochlorite", 2 unrelated slides; and a second exam of theirs whose slides also mention it. */
function world(userId = apiReadyUser()) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Endo')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const topicPages = [1, 2, 3].map((n) => addPage(doc, n, `topic slide about irrigation ${n}`));
  const hits = Array.from({ length: 8 }, (_, i) => addPage(doc, 10 + i, `sodium hypochlorite irrigant concentration ${i}`));
  const unrelated = [addPage(doc, 30, "crown preparation margins"), addPage(doc, 31, "occlusal reduction")];
  const topicId = Number(
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Irrigation', 's', ?)").run(examId, JSON.stringify(topicPages)).lastInsertRowid,
  );
  const otherExam = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Other')").run(userId).lastInsertRowid);
  const otherDoc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'O.pdf', 'done')").run(otherExam).lastInsertRowid);
  const otherPages = [addPage(otherDoc, 1, "sodium hypochlorite hypochlorite hypochlorite")];
  const otherTopic = Number(
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'O', 's', ?)").run(otherExam, JSON.stringify(otherPages)).lastInsertRowid,
  );
  return { userId, examId, topicId, topicPages, hits, unrelated, otherExam, otherPages, otherTopic };
}

const TEXT = "Sodium hypochlorite is the main irrigant used in root canal treatment.";

function q(n: number, o: Partial<Q> = {}): Q {
  const options = [`right ${n}`, `wrong ${n}a`, `wrong ${n}b`, `wrong ${n}c`];
  return {
    question: `Question number ${n} about hypochlorite?`,
    options,
    correct_index: 0,
    correct_answer: options[0],
    explanation: `because ${n}`,
    option_notes: options.map((x) => `note for ${x}`),
    concept: "Irrigants",
    source_page_id: null,
    image_page_id: null,
    ...o,
  };
}
const stored = (id: number) => JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
const concept = (userId: number, name = "Irrigants") =>
  db.prepare("SELECT attempts, correct FROM concepts WHERE user_id = ? AND name = ?").get(userId, name) as { attempts: number; correct: number } | undefined;
const pids = (content: string) => new Set([...content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1])));

beforeEach(() => {
  gen.calls.length = 0;
  gen.fail = null;
  gen.questions = (opts) => {
    const n = Number(/Write exactly (\d+) questions/.exec(opts.content)?.[1] ?? 3);
    return Array.from({ length: n }, (_, i) => q(i + 1));
  };
  signIn(null);
});

describe("input checks", () => {
  it("rejects sizes other than 3, 5 or 10 without calling the AI", async () => {
    const w = world();
    for (const size of [0, 1, 4, 6, 20, 3.5, -3]) {
      await expect(createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size })).rejects.toBeInstanceOf(QuizMeError);
    }
    signIn(w.userId);
    for (const size of [4, "5", null]) {
      const res = await createPOST(post({ examId: w.examId, text: TEXT, size }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/3, 5 or 10/);
    }
    expect(gen.calls).toHaveLength(0);
    for (const size of [3, 5, 10]) {
      const res = await createPOST(post({ examId: w.examId, text: TEXT, size }));
      expect(res.status).toBe(200);
      expect((await res.json()).questions).toHaveLength(size);
    }
  });

  it("text must be 20 to 2000 characters (after trimming)", async () => {
    const w = world();
    signIn(w.userId);
    for (const text of ["too short", "   short text padded       ", "x".repeat(2001), 42]) {
      const res = await createPOST(post({ examId: w.examId, text, size: 3 }));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect(gen.calls).toHaveLength(0);
    expect((await createPOST(post({ examId: w.examId, text: "x".repeat(20), size: 3 }))).status).toBe(200);
    expect((await createPOST(post({ examId: w.examId, text: "hypochlorite ".repeat(153).slice(0, 2000), size: 3 }))).status).toBe(200);
  });

  it("a topicId from another exam is refused", async () => {
    const w = world();
    signIn(w.userId);
    const res = await createPOST(post({ examId: w.examId, text: TEXT, size: 3, topicId: w.otherTopic }));
    expect(res.status).toBe(400);
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3, topicId: "1" }))).status).toBe(400);
    expect(gen.calls).toHaveLength(0);
  });
});

describe("slides and the writer call", () => {
  it("uses the topic's slides plus this exam's search hits (top 6), never another exam's", async () => {
    const w = world();
    await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 3 });
    const seen = pids(gen.calls[0].content);
    for (const p of w.topicPages) expect(seen.has(p)).toBe(true);
    const hitCount = w.hits.filter((p) => seen.has(p)).length;
    expect(hitCount).toBe(6);
    for (const p of [...w.otherPages, ...w.unrelated]) expect(seen.has(p)).toBe(false);
    expect(seen.size).toBe(3 + 6);
  });

  it("without a topic, only the search hits", async () => {
    const w = world();
    await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    const seen = pids(gen.calls[0].content);
    expect(seen.size).toBe(6);
    for (const p of seen) expect(w.hits).toContain(p);
  });

  it("searchExamPages is per exam and capped at 6", () => {
    const w = world();
    const found = searchExamPages(w.userId, w.examId, TEXT);
    expect(found).toHaveLength(6);
    for (const p of found) expect(w.hits).toContain(p);
    expect(searchExamPages(w.userId, w.otherExam, TEXT)).toEqual(w.otherPages);
    // Another user's exam id finds nothing.
    expect(searchExamPages(apiReadyUser(), w.examId, TEXT)).toEqual([]);
    expect(searchExamPages(w.userId, w.examId, "the and for")).toEqual([]);
  });

  it("calls the quality tier with purpose 'quiz me' and the exam style rules", async () => {
    const w = world();
    await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 5 });
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0].purpose).toBe("quiz me");
    expect(gen.calls[0].tier).toBe("quality");
    expect(gen.calls[0].system).toContain(EXAM_STYLE);
    expect(gen.calls[0].content).toContain(TEXT);
    expect(gen.calls[0].content).toContain("Write exactly 5 questions");
  });
});

describe("question checks", () => {
  it("drops a bad key and a duplicate stem; keeps questions whose notes are the wrong length, without the notes", async () => {
    const w = world();
    gen.questions = () => [
      q(1),
      q(2, { correct_answer: "wrong 2a" }), // the key points at a different option
      q(3, { correct_index: 7 }), // out of range
      q(1, { explanation: "dup" }), // same stem as Q1
      q(4, { option_notes: ["only one"] }),
      q(5, { options: ["same", "same", "x", "y"], correct_answer: "same" }), // repeated options
    ];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 5 });
    const qs = stored(quiz.id);
    expect(qs.map((x) => x.question)).toEqual([q(1).question, q(4).question]);
    expect(qs[0].option_notes).not.toBeNull();
    expect(qs[1].option_notes).toBeNull();
    expect(qs[0].explanation).toBe("because 1");
  });

  it("keeps at most `size` questions", async () => {
    const w = world();
    gen.questions = () => Array.from({ length: 7 }, (_, i) => q(i + 1));
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 5 });
    expect(stored(quiz.id)).toHaveLength(5);
  });

  it("notes stay with their options after the shuffle, and the key follows the right option", async () => {
    const w = world();
    gen.questions = () => Array.from({ length: 10 }, (_, i) => q(i + 1));
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 10 });
    for (const [i, s] of stored(quiz.id).entries()) {
      expect(s.options[s.correct_index]).toBe(`right ${i + 1}`);
      s.options.forEach((o, k) => expect(s.option_notes![k]).toBe(`note for ${o}`));
    }
    // And what the browser gets after answering matches too.
    const a = answerQuizMe({ userId: w.userId, id: quiz.id, index: 0, chosen: 0 })!;
    const v = getQuizMe(w.userId, quiz.id)!.questions[0];
    v.options.forEach((o, k) => expect(a.option_notes![k]).toBe(`note for ${o}`));
    expect(v.options[a.correct_index]).toBe("right 1");
  });

  it("source slides outside the given ones become null; picture questions without any picture are dropped", async () => {
    const w = world();
    gen.questions = () => [
      q(1, { source_page_id: w.otherPages[0] }),
      q(2, { source_page_id: w.topicPages[0] }),
      q(3, { question: "In the radiograph shown, what is visible?" }), // no slide to show
    ];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 3 });
    const qs = stored(quiz.id);
    expect(qs).toHaveLength(2);
    expect(qs[0].source_page_id).toBeNull();
    expect(qs[1].source_page_id).toBe(w.topicPages[0]);
  });

  it("no usable questions is an AI failure (500, plain message), and nothing is stored", async () => {
    const w = world();
    signIn(w.userId);
    gen.questions = () => [q(1, { correct_index: 9 })];
    const res = await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("The AI didn't answer in time. Try again in a moment.");
    gen.fail = new Error("socket hang up");
    const res2 = await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }));
    expect(res2.status).toBe(500);
    expect((await res2.json()).error).toBe("The AI didn't answer in time. Try again in a moment.");
    expect((db.prepare("SELECT COUNT(*) n FROM quizme WHERE user_id = ?").get(w.userId) as { n: number }).n).toBe(0);
  });
});

describe("what the browser sees", () => {
  it("unanswered questions don't carry the key, explanation or notes (POST and GET)", async () => {
    const w = world();
    signIn(w.userId);
    const created = await (await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).json();
    const fetched = await (await quizGET(get(), ctx(created.id))).json();
    for (const body of [created, fetched]) {
      expect(body.left).toBe(3);
      expect(body.finished).toBe(false);
      expect(body.answers).toEqual([null, null, null]);
      for (const x of body.questions) {
        expect(x.correct_index).toBeUndefined();
        expect(x.explanation).toBeUndefined();
        expect(x.option_notes).toBeUndefined();
        expect(x.options).toHaveLength(4);
        expect(x.chosen).toBeNull();
      }
    }
    await answerPOST(post({ index: 1, chosen: 2 }), ctx(created.id));
    const after = await (await quizGET(get(), ctx(created.id))).json();
    expect(after.questions[1].chosen).toBe(2);
    expect(typeof after.questions[1].correct_index).toBe("number");
    expect(after.questions[1].explanation).toBe("because 2");
    expect(after.questions[0].correct_index).toBeUndefined();
    expect(after.left).toBe(2);
  });
});

describe("answers", () => {
  it("are recorded once; mastery counts the first answer only; the quiz finishes after the last one", async () => {
    const w = world();
    signIn(w.userId);
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    const key = stored(quiz.id).map((s) => s.correct_index);
    const wrong = (k: number) => (k + 1) % 4;

    const r1 = await (await answerPOST(post({ index: 0, chosen: key[0] }), ctx(quiz.id))).json();
    expect(r1).toMatchObject({ correct: true, correct_index: key[0], finished: false });
    expect(concept(w.userId)).toEqual({ attempts: 1, correct: 1 });

    const again = await (await answerPOST(post({ index: 0, chosen: wrong(key[0]) }), ctx(quiz.id))).json();
    expect(again).toMatchObject({ correct: true, correct_index: key[0], already: true });
    expect(concept(w.userId)).toEqual({ attempts: 1, correct: 1 });
    expect(getQuizMe(w.userId, quiz.id)!.answers[0]).toBe(key[0]);

    const r2 = await (await answerPOST(post({ index: 1, chosen: wrong(key[1]) }), ctx(quiz.id))).json();
    expect(r2).toMatchObject({ correct: false, correct_index: key[1], finished: false });
    expect(concept(w.userId)).toEqual({ attempts: 2, correct: 1 });
    expect((db.prepare("SELECT finished_at FROM quizme WHERE id = ?").get(quiz.id) as { finished_at: string | null }).finished_at).toBeNull();

    const r3 = await (await answerPOST(post({ index: 2, chosen: key[2] }), ctx(quiz.id))).json();
    expect(r3.finished).toBe(true);
    expect((db.prepare("SELECT finished_at FROM quizme WHERE id = ?").get(quiz.id) as { finished_at: string | null }).finished_at).not.toBeNull();
    expect(concept(w.userId)).toEqual({ attempts: 3, correct: 2 });
    expect(getQuizMe(w.userId, quiz.id)).toMatchObject({ left: 0, finished: true });
  });

  it("bad index or choice is a 400 and records nothing", async () => {
    const w = world();
    signIn(w.userId);
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    for (const body of [{ index: 3, chosen: 0 }, { index: -1, chosen: 0 }, { index: 0, chosen: 4 }, { index: 0, chosen: -1 }, { index: "0", chosen: 0 }, { index: 0 }, null]) {
      const res = await answerPOST(post(body), ctx(quiz.id));
      expect(res.status).toBe(400);
    }
    expect(getQuizMe(w.userId, quiz.id)!.answers).toEqual([null, null, null]);
    expect(concept(w.userId)?.attempts ?? 0).toBe(0);
  });

  it("a question without a concept still records the answer", async () => {
    const w = world();
    gen.questions = () => [q(1, { concept: "  " }), q(2), q(3)];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    expect(answerQuizMe({ userId: w.userId, id: quiz.id, index: 0, chosen: 0 })).not.toBeNull();
    expect(concept(w.userId)?.attempts ?? 0).toBe(0);
  });
});

describe("ownership and sign-in", () => {
  it("another user gets 404 on the quiz, its answers, open, and create with someone else's exam", async () => {
    const w = world();
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    const intruder = apiReadyUser();
    signIn(intruder);
    expect((await quizGET(get(), ctx(quiz.id))).status).toBe(404);
    expect((await answerPOST(post({ index: 0, chosen: 0 }), ctx(quiz.id))).status).toBe(404);
    expect((await openGET(get(`http://x/api/quizme/open?examId=${w.examId}`))).status).toBe(404);
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).status).toBe(404);
    expect(gen.calls).toHaveLength(1); // only the owner's
    expect(getQuizMe(w.userId, quiz.id)!.answers).toEqual([null, null, null]);
    expect(getQuizMe(intruder, quiz.id)).toBeNull();
    expect(answerQuizMe({ userId: intruder, id: quiz.id, index: 0, chosen: 0 })).toBeNull();
    // Unknown ids and garbage are 404 for the owner too.
    signIn(w.userId);
    expect((await quizGET(get(), ctx(999999))).status).toBe(404);
    expect((await openGET(get("http://x/api/quizme/open?examId=abc"))).status).toBe(404);
  });

  it("signed out is 401 everywhere", async () => {
    const w = world();
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    signIn(null);
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).status).toBe(401);
    expect((await quizGET(get(), ctx(quiz.id))).status).toBe(401);
    expect((await answerPOST(post({ index: 0, chosen: 0 }), ctx(quiz.id))).status).toBe(401);
    expect((await openGET(get(`http://x/api/quizme/open?examId=${w.examId}`))).status).toBe(401);
  });
});

describe("resume", () => {
  const finish = (userId: number, id: number) => {
    const n = stored(id).length;
    for (let i = 0; i < n; i++) answerQuizMe({ userId, id, index: i, chosen: 0 });
  };

  it("open returns the newest unfinished quiz for this exam only", async () => {
    const w = world();
    signIn(w.userId);
    const open = async (examId: number) => (await (await openGET(get(`http://x/api/quizme/open?examId=${examId}`))).json()).quiz;
    expect(await open(w.examId)).toBeNull();

    const older = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    const newer = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 5 });
    const elsewhere = await createQuizMe({ userId: w.userId, examId: w.otherExam, text: TEXT, size: 3 });
    expect((await open(w.examId)).id).toBe(newer.id);
    expect((await open(w.otherExam)).id).toBe(elsewhere.id);

    answerQuizMe({ userId: w.userId, id: newer.id, index: 0, chosen: 0 });
    const partly = await open(w.examId);
    expect(partly).toMatchObject({ id: newer.id, left: 4, size: 5 });

    finish(w.userId, newer.id);
    expect((await open(w.examId)).id).toBe(older.id);
    finish(w.userId, older.id);
    expect(await open(w.examId)).toBeNull();
    expect(openQuizMe(w.userId, w.examId)).toBeNull();
    expect((await open(w.otherExam)).id).toBe(elsewhere.id);
  });
});
