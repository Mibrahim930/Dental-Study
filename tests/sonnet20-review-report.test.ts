// Sonnet QA pass on Release 4: the lecture review and the Report button. Tests named "BUG: …" fail on purpose: each one
// pins a defect (see the comment above it for the input and the wrong output).
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

type GenOpts = { purpose: string; content: string; system: string };
const gen = vi.hoisted(() => ({
  calls: [] as GenOpts[],
  /** Question text to return for a planned slot number (1-based), instead of "Q<n> fresh?". */
  stem: {} as Record<number, string>,
  /** Slot numbers the writer leaves out the first time they are asked for (so the repair call runs). */
  drop: new Set<number>(),
  dropped: new Set<number>(),
}));
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: GenOpts) => {
    gen.calls.push(opts);
    if (opts.purpose === "section quiz") {
      const slots = [...opts.content.matchAll(/^Q(\d+): (?:slide P(\d+)|the section)/gm)].map((m) => ({ n: Number(m[1]), page: m[2] ? Number(m[2]) : 0 }));
      return {
        questions: slots
          .filter((s) => {
            if (gen.drop.has(s.n) && !gen.dropped.has(s.n)) {
              gen.dropped.add(s.n);
              return false;
            }
            return true;
          })
          .map((s) => ({
            slot: s.n,
            question: gen.stem[s.n] ?? `Q${s.n} fresh?`,
            options: ["right", "w1", "w2", "w3"],
            correct_index: 0,
            correct_answer: "right",
            explanation: "e",
            option_notes: ["r", "w", "w", "w"],
            source_page_id: s.page,
            concept: "C",
          })),
      };
    }
    if (opts.purpose === "section quiz check") return { verdicts: [] };
    throw new Error("unexpected " + opts.purpose);
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
import { db, FILES_DIR, type Topic } from "@/lib/db";
import { answerQuizMe, hideQuizMeQuestion, lectureMisses, lectureReviewStatus, openLectureReview, QuizMeError, type QuizMeQuestion } from "@/lib/quizMe";
import { clearTopicQuizAnswers, hideQuizQuestionEverywhere, recordQuizAnswer } from "@/lib/quizProgress";
import { getSectionQuiz, QUIZ_VERSION, type QuizQuestion } from "@/lib/study";
import { answerQuestion, countDue, finishAttempt, reportAttemptQuestion } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { cleanReason, listReportedQuestions, reportedStems, saveReportedQuestion } from "@/lib/reportedQuestions";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as lectureGET, POST as lecturePOST } from "@/app/api/quizme/lecture/route";
import { POST as quizmeReportPOST } from "@/app/api/quizme/[id]/report/route";
import { POST as quizReportPOST } from "@/app/api/sessions/[id]/quiz/report/route";
import { POST as attemptReportPOST } from "@/app/api/attempts/[id]/report/route";
import { POST as flagPOST } from "@/app/api/questions/[id]/flag/route";
import { GET as exportGET } from "@/app/api/admin/reported-questions/route";
import { makeUser } from "./helpers";

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const rawPost = (text: string) => new Request("http://x/api", { method: "POST", body: text });

const notes = (i: number) =>
  JSON.stringify({ title: `slide ${i}`, summary: "s", image_description: null, key_facts: [`fact ${i}`], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

function apiReadyUser(admin = false): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc', must_change_password = 0, is_admin = ? WHERE id = ?").run(admin ? 1 : 0, id);
  return id;
}
function signIn(userId: number | null) {
  if (userId == null) return void (jar.cookie = undefined);
  const { session_epoch } = db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(userId) as { session_epoch: number };
  jar.cookie = sessionToken(userId, session_epoch);
}

const quizQs = (prefix: string, n: number): QuizQuestion[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    question: `${prefix} question ${i}?`,
    options: ["right", "w1", "w2", "w3"],
    correct_index: 0,
    explanation: `because ${i}`,
    option_notes: ["r", "w", "w", "w"],
    concept: "C",
    kind: "recall" as const,
  }));

/** One exam, two lectures: lecture 1 has sections t1 (a0-a2) and t2 (b0-b2); lecture 2 has t3 (c0-c1). Plus a study session. */
function world(userId = apiReadyUser()) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, topic_status) VALUES (?, 'Endo', 'ready')").run(userId).lastInsertRowid);
  const mkDoc = (name: string) => Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, 'done', 2)").run(examId, name).lastInsertRowid);
  const doc1 = mkDoc("Lecture 1 - Pulp.pdf");
  const doc2 = mkDoc("Lecture 2 - Perio.pdf");
  let n = 0;
  const page = (doc: number) => {
    n++;
    return Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(doc, n, notes(n)).lastInsertRowid);
  };
  const topic = (doc: number, pos: number, title: string, qs: QuizQuestion[]) =>
    Number(
      db
        .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id, checks_json, checks_version) VALUES (?, ?, ?, 's', ?, ?, ?, ?)")
        .run(examId, pos, title, JSON.stringify([page(doc), page(doc)]), doc, JSON.stringify(qs), QUIZ_VERSION).lastInsertRowid,
    );
  const t1 = topic(doc1, 0, "Pulp anatomy", quizQs("a", 3));
  const t2 = topic(doc1, 1, "Pulp disease", quizQs("b", 3));
  const t3 = topic(doc2, 2, "Perio basics", quizQs("c", 2));
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topicRow = (id: number) => db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
  return { userId, examId, doc1, doc2, t1, t2, t3, sessionId, topicRow };
}
type World = ReturnType<typeof world>;

const checksOf = (topicId: number) => JSON.parse((db.prepare("SELECT checks_json FROM topics WHERE id = ?").get(topicId) as { checks_json: string }).checks_json) as QuizQuestion[];
const setChecks = (topicId: number, qs: unknown) => void db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(qs == null ? null : JSON.stringify(qs), topicId);
const hiddenOf = (topicId: number) => checksOf(topicId).map((q) => !!q.hidden);

function quizMeOn(userId: number, examId: number, topicId: number, answers: (number | null)[], prefix = "qm") {
  const qs: QuizMeQuestion[] = answers.map((_, i) => ({
    question: `${prefix} highlight question ${i}?`,
    options: ["right", "w1", "w2", "w3"],
    correct_index: 0,
    explanation: "e",
    option_notes: null,
    concept: "C",
    source_page_id: null,
    image_page_id: null,
  }));
  return Number(
    db
      .prepare("INSERT INTO quizme (user_id, exam_id, topic_id, text, size, questions_json, answers_json) VALUES (?, ?, ?, 'txt', ?, ?, ?)")
      .run(userId, examId, topicId, qs.length, JSON.stringify(qs), JSON.stringify(answers)).lastInsertRowid,
  );
}
const quizMeQs = (id: number) => JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
const setQuizMeQs = (id: number, qs: QuizMeQuestion[]) => void db.prepare("UPDATE quizme SET questions_json = ? WHERE id = ?").run(JSON.stringify(qs), id);
const quizMeRow = (id: number) => db.prepare("SELECT * FROM quizme WHERE id = ?").get(id) as { finished_at: string | null; answers_json: string };
const refsOf = (userId: number, examId: number, doc: number) => lectureMisses(userId, examId, doc).map((m) => m.ref);
const rightIdx = (id: number, i: number) => quizMeQs(id)[i].options.indexOf("right");
const wrongIdx = (id: number, i: number) => quizMeQs(id)[i].options.indexOf("w1");

