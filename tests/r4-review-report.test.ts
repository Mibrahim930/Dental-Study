// Release 4: the end-of-lecture review (one quiz of exactly what she got wrong in the lecture) and the Report button on
// every question (out of the quiz or exam she's in and its score; the record goes to the owner).
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

type GenOpts = { purpose: string; content: string; system: string };
const gen = vi.hoisted(() => ({ calls: [] as GenOpts[] }));
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: GenOpts) => {
    gen.calls.push(opts);
    if (opts.purpose === "section quiz") {
      const slots = [...opts.content.matchAll(/^Q(\d+): (?:slide P(\d+)|the section)/gm)].map((m) => ({ n: Number(m[1]), page: m[2] ? Number(m[2]) : 0 }));
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          question: `Q${s.n} fresh?`,
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
import { answerQuizMe, getQuizMe, lectureMisses, lectureReviewStatus, openLectureReview, QuizMeError, REVIEW_MAX_ROUNDS, type QuizMeQuestion } from "@/lib/quizMe";
import { recordQuizAnswer } from "@/lib/quizProgress";
import { getSectionQuiz, QUIZ_VERSION, type QuizQuestion } from "@/lib/study";
import { answerQuestion, finishAttempt, reportAttemptQuestion } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { listReportedQuestions, reportedStems } from "@/lib/reportedQuestions";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { POST as lecturePOST, GET as lectureGET } from "@/app/api/quizme/lecture/route";
import { POST as quizmeReportPOST } from "@/app/api/quizme/[id]/report/route";
import { POST as quizReportPOST } from "@/app/api/sessions/[id]/quiz/report/route";
import { POST as attemptReportPOST } from "@/app/api/attempts/[id]/report/route";
import { POST as flagPOST } from "@/app/api/questions/[id]/flag/route";
import { GET as exportGET } from "@/app/api/admin/reported-questions/route";
import { makeUser } from "./helpers";

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });

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

/** A stored section quiz of `n` questions with stable ids. */
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

/**
 * One exam with two lectures. Lecture 1 has two sections of 2 slides, each with a 3-question quiz; lecture 2 has one
 * section with a 2-question quiz. The study session makes the quiz routes reachable.
 */
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

/** A "quiz me" quiz on a section, with the given answers already given (null = unanswered). */
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

const refsOf = (userId: number, examId: number, doc: number) => lectureMisses(userId, examId, doc).map((m) => m.ref);

beforeEach(() => {
  gen.calls.length = 0;
  signIn(null);
});

describe("lecture misses", () => {
  it("collects the wrong section-quiz answers of the lecture's sections, in order; right answers and other lectures stay out", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 1, 0, true);
    recordQuizAnswer(w.userId, w.t2, 2, 3, false);
    recordQuizAnswer(w.userId, w.t3, 0, 1, false); // lecture 2
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t1}:0`, `quiz:${w.t2}:2`]);
    expect(refsOf(w.userId, w.examId, w.doc2)).toEqual([`quiz:${w.t3}:0`]);
    const m = lectureMisses(w.userId, w.examId, w.doc1)[0].question;
    expect(m).toMatchObject({ question: "a question 0?", correct_index: 0, option_notes: ["r", "w", "w", "w"] });
  });

  it("adds wrong 'quiz me' answers on the lecture's sections; unanswered, right, hidden and other-section ones stay out; the same question text counts once", () => {
    const w = world();
    const id = quizMeOn(w.userId, w.examId, w.t1, [1, 0, null, 2]);
    // question 3 hidden (reported)
    const qs = JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
    qs[3].hidden = true;
    db.prepare("UPDATE quizme SET questions_json = ? WHERE id = ?").run(JSON.stringify(qs), id);
    quizMeOn(w.userId, w.examId, w.t3, [1]); // lecture 2's section
    // the same text as a section-quiz question she also missed: once
    const dupe = quizMeOn(w.userId, w.examId, w.t2, [1], "x");
    const dq = JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(dupe) as { questions_json: string }).questions_json) as QuizMeQuestion[];
    dq[0].question = "a question 0?";
    db.prepare("UPDATE quizme SET questions_json = ? WHERE id = ?").run(JSON.stringify(dq), dupe);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t1}:0`, `quizme:${id}:0`]);
  });

  it("a reported (hidden) section-quiz question and another student's answers never count", () => {
    const w = world();
    const other = world(apiReadyUser());
    recordQuizAnswer(other.userId, other.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 1, 1, false);
    const qs = JSON.parse(w.topicRow(w.t1).checks_json!) as QuizQuestion[];
    qs[1].hidden = true;
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(qs), w.t1);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    expect(refsOf(other.userId, other.examId, other.doc1)).toEqual([`quiz:${other.t1}:0`]);
  });
});

describe("the lecture review", () => {
  it("nothing missed: no review (plain message), status says 0", () => {
    const w = world();
    expect(() => openLectureReview(w.userId, w.examId, w.doc1)).toThrow(QuizMeError);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toEqual({ missed: 0, open: null });
  });

  it("opens one quiz of exactly the misses (options reshuffled, key following), resumes it, and a right answer retires the miss", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t2, 1, 2, false);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1).missed).toBe(2);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    expect(v.kind).toBe("lecture");
    expect(v.documentId).toBe(w.doc1);
    expect(v.text).toBe("Lecture 1 - Pulp");
    expect(v.questions.map((q) => q.question)).toEqual(["a question 0?", "b question 1?"]);
    expect(v.questions[0].options).toEqual(expect.arrayContaining(["right", "w1", "w2", "w3"]));
    expect(v.questions[0].correct_index).toBeUndefined(); // not revealed until answered
    expect(gen.calls).toHaveLength(0); // no AI call
    // the same unfinished review comes back, not a second one
    expect(openLectureReview(w.userId, w.examId, w.doc1).id).toBe(v.id);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toMatchObject({ missed: 2, open: { id: v.id } });
    const stored = JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(v.id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
    const right0 = stored[0].options.indexOf("right");
    expect(stored[0].correct_index).toBe(right0);
    expect(stored[0].ref).toBe(`quiz:${w.t1}:0`);
    // right on the first, wrong on the second: the second comes round again (round 2) before the review is done
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: right0 })).toMatchObject({ correct: true, finished: false });
    const wrong1 = stored[1].options.indexOf("w1");
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 1, chosen: wrong1 })).toMatchObject({ correct: false, finished: false });
    // the first miss is dealt with; the second is still a miss, waiting in the open review's second round
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t2}:1`]);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toMatchObject({ missed: 1, open: { id: v.id, round: 2 } });
    expect(openLectureReview(w.userId, w.examId, w.doc1).id).toBe(v.id); // resumed, not a new one
    // missed again in round 2 → round 3; right there → done, and the next review has nothing
    const again = JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(v.id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
    expect(again[2]).toMatchObject({ question: "b question 1?", round: 2 });
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 2, chosen: again[2].options.indexOf("w2") })).toMatchObject({ correct: false, finished: false });
    const third = JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(v.id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 3, chosen: third[3].options.indexOf("right") })).toMatchObject({ correct: true, finished: true });
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toEqual({ missed: 0, open: null });
    expect(() => openLectureReview(w.userId, w.examId, w.doc1)).toThrow(QuizMeError);
    // the section quiz's own answer is untouched (progress stays as she scored it)
    expect(db.prepare("SELECT correct FROM quiz_answers WHERE user_id = ? AND topic_id = ? AND check_index = 0").get(w.userId, w.t1)).toEqual({ correct: 0 });
  });

  it("a question retired by a review comes back if she misses it again afterwards (a retake)", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    const stored = JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(v.id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
    answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: stored[0].options.indexOf("right") });
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    // retake: the answer is cleared and given wrong again, later than the review
    db.prepare("DELETE FROM quiz_answers WHERE user_id = ? AND topic_id = ?").run(w.userId, w.t1);
    db.prepare("UPDATE lecture_review_done SET done_at = datetime('now', '-1 hour') WHERE user_id = ?").run(w.userId);
    recordQuizAnswer(w.userId, w.t1, 0, 2, false);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t1}:0`]);
  });

  it("routes: status and open need the exam owner; another user's exam is 404; a bad body is 400", async () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    signIn(w.userId);
    const st = await lectureGET(new Request(`http://x/api?examId=${w.examId}&documentId=${w.doc1}`));
    expect(st.status).toBe(200);
    expect(await st.json()).toMatchObject({ missed: 1, open: null });
    const open = await lecturePOST(post({ examId: w.examId, documentId: w.doc1 }));
    expect(open.status).toBe(200);
    expect((await open.json()).questions).toHaveLength(1);
    expect((await lecturePOST(post({ examId: w.examId }))).status).toBe(400);
    expect((await lecturePOST(post({ examId: w.examId, documentId: w.doc2 }))).status).toBe(400); // nothing missed there
    signIn(apiReadyUser());
    expect((await lectureGET(new Request(`http://x/api?examId=${w.examId}&documentId=${w.doc1}`))).status).toBe(404);
    expect((await lecturePOST(post({ examId: w.examId, documentId: w.doc1 }))).status).toBe(404);
    signIn(null);
    expect((await lecturePOST(post({ examId: w.examId, documentId: w.doc1 }))).status).toBe(401);
  });
});