/** `mate` joins a new class of `owner`'s and adds `examId` from it: returns mate's copy of the exam. */
function copyOf(owner: number, examId: number, mate: number): number {
  const cls = createClass(owner, `Class ${Math.random()}`);
  joinClass(mate, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(cls) as { invite_code: string }).invite_code);
  expect(shareExam(owner, cls, examId)).toBeNull();
  const sid = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ? AND class_id = ?").get(examId, cls) as { id: number }).id;
  return (addSharedExam(mate, sid) as { examId: number }).examId;
}
const topicAt = (examId: number, position: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? AND position = ?").get(examId, position) as Topic;

/** An attempt of `n` practice questions on t1 (stems "P<k>-<i>?"), all unanswered. */
let attemptNo = 0;
function attemptWith(w: World, n: number, status: "ready" | "finished" = "ready") {
  const k = ++attemptNo;
  const qIds = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', ?, ?, 0, 'e')")
        .run(w.examId, w.t1, `P${k}-${i}?`, JSON.stringify(["right", "w1", "w2", "w3"])).lastInsertRowid,
    ),
  );
  const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', ?)").run(w.examId, status).lastInsertRowid);
  qIds.forEach((q, i) => db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)").run(attemptId, q, i));
  return { attemptId, qIds };
}
const scoreOf = (attemptId: number) => (db.prepare("SELECT score FROM attempts WHERE id = ?").get(attemptId) as { score: number | null }).score;

let errorLog = vi.spyOn(console, "error");

beforeEach(() => {
  errorLog.mockRestore();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  gen.calls.length = 0;
  gen.stem = {};
  gen.drop.clear();
  gen.dropped.clear();
  signIn(null);
});