describe("review rounds", () => {
  const stored = (id: number) => JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
  const rightIdx = (id: number, i: number) => stored(id)[i].options.indexOf("right");
  const wrongIdx = (id: number, i: number) => stored(id)[i].options.indexOf("w1");

  it("a round finished with misses opens the next round: copies of the missed ones, options reshuffled, answers empty, not finished", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 1, 1, false);
    recordQuizAnswer(w.userId, w.t2, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    expect(v.round).toBe(1);
    expect(v.questions.map((q) => q.round)).toEqual([1, 1, 1]);
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: rightIdx(v.id, 0) })).toMatchObject({ correct: true, finished: false });
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 1, chosen: wrongIdx(v.id, 1) })).toMatchObject({ correct: false, finished: false });
    const last = answerQuizMe({ userId: w.userId, id: v.id, index: 2, chosen: wrongIdx(v.id, 2) })!;
    expect(last).toMatchObject({ correct: false, finished: false }); // misses → round 2, so not finished
    const qs = stored(v.id);
    expect(qs).toHaveLength(5);
    expect(qs.slice(3).map((q) => q.round)).toEqual([2, 2]);
    expect(qs.slice(3).map((q) => q.question)).toEqual([qs[1].question, qs[2].question]);
    expect(qs.slice(3).map((q) => q.ref)).toEqual([qs[1].ref, qs[2].ref]);
    for (const q of qs.slice(3)) {
      expect(q.options.indexOf("right")).toBe(q.correct_index);
      expect(q.option_notes![q.correct_index]).toBe("r");
    }
    const view = getQuizMe(w.userId, v.id)!;
    expect(view).toMatchObject({ round: 2, left: 2, finished: false });
    expect(view.questions.slice(3).every((q) => q.chosen == null && q.correct_index === undefined)).toBe(true);
    expect(db.prepare("SELECT 1 FROM quizme WHERE id = ? AND finished_at IS NULL").get(v.id)).toBeTruthy();
    // the status card counts what's left in the open review
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toMatchObject({ missed: 2, open: { id: v.id } });
    // round 2: one right (retired), one wrong again → round 3 with just that one
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 3, chosen: rightIdx(v.id, 3) })).toMatchObject({ correct: true, finished: false });
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 4, chosen: wrongIdx(v.id, 4) })).toMatchObject({ correct: false, finished: false });
    expect(stored(v.id).map((q) => q.round)).toEqual([1, 1, 1, 2, 2, 3]);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t2}:0`]); // only the one still wrong
    // round 3 right: finished, everything retired
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 5, chosen: rightIdx(v.id, 5) })).toMatchObject({ correct: true, finished: true });
    expect(getQuizMe(w.userId, v.id)).toMatchObject({ finished: true, left: 0, round: 3 });
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
  });

  it("all right in the first round: finished at once, no second round; a hidden (reported) question never comes back", async () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 1, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    signIn(w.userId);
    expect((await quizmeReportPOST(post({ index: 1, reason: "bad" }), ctx(v.id))).status).toBe(200);
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: rightIdx(v.id, 0) })).toMatchObject({ correct: true, finished: true });
    expect(stored(v.id)).toHaveLength(2);
    expect(getQuizMe(w.userId, v.id)).toMatchObject({ finished: true, round: 1 });
  });

  it("rounds stop at the limit, and a 'quiz me' quiz never gets a second round", () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    let at = 0;
    for (let round = 1; round < REVIEW_MAX_ROUNDS; round++) {
      expect(answerQuizMe({ userId: w.userId, id: v.id, index: at, chosen: wrongIdx(v.id, at) })).toMatchObject({ correct: false, finished: false });
      at++;
    }
    expect(stored(v.id)).toHaveLength(REVIEW_MAX_ROUNDS);
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: at, chosen: wrongIdx(v.id, at) })).toMatchObject({ correct: false, finished: true });
    expect(stored(v.id)).toHaveLength(REVIEW_MAX_ROUNDS);
    const qm = quizMeOn(w.userId, w.examId, w.t1, [null, null]);
    expect(answerQuizMe({ userId: w.userId, id: qm, index: 0, chosen: 1 })).toMatchObject({ correct: false, finished: false });
    expect(answerQuizMe({ userId: w.userId, id: qm, index: 1, chosen: 1 })).toMatchObject({ correct: false, finished: true });
    expect(stored(qm)).toHaveLength(2);
  });
});

describe("reporting a question", () => {
  it("in a lecture review / quiz me: hidden, out of the score, the record saved (source, ref, reason, slide origin) and written to a file", async () => {
    const w = world();
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    recordQuizAnswer(w.userId, w.t1, 2, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    signIn(w.userId);
    const res = await quizmeReportPOST(post({ index: 0, reason: "  it's about the   cover slide " }), ctx(v.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quiz: { questions: { hidden?: boolean }[]; left: number } };
    expect(body.quiz.questions[0].hidden).toBe(true);
    expect(body.quiz.left).toBe(1);
    // answering the hidden one is refused; the other still works and finishes the quiz
    expect(() => answerQuizMe({ userId: w.userId, id: v.id, index: 0, chosen: 0 })).toThrow(QuizMeError);
    const stored = JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(v.id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
    expect(answerQuizMe({ userId: w.userId, id: v.id, index: 1, chosen: stored[1].options.indexOf("right") })).toMatchObject({ correct: true, finished: true });
    const [r] = listReportedQuestions();
    expect(r).toMatchObject({ source: "lecture_review", ref: `quizme:${v.id}:0`, reason: "it's about the cover slide", exam_id: w.examId, topic_id: null });
    expect(r.question).toMatchObject({ question: "a question 0?", correct_index: stored[0].correct_index, exam: "Endo" });
    expect(fs.existsSync(path.join(FILES_DIR, "reported-questions", `${r.id}.json`))).toBe(true);
    // the reported question is hidden where it came from too (its section quiz), so it never comes back as a miss
    expect((JSON.parse(w.topicRow(w.t1).checks_json!) as QuizQuestion[]).map((q) => !!q.hidden)).toEqual([true, false, false]);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    // a second report of the same question, or someone else's, is refused
    expect((await quizmeReportPOST(post({ index: 0 }), ctx(v.id))).status).toBe(404);
    signIn(apiReadyUser());
    expect((await quizmeReportPOST(post({ index: 1 }), ctx(v.id))).status).toBe(404);
  });

  it("in a section quiz: hidden in the student's copy and the class copy, recorded with the slide it tests; the writers are told to avoid it", async () => {
    const owner = apiReadyUser();
    const w = world(owner);
    const mate = apiReadyUser();
    const cls = createClass(owner, "C1");
    joinClass(mate, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(cls) as { invite_code: string }).invite_code);
    shareExam(owner, cls, w.examId);
    const copy = addSharedExam(mate, (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ? AND class_id = ?").get(w.examId, cls) as { id: number }).id) as { examId: number };
    const copyTopic = db.prepare("SELECT * FROM topics WHERE exam_id = ? AND position = 0").get(copy.examId) as Topic;
    expect((JSON.parse(copyTopic.checks_json!) as QuizQuestion[])[1].id).toBe("a1");

    signIn(owner);
    const res = await quizReportPOST(post({ topicId: w.t1, questionId: "a1", reason: "nonsense" }), ctx(w.sessionId));
    expect(res.status).toBe(200);
    for (const t of [w.topicRow(w.t1), db.prepare("SELECT * FROM topics WHERE id = ?").get(copyTopic.id) as Topic]) {
      const qs = JSON.parse(t.checks_json!) as QuizQuestion[];
      expect(qs.map((q) => !!q.hidden)).toEqual([false, true, false]);
      expect(qs[1].report_note).toBe("nonsense");
    }
    const [r] = listReportedQuestions();
    expect(r).toMatchObject({ source: "quiz", ref: `quiz:${w.t1}:a1`, topic_id: w.t1, reason: "nonsense" });
    expect(r.question).toMatchObject({ question: "a question 1?", section: "Pulp anatomy", exam: "Endo" });
    expect(reportedStems(w.t1)).toEqual(["a question 1?"]);
    // unknown question, wrong session owner
    expect((await quizReportPOST(post({ topicId: w.t1, questionId: "zz" }), ctx(w.sessionId))).status).toBe(400);
    signIn(mate);
    expect((await quizReportPOST(post({ topicId: w.t1, questionId: "a0" }), ctx(w.sessionId))).status).toBe(404);
    // "Write new questions" names the reported stem so the writer steers clear of it
    await getSectionQuiz({ ...w.topicRow(w.t1), checks_json: null, checks_version: null });
    const writes = gen.calls.filter((c) => c.purpose === "section quiz");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.content.includes("- a question 1?"))).toBe(true);
  });

  it("in a practice exam: out of this exam and its grade (8 right of 15, one reported → 8/14), flagged everywhere, answering it is ignored", async () => {
    const w = world();
    const qIds = Array.from({ length: 15 }, (_, i) =>
      Number(
        db
          .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', ?, ?, 0, 'e')")
          .run(w.examId, w.t1, `Practice ${i}?`, JSON.stringify(["right", "w1", "w2", "w3"])).lastInsertRowid,
      ),
    );
    const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(w.examId).lastInsertRowid);
    qIds.forEach((q, i) => db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)").run(attemptId, q, i));
    // 8 right (0-7), 6 wrong (8-13), the 15th reported before she answers it
    qIds.slice(0, 8).forEach((q) => answerQuestion(attemptId, q, 0));
    qIds.slice(8, 14).forEach((q) => answerQuestion(attemptId, q, 1));
    signIn(w.userId);
    const res = await attemptReportPOST(post({ questionId: qIds[14], reason: "irrelevant" }), ctx(attemptId));
    expect(res.status).toBe(200);
    const view = (await res.json()) as { questions: { id: number }[] };
    expect(view.questions).toHaveLength(14);
    expect(view.questions.some((q) => q.id === qIds[14])).toBe(false);
    answerQuestion(attemptId, qIds[14], 0); // ignored
    expect((db.prepare("SELECT chosen_index FROM attempt_questions WHERE attempt_id = ? AND question_id = ?").get(attemptId, qIds[14]) as { chosen_index: number | null }).chosen_index).toBeNull();
    finishAttempt(attemptId);
    const a = db.prepare("SELECT score FROM attempts WHERE id = ?").get(attemptId) as { score: number };
    expect(a.score).toBeCloseTo(8 / 14, 6);
    expect(attemptView(attemptId)!.questions).toHaveLength(14);
    expect((db.prepare("SELECT flagged, flag_note FROM questions WHERE id = ?").get(qIds[14]) as { flagged: number; flag_note: string })).toEqual({ flagged: 1, flag_note: "irrelevant" });
    expect(listReportedQuestions()[0]).toMatchObject({ source: "practice", ref: `question:${qIds[14]}`, topic_id: w.t1 });
    // reporting a wrong one after finishing recomputes the stored score: 8/13
    expect((await attemptReportPOST(post({ questionId: qIds[8] }), ctx(attemptId))).status).toBe(200);
    expect((db.prepare("SELECT score FROM attempts WHERE id = ?").get(attemptId) as { score: number }).score).toBeCloseTo(8 / 13, 6);
    // twice, or not in this exam, or someone else's exam
    expect((await attemptReportPOST(post({ questionId: qIds[8] }), ctx(attemptId))).status).toBe(400);
    expect((await attemptReportPOST(post({ questionId: 999999 }), ctx(attemptId))).status).toBe(400);
    expect(reportAttemptQuestion(w.userId, attemptId, qIds[8], null)).toBe(false);
    signIn(apiReadyUser());
    expect((await attemptReportPOST(post({ questionId: qIds[0] }), ctx(attemptId))).status).toBe(404);
  });

  it("from the daily review (flag route): flagged, recorded as 'review' with the reason; the admin export lists everything, for the admin only", async () => {
    const w = world();
    const qId = Number(
      db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 'Rev?', ?, 2, 'e')").run(w.examId, w.t2, JSON.stringify(["a", "b", "c", "d"])).lastInsertRowid,
    );
    signIn(w.userId);
    expect((await flagPOST(post({ reason: "x".repeat(600), source: "review" }), ctx(qId))).status).toBe(200);
    const [r] = listReportedQuestions();
    expect(r).toMatchObject({ source: "review", ref: `question:${qId}`, topic_id: w.t2 });
    expect(r.reason).toHaveLength(500); // capped
    expect(r.question).toMatchObject({ question: "Rev?", correct_index: 2, section: "Pulp disease" });
    expect((await exportGET()).status).toBe(404); // not an admin
    signIn(apiReadyUser(true));
    const ex = await exportGET();
    expect(ex.status).toBe(200);
    expect(ex.headers.get("Content-Disposition")).toMatch(/attachment; filename="reported-questions-/);
    const json = (await ex.json()) as { count: number; reported_questions: { reporter: string; user_id?: number; question: { question: string } }[] };
    expect(json.count).toBeGreaterThanOrEqual(1);
    const mine = json.reported_questions.find((x) => x.question.question === "Rev?")!;
    expect(mine.user_id).toBeUndefined();
    expect(mine.reporter).toContain("@");
  });
});