// ---------------------------------------------------------------------------------------------------------------
describe("lectureMisses: odd data", () => {
  it("a section with no stored quiz (checks_json null) and stray quiz_answers rows for it: skipped, the rest still listed", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t2, 1, 1, false);
    setChecks(w.t1, null);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t2}:1`]);
  });

  it("an answer whose check_index is beyond the quiz (or negative) is skipped, not a crash", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t3, 5, 1, false);
    recordQuizAnswer(w.userId, w.t3, -1, 1, false);
    recordQuizAnswer(w.userId, w.t3, 1, 1, false);
    expect(refsOf(w.userId, w.examId, w.doc2)).toEqual([`quiz:${w.t3}:1`]);
  });

  it("a stored 'quiz me' row with a short, sparse or odd answers array is read leniently", () => {
    const w = world();
    const id = quizMeOn(w.userId, w.examId, w.t1, [1, 1, 1, 1]);
    for (const json of ["[1]", '{"0":1}', '"abc"', "42", "[null,1.5,\"x\",1]"]) {
      db.prepare("UPDATE quizme SET answers_json = ? WHERE id = ?").run(json, id);
      expect(() => lectureMisses(w.userId, w.examId, w.doc1), json).not.toThrow();
    }
    db.prepare("UPDATE quizme SET answers_json = '[1]' WHERE id = ?").run(id);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quizme:${id}:0`]);
  });

  // parse() in quizMe.ts (JSON.parse(row.answers_json); stored[i]) throws SyntaxError on "{bad" and TypeError on "null".
  // lectureMisses loops over EVERY highlight quiz of the lecture, so one such row makes the lecture's status route
  // (GET /api/quizme/lecture) and its review button a 500 for good, hiding the misses that are fine.
  it("fixed: one corrupt answers_json row (invalid JSON / the JSON null) breaks the whole lecture's misses instead of being skipped", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const id = quizMeOn(w.userId, w.examId, w.t2, [1]);
    for (const json of ["{bad", "null"]) {
      db.prepare("UPDATE quizme SET answers_json = ? WHERE id = ?").run(json, id);
      expect(refsOf(w.userId, w.examId, w.doc1), json).toEqual([`quiz:${w.t1}:0`]);
    }
  });

  it("a lecture with no sections: no misses, status 0, nothing to open", () => {
    const w = world();
    const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, 'Empty.pdf', 'done', 0)").run(w.examId).lastInsertRowid);
    expect(lectureMisses(w.userId, w.examId, docId)).toEqual([]);
    expect(lectureReviewStatus(w.userId, w.examId, docId)).toEqual({ missed: 0, open: null });
    expect(() => openLectureReview(w.userId, w.examId, docId)).toThrow(QuizMeError);
    // old-style sections (document_id null) belong to no lecture
    db.prepare("UPDATE topics SET document_id = NULL WHERE id = ?").run(w.t3);
    recordQuizAnswer(w.userId, w.t3, 0, 1, false);
    expect(lectureMisses(w.userId, w.examId, w.doc2)).toEqual([]);
  });

  it("another student's exam: no misses, no status, nothing to open (404 on the route); her own copy starts with none", async () => {
    const owner = apiReadyUser();
    const w = world(owner);
    recordQuizAnswer(owner, w.t1, 0, 1, false);
    quizMeOn(owner, w.examId, w.t2, [2]);
    const other = apiReadyUser();
    expect(lectureMisses(other, w.examId, w.doc1)).toEqual([]);
    expect(lectureReviewStatus(other, w.examId, w.doc1)).toEqual({ missed: 0, open: null });
    expect(() => openLectureReview(other, w.examId, w.doc1)).toThrow(/wasn't found/);
    signIn(other);
    expect((await lectureGET(new Request(`http://x/api?examId=${w.examId}&documentId=${w.doc1}`))).status).toBe(404);
    const mine = copyOf(owner, w.examId, other);
    const mineDoc = (db.prepare("SELECT id FROM documents WHERE exam_id = ? ORDER BY id").get(mine) as { id: number }).id;
    expect(lectureMisses(other, mine, mineDoc)).toEqual([]);
    expect(lectureMisses(owner, w.examId, w.doc1)).toHaveLength(2);
  });

  it("boundary: a miss is retired when done_at >= created_at (equal and later), back when the review was earlier", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const ref = `quiz:${w.t1}:0`;
    db.prepare("UPDATE quiz_answers SET created_at = '2026-01-01 10:00:00' WHERE user_id = ?").run(w.userId);
    const done = (at: string) => db.prepare("INSERT OR REPLACE INTO lecture_review_done (user_id, ref, done_at) VALUES (?, ?, ?)").run(w.userId, ref, at);
    done("2026-01-01 10:00:00");
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    done("2026-01-01 10:00:01");
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    done("2026-01-01 09:59:59");
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([ref]);
  });

  it("two lectures sharing a question's text: each lecture lists its own; retiring one leaves the other", () => {
    const w = world();
    const qs = checksOf(w.t3);
    qs[0].question = "a question 0?";
    setChecks(w.t3, qs);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t3, 0, 1, false);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t1}:0`]);
    expect(refsOf(w.userId, w.examId, w.doc2)).toEqual([`quiz:${w.t3}:0`]);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: rightIdx(v.id, 0) });
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    expect(refsOf(w.userId, w.examId, w.doc2)).toEqual([`quiz:${w.t3}:0`]);
  });

  it("the same question missed in a section quiz AND a quiz me: listed once, with the section quiz's ref; case and punctuation don't make it two", () => {
    const w = world();
    const id = quizMeOn(w.userId, w.examId, w.t1, [1, 1]);
    const qs = quizMeQs(id);
    qs[0].question = "A   QUESTION 0 ??";
    setQuizMeQs(id, qs);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t1}:0`, `quizme:${id}:1`]);
  });

  // lectureMisses: `add` checks lecture_review_done by ref only, then dedupes by text. With a question missed in the section
  // quiz (ref quiz:T:0) and the same text missed in a quiz me (ref quizme:ID:0), a right answer in the review retires only
  // the section-quiz ref; the quiz-me copy of the very same question is the next "first" with that text and comes back.
  it("fixed: a question she got right in the review comes back in the next one when the same text was also missed in a quiz me", () => {
    const w = world();
    const id = quizMeOn(w.userId, w.examId, w.t1, [1]);
    const qs = quizMeQs(id);
    qs[0].question = "a question 0?";
    setQuizMeQs(id, qs);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    expect(v.questions).toHaveLength(1);
    answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: rightIdx(v.id, 0) });
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
  });

  // Same cause, with Report: reporting the review question hides it in the section quiz only (hideAtSource), the quiz-me copy
  // with the same text is still a wrong answer and is listed again, so a reported question returns as a miss.
  it("fixed: a reported lecture-review question returns as a miss when the same text was also missed in a quiz me", () => {
    const w = world();
    const id = quizMeOn(w.userId, w.examId, w.t1, [1]);
    const qs = quizMeQs(id);
    qs[0].question = "a question 0?";
    setQuizMeQs(id, qs);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    hideQuizMeQuestion(w.userId, v.id, 0, "bad");
    expect(hiddenOf(w.t1)[0]).toBe(true);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("openLectureReview", () => {
  it("a document of another exam of the same student is 'not found' (library and route), and has no misses/status", async () => {
    const u = apiReadyUser();
    const a = world(u);
    const b = world(u);
    recordQuizAnswer(u, b.t1, 0, 1, false);
    expect(lectureMisses(u, a.examId, b.doc1)).toEqual([]);
    expect(lectureReviewStatus(u, a.examId, b.doc1)).toEqual({ missed: 0, open: null });
    expect(() => openLectureReview(u, a.examId, b.doc1)).toThrow(/wasn't found/);
    expect(() => openLectureReview(u, a.examId, 987654)).toThrow(QuizMeError);
    signIn(u);
    expect((await lecturePOST(post({ examId: a.examId, documentId: b.doc1 }))).status).toBe(400);
    expect((await lecturePOST(post({ examId: b.examId, documentId: b.doc1 }))).status).toBe(200);
    expect((await lecturePOST(post({ examId: "1", documentId: 1 }))).status).toBe(400);
    expect((await lecturePOST(post({ examId: 1.5, documentId: 1 }))).status).toBe(400);
    expect((await lecturePOST(rawPost("not json"))).status).toBe(400);
    expect((await lectureGET(new Request("http://x/api"))).status).toBe(404);
    expect((await lectureGET(new Request(`http://x/api?examId=${a.examId}&documentId=${b.doc1}`))).status).toBe(200);
  });

  it("retaking the section quiz (answers deleted) leaves an open review working: same quiz, refs intact, a right answer still retires the ref", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 2, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    db.prepare("DELETE FROM quiz_answers WHERE user_id = ? AND topic_id = ?").run(w.userId, w.t1);
    expect(lectureMisses(w.userId, w.examId, w.doc1)).toEqual([]);
    const again = openLectureReview(w.userId, w.examId, w.doc1);
    expect(again.id).toBe(v.id);
    expect(again.questions).toHaveLength(2);
    // the status counts what is left in the open review, not the (now empty) miss list
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toMatchObject({ missed: 2, open: { id: v.id } });
    expect(quizMeQs(v.id).map((q) => q.ref)).toEqual([`quiz:${w.t1}:0`, `quiz:${w.t1}:2`]);
    answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: rightIdx(v.id, 0) });
    expect(db.prepare("SELECT ref FROM lecture_review_done WHERE user_id = ?").all(w.userId)).toEqual([{ ref: `quiz:${w.t1}:0` }]);
    // after she finishes it there is nothing left and no open review
    answerQuizMe({ userId: w.userId, id: v.id, index: 1, chosen: rightIdx(v.id, 1) });
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toEqual({ missed: 0, open: null });
  });

  it("the review's own answers count toward concept mastery (right and wrong), like a quiz me; section-quiz bookkeeping does not", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 1, 1, false);
    const conceptRow = () => db.prepare("SELECT attempts, correct FROM concepts WHERE user_id = ? AND name = 'C'").get(w.userId) as { attempts: number; correct: number } | undefined;
    expect(conceptRow()).toBeUndefined();
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    expect(conceptRow()).toBeUndefined(); // opening costs nothing
    answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: rightIdx(v.id, 0) });
    answerQuizMe({ userId: w.userId, id: v.id, index: 1, chosen: wrongIdx(v.id, 1) });
    // a second answer to the same question changes nothing
    answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: wrongIdx(v.id, 0) });
    expect(conceptRow()).toEqual({ attempts: 2, correct: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM lecture_review_done WHERE user_id = ?").get(w.userId)).toEqual({ n: 1 });
  });

  it("a review does not appear as a 'quiz me' to resume, and a quiz me does not appear as a review", async () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    const { openQuizMe } = await import("@/lib/quizMe");
    expect(openQuizMe(w.userId, w.examId)).toBeNull();
    const hl = quizMeOn(w.userId, w.examId, w.t1, [null]);
    expect(openQuizMe(w.userId, w.examId)?.id).toBe(hl);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1).open?.id).toBe(v.id);
  });

  it("reporting the last question: finished_at is set only when something was answered; otherwise status closes the review lazily (missed 0, open null)", () => {
    // (a) nothing answered, both reported
    const a = world();
    recordQuizAnswer(a.userId, a.t1, 0, 1, false);
    recordQuizAnswer(a.userId, a.t1, 1, 1, false);
    const va = openLectureReview(a.userId, a.examId, a.doc1);
    hideQuizMeQuestion(a.userId, va.id, 0);
    expect(hideQuizMeQuestion(a.userId, va.id, 1)).not.toBeNull();
    expect(quizMeRow(va.id).finished_at).toBeNull(); // not stamped: nothing was answered
    expect(lectureReviewStatus(a.userId, a.examId, a.doc1)).toEqual({ missed: 0, open: null });
    expect(quizMeRow(va.id).finished_at).not.toBeNull(); // closed by the status call
    expect(() => openLectureReview(a.userId, a.examId, a.doc1)).toThrow(QuizMeError);
    // (b) one answered right, the other reported: stamped at once
    const b = world();
    recordQuizAnswer(b.userId, b.t1, 0, 1, false);
    recordQuizAnswer(b.userId, b.t1, 1, 1, false);
    const vb = openLectureReview(b.userId, b.examId, b.doc1);
    answerQuizMe({ userId: b.userId, id: vb.id, index: 0, chosen: rightIdx(vb.id, 0) });
    hideQuizMeQuestion(b.userId, vb.id, 1);
    expect(quizMeRow(vb.id).finished_at).not.toBeNull();
    expect(lectureReviewStatus(b.userId, b.examId, b.doc1)).toEqual({ missed: 0, open: null });
    // (c) one answered WRONG, the other reported: finished, and the wrong one is the one miss left for the next review
    const c = world();
    recordQuizAnswer(c.userId, c.t1, 0, 1, false);
    recordQuizAnswer(c.userId, c.t1, 1, 1, false);
    const vc = openLectureReview(c.userId, c.examId, c.doc1);
    const wrongRef = quizMeQs(vc.id)[0].ref!;
    answerQuizMe({ userId: c.userId, id: vc.id, index: 0, chosen: wrongIdx(vc.id, 0) });
    hideQuizMeQuestion(c.userId, vc.id, 1);
    expect(quizMeRow(vc.id).finished_at).not.toBeNull();
    expect(lectureReviewStatus(c.userId, c.examId, c.doc1)).toEqual({ missed: 1, open: null });
    expect(refsOf(c.userId, c.examId, c.doc1)).toEqual([wrongRef]);
  });

  it("an open review plus new misses: status.missed is the open review's questions left (not the new misses); once it is done the new misses show", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    recordQuizAnswer(w.userId, w.t2, 0, 1, false);
    recordQuizAnswer(w.userId, w.t2, 1, 1, false);
    // documented behaviour: 1 (the open review), not 3
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toMatchObject({ missed: 1, open: { id: v.id } });
    expect(openLectureReview(w.userId, w.examId, w.doc1).questions).toHaveLength(1); // the new misses are not added to it
    answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: rightIdx(v.id, 0) });
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toEqual({ missed: 2, open: null });
  });

  it("the review keeps the options and notes together (every question: key still on 'right', notes follow their option)", () => {
    const w = world();
    for (let i = 0; i < 3; i++) recordQuizAnswer(w.userId, w.t1, i, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    for (const q of quizMeQs(v.id)) {
      expect(q.options[q.correct_index]).toBe("right");
      expect(q.option_notes![q.correct_index]).toBe("r");
      expect([...q.options].sort()).toEqual(["right", "w1", "w2", "w3"]);
    }
  });

  // hideAtSource() finds the source question by INDEX in the topic's CURRENT checks_json. A ref made from a quiz that has since
  // been replaced ("Write new questions" clears quiz_answers and swaps checks_json) points at a different question.
  // Input: miss quiz:T:0, open the review, regenerate T's quiz, report the review question.
  // Wrong output: the NEW quiz's question 0 (which she never saw in a review) is hidden everywhere (all copies).
  it("fixed: reporting a review question after its section's quiz was rewritten hides an unrelated question at that index", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    setChecks(w.t1, quizQs("n", 3)); // the rewritten quiz
    clearTopicQuizAnswers(w.t1);
    hideQuizMeQuestion(w.userId, v.id, 0, "bad");
    expect(hiddenOf(w.t1)).toEqual([false, false, false]);
  });

  // Reporting a section-quiz question marks it hidden in the quiz (and copies), but an already-open lecture review made
  // from that miss is a stored copy: it keeps showing, and lets her answer, the question she reported.
  it("fixed: a question reported in the section quiz still shows (and can be answered) in an already-open lecture review", async () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 1, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    signIn(w.userId);
    expect((await quizReportPOST(post({ topicId: w.t1, questionId: "a0", reason: "wrong" }), ctx(w.sessionId))).status).toBe(200);
    const now = lectureReviewStatus(w.userId, w.examId, w.doc1).open!;
    expect(now.id).toBe(v.id);
    const shown = now.questions.filter((q) => !q.hidden).map((q) => q.question);
    expect(shown).not.toContain("a question 0?");
    expect(now.left).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("hideQuizQuestionEverywhere", () => {
  it("copies of the same original (siblings) are all reached from any of them", () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const b = copyOf(owner, w.examId, apiReadyUser());
    const c = copyOf(owner, w.examId, apiReadyUser());
    expect(hideQuizQuestionEverywhere(topicAt(b, 0).id, "a1", "r")).toBe(3);
    for (const t of [w.t1, topicAt(b, 0).id, topicAt(c, 0).id]) expect(hiddenOf(t)).toEqual([false, true, false]);
    // other sections untouched
    expect(hiddenOf(w.t2)).toEqual([false, false, false]);
  });

  // copyExam sets source_exam_id = the shared exam's own id, so a copy of a copy points at the middle copy, not the root.
  // hideQuizQuestionEverywhere uses root = source_exam_id ?? id, so a report in the original reaches the middle copy but not
  // the copy of the copy, and a report in the copy of the copy reaches only the middle copy: the original keeps the question.
  it("fixed: a report in the original misses the copy of a copy", () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const b = copyOf(owner, w.examId, apiReadyUser());
    const bOwner = (db.prepare("SELECT user_id FROM exams WHERE id = ?").get(b) as { user_id: number }).user_id;
    const c = copyOf(bOwner, b, apiReadyUser());
    hideQuizQuestionEverywhere(w.t1, "a1", null);
    expect([hiddenOf(w.t1)[1], hiddenOf(topicAt(b, 0).id)[1], hiddenOf(topicAt(c, 0).id)[1]]).toEqual([true, true, true]);
  });

  it("fixed: a report in a copy of a copy misses the original", () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const b = copyOf(owner, w.examId, apiReadyUser());
    const bOwner = (db.prepare("SELECT user_id FROM exams WHERE id = ?").get(b) as { user_id: number }).user_id;
    const c = copyOf(bOwner, b, apiReadyUser());
    hideQuizQuestionEverywhere(topicAt(c, 0).id, "a1", null);
    expect([hiddenOf(w.t1)[1], hiddenOf(topicAt(b, 0).id)[1], hiddenOf(topicAt(c, 0).id)[1]]).toEqual([true, true, true]);
  });

  // copyExam strips hidden/report_note from the quiz it copies ("the classmate starts clean" was written when a report only
  // hid the question in the reporter's own copy). Reports now hide the question in every copy, so a copy made AFTER a report
  // brings the reported question back. (Practice questions are different: copyExam skips flagged ones.)
  it("fixed: a classmate who adds the exam after a question was reported gets that question back, visible", () => {
    const owner = apiReadyUser();
    const w = world(owner);
    hideQuizQuestionEverywhere(w.t1, "a1", "nonsense");
    expect(hiddenOf(w.t1)).toEqual([false, true, false]);
    const late = copyOf(owner, w.examId, apiReadyUser());
    expect(hiddenOf(topicAt(late, 0).id)).toEqual([false, true, false]);
  });

  it("a copy whose section has no stored quiz is skipped, the others still hidden; an unknown id or topic changes nothing", () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const b = copyOf(owner, w.examId, apiReadyUser());
    const c = copyOf(owner, w.examId, apiReadyUser());
    setChecks(topicAt(b, 0).id, null);
    expect(hideQuizQuestionEverywhere(w.t1, "a2", null)).toBe(2);
    expect(hiddenOf(topicAt(c, 0).id)).toEqual([false, false, true]);
    expect((db.prepare("SELECT checks_json FROM topics WHERE id = ?").get(topicAt(b, 0).id) as { checks_json: string | null }).checks_json).toBeNull();
    expect(hideQuizQuestionEverywhere(w.t1, "nope", null)).toBe(0);
    expect(hideQuizQuestionEverywhere(987654, "a0", null)).toBe(0);
  });

  it("a question id that exists only in the copy (the copy's quiz was rewritten): hidden there only; the route accepts it from the copy's own session", async () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const mate = apiReadyUser();
    const b = copyOf(owner, w.examId, mate);
    const tb = topicAt(b, 0);
    const qs = JSON.parse(tb.checks_json!) as QuizQuestion[];
    qs[0].id = "only-here";
    setChecks(tb.id, qs);
    const sid = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(b).lastInsertRowid);
    signIn(mate);
    expect((await quizReportPOST(post({ topicId: tb.id, questionId: "only-here", reason: "r" }), ctx(sid))).status).toBe(200);
    expect(hiddenOf(tb.id)).toEqual([true, false, false]);
    expect(hiddenOf(w.t1)).toEqual([false, false, false]);
    // and the owner's id "a0" exists in the owner's quiz only: the mate cannot report it in his topic
    expect((await quizReportPOST(post({ topicId: tb.id, questionId: "a0" }), ctx(sid))).status).toBe(400);
  });

  it("the note of the first report is kept; a later report of an already hidden question changes nothing", () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const b = copyOf(owner, w.examId, apiReadyUser());
    expect(hideQuizQuestionEverywhere(w.t1, "a0", "first")).toBe(2);
    expect(hideQuizQuestionEverywhere(topicAt(b, 0).id, "a0", "second")).toBe(0);
    expect(checksOf(w.t1)[0].report_note).toBe("first");
    expect(checksOf(topicAt(b, 0).id)[0].report_note).toBe("first");
  });

  // POST /quiz/report finds the question by id and, hidden or not, saves a record: a double submit (two taps, two tabs) or a
  // resend writes a second reported_questions row and file for the same question. The other three report routes refuse the
  // second report (404 / 400).
  it("fixed: reporting the same section-quiz question twice records it twice", async () => {
    const w = world();
    signIn(w.userId);
    expect((await quizReportPOST(post({ topicId: w.t2, questionId: "b1", reason: "x" }), ctx(w.sessionId))).status).toBe(200);
    const second = await quizReportPOST(post({ topicId: w.t2, questionId: "b1", reason: "x again" }), ctx(w.sessionId));
    const rows = listReportedQuestions().filter((r) => r.ref === `quiz:${w.t2}:b1`);
    expect(second.status).toBeGreaterThanOrEqual(200);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("reportAttemptQuestion", () => {
  it("all 15 reported: score 0 (no division by zero), empty view, in an unfinished exam and a finished one", async () => {
    const w = world();
    const live = attemptWith(w, 15);
    live.qIds.slice(0, 5).forEach((q) => answerQuestion(live.attemptId, q, 0));
    live.qIds.forEach((q) => expect(reportAttemptQuestion(w.userId, live.attemptId, q, null)).toBe(true));
    expect(attemptView(live.attemptId)!.questions).toEqual([]);
    finishAttempt(live.attemptId);
    expect(scoreOf(live.attemptId)).toBe(0);

    const done = attemptWith(w, 15);
    done.qIds.slice(0, 10).forEach((q) => answerQuestion(done.attemptId, q, 0));
    finishAttempt(done.attemptId);
    expect(scoreOf(done.attemptId)).toBeCloseTo(10 / 15, 6);
    signIn(w.userId);
    let last: Response | null = null;
    for (const q of done.qIds) last = await attemptReportPOST(post({ questionId: q }), ctx(done.attemptId));
    expect(last!.status).toBe(200);
    const view = (await last!.json()) as { questions: unknown[]; attempt: { score: number } };
    expect(view.questions).toEqual([]);
    expect(view.attempt.score).toBe(0);
    expect(Number.isNaN(scoreOf(done.attemptId))).toBe(false);
    expect(scoreOf(done.attemptId)).toBe(0);
  });

  it("answered vs unanswered: the answered row keeps its answer (history) but leaves the score; a wrong one no longer comes back in the daily review", () => {
    const w = world();
    const { attemptId, qIds } = attemptWith(w, 4);
    answerQuestion(attemptId, qIds[0], 0); // right
    answerQuestion(attemptId, qIds[1], 1); // wrong -> review card
    answerQuestion(attemptId, qIds[2], 1); // wrong
    db.prepare("UPDATE review_cards SET due = '2000-01-01T00:00:00.000Z'").run();
    const dueBefore = countDue(w.userId);
    expect(dueBefore).toBe(2);
    expect(reportAttemptQuestion(w.userId, attemptId, qIds[1], "bad")).toBe(true); // answered
    expect(reportAttemptQuestion(w.userId, attemptId, qIds[3], "bad")).toBe(true); // unanswered
    expect(countDue(w.userId)).toBe(1);
    expect(db.prepare("SELECT chosen_index, correct, reported FROM attempt_questions WHERE attempt_id = ? AND question_id = ?").get(attemptId, qIds[1])).toEqual({ chosen_index: 1, correct: 0, reported: 1 });
    finishAttempt(attemptId);
    expect(scoreOf(attemptId)).toBeCloseTo(1 / 2, 6); // q0 right, q2 wrong
  });

  it("a question in two exams: reported in one, the other exam still shows it and scores it; the question is flagged for every new exam", () => {
    const w = world();
    const first = attemptWith(w, 3);
    const second = attemptWith(w, 3);
    const shared = first.qIds[0];
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 3)").run(second.attemptId, shared);
    answerQuestion(second.attemptId, shared, 0);
    answerQuestion(second.attemptId, second.qIds[0], 1);
    expect(reportAttemptQuestion(w.userId, first.attemptId, shared, "r")).toBe(true);
    expect(attemptView(first.attemptId)!.questions.map((q) => q.id)).not.toContain(shared);
    const other = attemptView(second.attemptId)!;
    expect(other.questions.map((q) => q.id)).toContain(shared);
    expect(other.questions.find((q) => q.id === shared)!.flagged).toBe(true);
    finishAttempt(second.attemptId);
    expect(scoreOf(second.attemptId)).toBeCloseTo(1 / 4, 6);
    expect((db.prepare("SELECT flagged FROM questions WHERE id = ?").get(shared) as { flagged: number }).flagged).toBe(1);
    // reporting it in the second exam too is allowed (its own row) and then it leaves that score
    expect(reportAttemptQuestion(w.userId, second.attemptId, shared, null)).toBe(true);
    expect(scoreOf(second.attemptId)).toBe(0);
  });

  it("positions of the remaining questions are untouched (no renumbering); case numbering follows what is shown", () => {
    const w = world();
    const { attemptId, qIds } = attemptWith(w, 6);
    expect(reportAttemptQuestion(w.userId, attemptId, qIds[2], null)).toBe(true);
    expect(reportAttemptQuestion(w.userId, attemptId, qIds[3], null)).toBe(true);
    expect(attemptView(attemptId)!.questions.map((q) => q.position)).toEqual([0, 1, 4, 5]);
    // a case of 3 questions: report the middle one -> "question 1 of 2", "question 2 of 2"
    const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box) VALUES (?, 'A patient', '{}')").run(w.examId).lastInsertRowid);
    const cq = [0, 1, 2].map((i) => {
      const q = Number(
        db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, case_id) VALUES (?, ?, 'case', ?, ?, 0, 'e', ?)").run(w.examId, w.t1, `Case q${i}?`, JSON.stringify(["right", "w1", "w2", "w3"]), caseId).lastInsertRowid,
      );
      db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)").run(attemptId, q, 6 + i);
      return q;
    });
    reportAttemptQuestion(w.userId, attemptId, cq[1], null);
    const shown = attemptView(attemptId)!.questions.filter((q) => q.caseInfo);
    expect(shown.map((q) => [q.caseInfo!.number, q.caseInfo!.index, q.caseInfo!.size])).toEqual([
      [1, 1, 2],
      [1, 2, 2],
    ]);
    expect(shown.map((q) => q.position)).toEqual([6, 8]);
  });

  it("finishing after reports, answering a reported question and reporting twice: ignored / false", () => {
    const w = world();
    const { attemptId, qIds } = attemptWith(w, 3);
    expect(reportAttemptQuestion(w.userId, attemptId, qIds[0], null)).toBe(true);
    expect(reportAttemptQuestion(w.userId, attemptId, qIds[0], null)).toBe(false);
    answerQuestion(attemptId, qIds[0], 0);
    answerQuestion(attemptId, qIds[1], 0);
    answerQuestion(attemptId, qIds[2], 1);
    finishAttempt(attemptId);
    expect(scoreOf(attemptId)).toBeCloseTo(1 / 2, 6);
    expect(db.prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ? AND question_id = ?").get(attemptId, qIds[0])).toEqual({ chosen_index: null });
    // a question that belongs to no exam of hers / to another attempt
    expect(reportAttemptQuestion(w.userId, attemptId, 99999999, null)).toBe(false);
  });

  it("reporting records the right exam, topic and slide origin, and keeps the first flag note when another student reports the same root question", () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const { attemptId, qIds } = attemptWith(w, 1);
    const b = copyOf(owner, w.examId, apiReadyUser());
    void b;
    reportAttemptQuestion(owner, attemptId, qIds[0], "owner says");
    const rec = listReportedQuestions().find((r) => r.ref === `question:${qIds[0]}`)!;
    expect(rec).toMatchObject({ source: "practice", exam_id: w.examId, topic_id: w.t1, reason: "owner says" });
    expect(rec.question.exam).toBe("Endo");
    expect((db.prepare("SELECT flag_note FROM questions WHERE id = ?").get(qIds[0]) as { flag_note: string }).flag_note).toBe("owner says");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("report routes", () => {
  it("signed out: 401 on the four report routes, 404 on the admin export", async () => {
    const w = world();
    const { attemptId, qIds } = attemptWith(w, 1);
    const v = (recordQuizAnswer(w.userId, w.t1, 0, 1, false), openLectureReview(w.userId, w.examId, w.doc1));
    signIn(null);
    expect((await quizmeReportPOST(post({ index: 0 }), ctx(v.id))).status).toBe(401);
    expect((await attemptReportPOST(post({ questionId: qIds[0] }), ctx(attemptId))).status).toBe(401);
    expect((await quizReportPOST(post({ topicId: w.t1, questionId: "a0" }), ctx(w.sessionId))).status).toBe(401);
    expect((await flagPOST(post({}), ctx(qIds[0]))).status).toBe(401);
    expect((await exportGET()).status).toBe(404);
    expect((db.prepare("SELECT reported FROM attempt_questions WHERE attempt_id = ?").get(attemptId) as { reported: number }).reported).toBe(0);
  });

  it("bad ids and bodies: 400 for a malformed body, 404 for something that isn't hers", async () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 1, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    const { attemptId, qIds } = attemptWith(w, 2);
    signIn(w.userId);
    for (const body of [rawPost("nope"), post(null), post({}), post({ index: "0" }), post({ index: 1.5 }), post({ index: null })]) {
      expect((await quizmeReportPOST(body, ctx(v.id))).status).toBe(400);
    }
    for (const index of [-1, 2, 99]) expect((await quizmeReportPOST(post({ index }), ctx(v.id))).status).toBe(404);
    expect((await quizmeReportPOST(post({ index: 0 }), { params: Promise.resolve({ id: "abc" }) } as never)).status).toBe(404);
    for (const body of [rawPost("nope"), post(null), post({}), post({ questionId: String(qIds[0]) }), post({ questionId: null }), post({ questionId: 1.5 }), post({ questionId: -3 }), post({ questionId: [qIds[0]] })]) {
      expect((await attemptReportPOST(body, ctx(attemptId))).status).toBe(400);
    }
    expect((await attemptReportPOST(post({ questionId: qIds[0] }), { params: Promise.resolve({ id: "x" }) } as never)).status).toBe(404);
    for (const body of [rawPost("nope"), post(null), post({}), post({ topicId: "1", questionId: "a0" }), post({ topicId: w.t1, questionId: 5 }), post({ topicId: w.t1, questionId: "" }), post({ topicId: 1.5, questionId: "a0" })]) {
      expect((await quizReportPOST(body, ctx(w.sessionId))).status).toBe(400);
    }
    // a topic of her other exam / another student's topic through her own session: unknown question
    const other = world(w.userId);
    expect((await quizReportPOST(post({ topicId: other.t1, questionId: "a0" }), ctx(w.sessionId))).status).toBe(400);
    expect(hiddenOf(other.t1)).toEqual([false, false, false]);
    expect((await quizReportPOST(post({ topicId: w.t1, questionId: "a0" }), ctx(other.sessionId))).status).toBe(400);
    expect((await quizReportPOST(post({ topicId: w.t1, questionId: "a0" }), ctx(987654))).status).toBe(404);
    // flag route
    expect((await flagPOST(post({}), ctx(987654))).status).toBe(404);
    expect((await flagPOST(post({}), { params: Promise.resolve({ id: "x" }) } as never)).status).toBe(404);
    expect((await flagPOST(rawPost("garbage"), ctx(qIds[1]))).status).toBe(200); // no body is fine: no reason
    expect(listReportedQuestions().find((r) => r.ref === `question:${qIds[1]}`)).toMatchObject({ reason: null, source: "review" });
    signIn(apiReadyUser());
    expect((await flagPOST(post({}), ctx(qIds[0]))).status).toBe(404);
    expect((await quizmeReportPOST(post({ index: 0 }), ctx(v.id))).status).toBe(404);
  });

  it("a reason that is not a string (number, object, array, boolean, null) is stored as no reason on every route; nothing throws", async () => {
    const w = world();
    signIn(w.userId);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const rev = openLectureReview(w.userId, w.examId, w.doc1);
    const { attemptId, qIds } = attemptWith(w, 5);
    const odd = [42, { a: 1 }, ["x"], true, null];
    expect((await quizmeReportPOST(post({ index: 0, reason: odd[0] }), ctx(rev.id))).status).toBe(200);
    for (const [i, reason] of odd.entries()) {
      expect((await attemptReportPOST(post({ questionId: qIds[i], reason }), ctx(attemptId))).status).toBe(200);
    }
    const quizIds = ["b0", "b1", "b2"];
    for (const [i, reason] of odd.slice(0, 3).entries()) {
      expect((await quizReportPOST(post({ topicId: w.t2, questionId: quizIds[i], reason }), ctx(w.sessionId))).status).toBe(200);
    }
    for (const reason of odd) {
      const q = Number(db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 'F?', '[\"a\",\"b\"]', 0, 'e')").run(w.examId, w.t1).lastInsertRowid);
      expect((await flagPOST(post({ reason }), ctx(q))).status).toBe(200);
    }
    const mine = listReportedQuestions().filter((r) => r.user_id === w.userId);
    expect(mine.length).toBe(1 + 5 + 3 + 5);
    expect(mine.every((r) => r.reason === null)).toBe(true);
    expect(checksOf(w.t2).map((q) => q.report_note ?? null)).toEqual([null, null, null]);
  });

  it("a reason with newlines/tabs/runs of spaces is one tidy line in the row, the file and the hidden question's note; blank means none; 500 cap", async () => {
    const w = world();
    signIn(w.userId);
    const messy = "  line one\n\n\tline   two\r\nend   ";
    expect(cleanReason(messy)).toBe("line one line two end");
    expect(cleanReason(" \n\t ")).toBeNull();
    expect(cleanReason("")).toBeNull();
    expect((await quizReportPOST(post({ topicId: w.t2, questionId: "b0", reason: messy }), ctx(w.sessionId))).status).toBe(200);
    expect((await quizReportPOST(post({ topicId: w.t2, questionId: "b1", reason: " \n " }), ctx(w.sessionId))).status).toBe(200);
    const rec = listReportedQuestions().find((r) => r.ref === `quiz:${w.t2}:b0`)!;
    expect(rec.reason).toBe("line one line two end");
    const file = JSON.parse(fs.readFileSync(path.join(FILES_DIR, "reported-questions", `${rec.id}.json`), "utf8")) as { reason: string };
    expect(file.reason).toBe("line one line two end");
    expect(checksOf(w.t2)[0].report_note).toBe("line one line two end");
    expect(checksOf(w.t2)[1].report_note ?? null).toBeNull();
    // whitespace collapses BEFORE the cap, so 600 chars of "ab " is capped on real text
    expect(cleanReason("ab ".repeat(300))!.length).toBeLessThanOrEqual(500);
    expect(cleanReason("x".repeat(499) + "   " + "y".repeat(50))!.length).toBeLessThanOrEqual(500);
  });

  it("the JSON file written for a report matches its row (id, source, ref, reason, question) and reaches the export", async () => {
    const w = world();
    signIn(w.userId);
    await quizReportPOST(post({ topicId: w.t3, questionId: "c1", reason: "file check" }), ctx(w.sessionId));
    const rec = listReportedQuestions().find((r) => r.ref === `quiz:${w.t3}:c1`)!;
    const file = JSON.parse(fs.readFileSync(path.join(FILES_DIR, "reported-questions", `${rec.id}.json`), "utf8")) as Record<string, unknown>;
    expect(file).toMatchObject({ id: rec.id, source: "quiz", ref: rec.ref, reason: "file check", question: rec.question, examId: w.examId, topicId: w.t3 });
    expect(new Date(file.created_at as string).getTime()).not.toBeNaN();
    signIn(apiReadyUser(true));
    const ex = (await (await exportGET()).json()) as { reported_questions: { id: number; ref: string; question: unknown }[] };
    expect(ex.reported_questions.find((r) => r.id === rec.id)).toMatchObject({ ref: rec.ref, question: rec.question });
    // newest first
    const ids = ex.reported_questions.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("a failing file write (writeFileSync or mkdirSync throws) never loses the row nor fails the report, on every route", async () => {
    const w = world();
    signIn(w.userId);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const rev = openLectureReview(w.userId, w.examId, w.doc1);
    const { attemptId, qIds } = attemptWith(w, 2);
    const boom = () => {
      throw new Error("disk full");
    };
    const spyW = vi.spyOn(fs, "writeFileSync").mockImplementation(boom);
    expect((await quizReportPOST(post({ topicId: w.t2, questionId: "b2", reason: "r" }), ctx(w.sessionId))).status).toBe(200);
    expect((await attemptReportPOST(post({ questionId: qIds[0], reason: "r" }), ctx(attemptId))).status).toBe(200);
    expect((await quizmeReportPOST(post({ index: 0, reason: "r" }), ctx(rev.id))).status).toBe(200);
    spyW.mockRestore();
    const spyM = vi.spyOn(fs, "mkdirSync").mockImplementation(boom);
    expect((await flagPOST(post({ reason: "r" }), ctx(qIds[1]))).status).toBe(200);
    spyM.mockRestore();
    const refs = listReportedQuestions().filter((r) => r.user_id === w.userId).map((r) => r.ref);
    expect(refs).toEqual(expect.arrayContaining([`quiz:${w.t2}:b2`, `question:${qIds[0]}`, `question:${qIds[1]}`, `quizme:${rev.id}:0`]));
    expect(hiddenOf(w.t2)[2]).toBe(true);
    expect(errorLog).toHaveBeenCalled();
  });

  it("the report of a review question is recorded as lecture_review (ref of the review, slide origin when known), a plain quiz me as quizme", async () => {
    const w = world();
    signIn(w.userId);
    const id = quizMeOn(w.userId, w.examId, w.t1, [null, null]);
    const qs = quizMeQs(id);
    const page = (db.prepare("SELECT id FROM pages WHERE document_id = ? ORDER BY id").get(w.doc1) as { id: number }).id;
    qs[1].source_page_id = page;
    setQuizMeQs(id, qs);
    expect((await quizmeReportPOST(post({ index: 1, reason: "r" }), ctx(id))).status).toBe(200);
    const rec = listReportedQuestions().find((r) => r.ref === `quizme:${id}:1`)!;
    expect(rec).toMatchObject({ source: "quizme", topic_id: w.t1 });
    expect(rec.question).toMatchObject({ lecture: "Lecture 1 - Pulp", slide: 1, section: "Pulp anatomy" });
    // a quiz me with one question left is not finished by hiding the other when nothing was answered
    expect(quizMeRow(id).finished_at).toBeNull();
    // a hidden quiz-me question is refused when answered
    expect(() => answerQuizMe({ userId: w.userId, id, index: 1, chosen: 0 })).toThrow(QuizMeError);
    expect(answerQuizMe({ userId: w.userId, id, index: 0, chosen: 0 })).toMatchObject({ correct: true, finished: true });
  });

  it("a quiz-me question reported in the highlight quiz drops out of the lecture misses even if she had answered it wrong; the quiz is finished once nothing is left", async () => {
    const w = world();
    signIn(w.userId);
    const id = quizMeOn(w.userId, w.examId, w.t2, [1, 1]);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quizme:${id}:0`, `quizme:${id}:1`]);
    expect((await quizmeReportPOST(post({ index: 0 }), ctx(id))).status).toBe(200);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quizme:${id}:1`]);
    expect(quizMeRow(id).finished_at).not.toBeNull(); // both were answered, one is now hidden: nothing is left to answer
  });

  it("reporting a review question that came from a quiz me hides it in that quiz me (and only that one); a review row is never hidden as a source", () => {
    const w = world();
    const id = quizMeOn(w.userId, w.examId, w.t2, [1, null]);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    expect(quizMeQs(v.id)[0].ref).toBe(`quizme:${id}:0`);
    hideQuizMeQuestion(w.userId, v.id, 0, "r");
    expect(quizMeQs(id).map((q) => !!q.hidden)).toEqual([true, false]);
    // a hand-made ref pointing at the review itself / garbage refs do nothing and do not throw
    const qs = quizMeQs(v.id);
    qs.push({ ...qs[0], hidden: undefined, question: "x?", ref: `quizme:${v.id}:0` }, { ...qs[0], hidden: undefined, question: "y?", ref: "garbage" }, { ...qs[0], hidden: undefined, question: "z?", ref: "quiz:abc:1" });
    setQuizMeQs(v.id, qs);
    for (const i of [1, 2, 3]) expect(() => hideQuizMeQuestion(w.userId, v.id, i)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("reportedStems and the section-quiz writer", () => {
  const report = (w: World, topicId: number, stem: string) =>
    saveReportedQuestion({ userId: w.userId, examId: w.examId, topicId, source: "quiz", ref: `quiz:${topicId}:${Math.random()}`, question: { question: stem, options: ["a", "b"], correct_index: 0 }, reason: null });

  it("newest first, de-duplicated by normalised text, capped at 12, 200 characters each, only for that section", () => {
    const w = world();
    const other = world();
    for (let i = 0; i < 14; i++) report(w, w.t1, `Stem number ${i}?`);
    report(w, w.t2, "Other section?");
    report(other, other.t1, "Other exam?");
    const stems = reportedStems(w.t1);
    expect(stems).toHaveLength(12);
    expect(stems.slice(0, 3)).toEqual(["Stem number 13?", "Stem number 12?", "Stem number 11?"]);
    expect(reportedStems(w.t2)).toEqual(["Other section?"]);
    expect(reportedStems(w.t3)).toEqual([]);
    report(w, w.t3, "x".repeat(400));
    expect(reportedStems(w.t3)[0]).toHaveLength(200);
    report(w, w.t3, "   ?!  ");
    expect(reportedStems(w.t3)).toHaveLength(1); // a stem with no letters is not an instruction
    expect(reportedStems(w.t1, 3)).toHaveLength(3);
    // the same question reported again, differently punctuated, is one stem (and the newest wording is shown)
    report(w, w.t2, "OTHER   section!!");
    expect(reportedStems(w.t2)).toEqual(["OTHER   section!!".replace(/\s+/g, " ")]);
  });

  // reportedStems takes the newest 12 ROWS and de-duplicates afterwards, so repeats of one stem eat the cap. Input: the same
  // question reported 13 times (a double submit on the section-quiz route records twice; a question flagged in several exams),
  // then two other reported questions older than that. Wrong output: ["Repeated?"]; the two older stems are not passed to the writer.
  it("fixed: repeated reports of one stem use up the cap of 12 and hide older distinct reported stems", () => {
    const w = world();
    report(w, w.t1, "Older one?");
    report(w, w.t1, "Older two?");
    for (let i = 0; i < 13; i++) report(w, w.t1, "Repeated?");
    expect(reportedStems(w.t1)).toEqual(["Repeated?", "Older two?", "Older one?"]);
  });

  /** A topic of `n` slides (one distinct fact each) so the writer is asked in two halves. */
  function bigTopic(w: World, n: number) {
    const pages = Array.from({ length: n }, (_, i) =>
      Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(w.doc1, 100 + i, notes(100 + i)).lastInsertRowid),
    );
    const id = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id) VALUES (?, 9, 'Big', 's', ?, ?)").run(w.examId, JSON.stringify(pages), w.doc1).lastInsertRowid);
    return db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
  }

  it("a quiz of more than 4 questions is written in two halves and BOTH are told the reported stems", async () => {
    const w = world();
    const t = bigTopic(w, 6);
    report(w, t.id, "Reported stem one?");
    report(w, t.id, "Reported stem two?");
    const qs = await getSectionQuiz(t);
    expect(qs.length).toBe(6);
    const writes = gen.calls.filter((c) => c.purpose === "section quiz");
    expect(writes).toHaveLength(2);
    for (const c of writes) {
      expect(c.content).toContain("- Reported stem one?");
      expect(c.content).toContain("- Reported stem two?");
    }
    expect(gen.calls.filter((c) => c.purpose === "section quiz check").length).toBeGreaterThan(0);
  });

  it("no reports: the prompt has no 'already in this quiz' block at all", async () => {
    const w = world();
    const t = bigTopic(w, 6);
    await getSectionQuiz(t);
    expect(gen.calls.filter((c) => c.purpose === "section quiz").every((c) => !c.content.includes("Questions already in this quiz"))).toBe(true);
  });

  it("the cover/housekeeping rule is in the writer's and the checker's system prompt", async () => {
    const w = world();
    const t = bigTopic(w, 3);
    await getSectionQuiz(t);
    const { NO_COVER_CHECK, NO_COVER_RULE } = await import("@/lib/examStyle");
    expect(gen.calls.find((c) => c.purpose === "section quiz")!.system).toContain(NO_COVER_RULE);
    expect(gen.calls.find((c) => c.purpose === "section quiz check")!.system).toContain(NO_COVER_CHECK);
  });

  // generateSectionQuiz only passes reportedStems to the writer as advice; keep()/the repair filter dedupe among the new
  // drafts only. Input: a reported stem "Q2 fresh?", the writer (as models do) writes it again. Wrong output: the new quiz
  // contains the reported question verbatim, and since a rewrite clears answers it is back in front of every student.
  it("fixed: a writer that returns a reported question's text again gets it into the new quiz", async () => {
    const w = world();
    const t = bigTopic(w, 3);
    report(w, t.id, "The reported question?");
    gen.stem = { 2: "The reported question?!" };
    const qs = await getSectionQuiz(t);
    expect(qs.map((q) => q.question)).not.toContain("The reported question?!");
  });

  // The repair call (for slots whose draft was dropped) is told only the questions kept so far ([...kept.values()]), not the
  // reported stems, so it is the one writer call that may write a reported question again.
  it("fixed: the repair call is not told the reported stems", async () => {
    const w = world();
    const t = bigTopic(w, 3);
    report(w, t.id, "Reported before the rewrite?");
    gen.drop = new Set([2]);
    const qs = await getSectionQuiz(t);
    expect(qs).toHaveLength(3);
    const writes = gen.calls.filter((c) => c.purpose === "section quiz");
    expect(writes.length).toBe(2); // first pass + repair
    expect(writes[1].content).toContain("- Reported before the rewrite?");
  });

  // reportedStems(topic.id) matches reported_questions.topic_id exactly. A report is saved with the REPORTER's topic id, and a
  // class copy's section has its own id, so the stems reported by classmates (or the owner) never reach a copy's writer, though
  // generateSectionQuiz's comment and the module's doc say "own copy or any class copy".
  it("fixed: stems reported in a class copy's section are not given to the writer of another copy of that section", async () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const mate = apiReadyUser();
    const b = copyOf(owner, w.examId, mate);
    signIn(owner);
    await quizReportPOST(post({ topicId: w.t1, questionId: "a1", reason: "r" }), ctx(w.sessionId));
    expect(reportedStems(w.t1)).toEqual(["a question 1?"]);
    expect(reportedStems(topicAt(b, 0).id)).toEqual(["a question 1?"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the daily-review flag route and the export", () => {
  it("flag: source 'practice' is accepted, anything else is 'review'; the legacy 'note' still works; a class copy's question is flagged too", async () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const mk = (stem: string) =>
      Number(db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', ?, '[\"a\",\"b\",\"c\"]', 1, 'e')").run(w.examId, w.t1, stem).lastInsertRowid);
    const q1 = mk("Flag one?");
    const q2 = mk("Flag two?");
    const q3 = mk("Flag three?");
    signIn(owner);
    await flagPOST(post({ reason: "r1", source: "practice" }), ctx(q1));
    await flagPOST(post({ note: "legacy note", source: { x: 1 } }), ctx(q2));
    await flagPOST(post({ note: "legacy", reason: 5 }), ctx(q3)); // a non-string reason is ignored; the legacy note still counts
    const rec = (id: number) => listReportedQuestions().find((r) => r.ref === `question:${id}`)!;
    expect(rec(q1)).toMatchObject({ source: "practice", reason: "r1" });
    expect(rec(q2)).toMatchObject({ source: "review", reason: "legacy note" });
    expect(rec(q3).reason).toBe("legacy");
    // the same flag twice writes a second record (the review page hides the button once flagged)
    await flagPOST(post({ reason: "again" }), ctx(q1));
    expect(listReportedQuestions().filter((r) => r.ref === `question:${q1}`)).toHaveLength(2);
  });

  it("export: admin only, reporter shown instead of email/user id, newest first, valid JSON even with odd text in a question", async () => {
    const w = world();
    saveReportedQuestion({ userId: w.userId, examId: w.examId, topicId: null, source: "review", ref: "question:1", question: { question: 'He said "hi"\n</script>   émoji 🦷', options: ["a"], correct_index: null }, reason: null });
    signIn(w.userId);
    expect((await exportGET()).status).toBe(404);
    signIn(apiReadyUser(true));
    const res = await exportGET();
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const json = (await res.json()) as { count: number; reported_questions: Record<string, unknown>[] };
    expect(json.count).toBe(json.reported_questions.length);
    const mine = json.reported_questions.find((r) => (r.question as { question: string }).question.includes("émoji"))!;
    expect(mine).toBeTruthy();
    expect(mine).not.toHaveProperty("email");
    expect(mine).not.toHaveProperty("user_id");
    expect(typeof mine.reporter).toBe("string");
    expect(JSON.stringify(json)).not.toContain("password_hash");
  });

  it("an unreadable stored question_json lists as '(unreadable)' instead of breaking the list and the stems", () => {
    const w = world();
    db.prepare("INSERT INTO reported_questions (user_id, exam_id, topic_id, source, ref, question_json) VALUES (?, ?, ?, 'quiz', 'quiz:x', '{bad')").run(w.userId, w.examId, w.t3);
    expect(listReportedQuestions().some((r) => r.question.question === "(unreadable)")).toBe(true);
    expect(() => reportedStems(w.t3)).not.toThrow();
  });
});
