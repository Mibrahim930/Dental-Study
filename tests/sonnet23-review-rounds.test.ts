// Sonnet QA pass on the review ROUNDS (a lecture review re-asks what she missed, up to REVIEW_MAX_ROUNDS) and on marks for
// quiz-me questions. Tests named "BUG: …" failed on purpose when written, each pinning a defect (see the comment above
// it for the input and the wrong output); "fixed:" marks the ones the fix made pass.
import { beforeEach, describe, expect, it, vi } from "vitest";

type GenOpts = { purpose: string; content: string; system: string };
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: GenOpts) => {
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
import { db, type Topic } from "@/lib/db";
import { answerQuizMe, getQuizMe, hideQuizMeQuestion, lectureMisses, lectureReviewStatus, openLectureReview, openQuizMe, REVIEW_MAX_ROUNDS, type QuizMeQuestion } from "@/lib/quizMe";
import { recordQuizAnswer } from "@/lib/quizProgress";
import { QUIZ_VERSION, type QuizQuestion } from "@/lib/study";
import { listReportedQuestions } from "@/lib/reportedQuestions";
import { POST as quizmeReportPOST } from "@/app/api/quizme/[id]/report/route";
import { GET as marksGET, PUT as marksPUT } from "@/app/api/marks/route";
import { GET as quizmeGET } from "@/app/api/quizme/[id]/route";
import { POST as quizmeAnswerPOST } from "@/app/api/quizme/[id]/answer/route";
import { MARKS_KEY } from "@/lib/marks";
import { makeUser } from "./helpers";

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });

const notes = (i: number) =>
  JSON.stringify({ title: `slide ${i}`, summary: "s", image_description: null, key_facts: [`fact ${i}`], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

function apiReadyUser(): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc', must_change_password = 0, is_admin = 0 WHERE id = ?").run(id);
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

/** One exam with two lectures (see r4-review-report): lecture 1 = sections t1 (a0-a2) and t2 (b0-b2); lecture 2 = t3. */
function world(userId = apiReadyUser()) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, topic_status) VALUES (?, 'Endo', 'ready')").run(userId).lastInsertRowid);
  const mkDoc = (name: string) => Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, 'done', 2)").run(examId, name).lastInsertRowid);
  const doc1 = mkDoc("Lecture 1 - Pulp.pdf");
  const doc2 = mkDoc("Lecture 2 - Perio.pdf");
  let n = 0;
  const pageIds: number[] = [];
  const page = (doc: number) => {
    n++;
    const id = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(doc, n, notes(n)).lastInsertRowid);
    pageIds.push(id);
    return id;
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
  const topicRow = (id: number) => db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
  return { userId, examId, doc1, doc2, t1, t2, t3, pageIds, topicRow };
}

/** A "quiz me" (highlight) quiz of `n` questions, all answered (wrong by default) or all open. */
function highlightQuiz(userId: number, examId: number, topicId: number, n: number, answer: number | null = 1, prefix = "hl") {
  const qs: QuizMeQuestion[] = Array.from({ length: n }, (_, i) => ({
    question: `${prefix} highlight question ${i}?`,
    options: ["right", "w1", "w2", "w3"],
    correct_index: 0,
    explanation: "e",
    option_notes: ["nr", "n1", "n2", "n3"],
    concept: "HC",
    source_page_id: null,
    image_page_id: null,
  }));
  return Number(
    db
      .prepare("INSERT INTO quizme (user_id, exam_id, topic_id, text, size, questions_json, answers_json) VALUES (?, ?, ?, 'txt', ?, ?, ?)")
      .run(userId, examId, topicId, n, JSON.stringify(qs), JSON.stringify(qs.map(() => answer))).lastInsertRowid,
  );
}

/** A lecture-review row built by hand (older data, odd data). */
function lectureRow(w: ReturnType<typeof world>, qs: Partial<QuizMeQuestion>[], answers: (number | null)[], userId = w.userId) {
  const full = qs.map((q, i) => ({
    question: `hand question ${i}?`,
    options: ["right", "w1", "w2", "w3"],
    correct_index: 0,
    explanation: "e",
    option_notes: null,
    concept: "",
    source_page_id: null,
    image_page_id: null,
    ref: `quiz:${w.t1}:${i}`,
    ...q,
  }));
  return Number(
    db
      .prepare("INSERT INTO quizme (user_id, exam_id, topic_id, kind, document_id, text, size, questions_json, answers_json) VALUES (?, ?, NULL, 'lecture', ?, 'Lecture 1', ?, ?, ?)")
      .run(userId, w.examId, w.doc1, full.length, JSON.stringify(full), JSON.stringify(answers)).lastInsertRowid,
  );
}

const refsOf = (userId: number, examId: number, doc: number) => lectureMisses(userId, examId, doc).map((m) => m.ref);
const row = (id: number) => db.prepare("SELECT * FROM quizme WHERE id = ?").get(id) as { questions_json: string; answers_json: string; finished_at: string | null };
const stored = (id: number) => JSON.parse(row(id).questions_json) as QuizMeQuestion[];
const storedAnswers = (id: number) => JSON.parse(row(id).answers_json) as (number | null)[];
const rightIdx = (id: number, i: number) => stored(id)[i].options.indexOf("right");
const wrongIdx = (id: number, i: number) => stored(id)[i].options.indexOf("w1");
const ans = (userId: number, id: number, index: number, chosen: number) => answerQuizMe({ userId, id, index, chosen })!;
const conceptRow = (userId: number, name: string) => db.prepare("SELECT attempts, correct FROM concepts WHERE user_id = ? AND name = ?").get(userId, name) as { attempts: number; correct: number } | undefined;

/** A lecture review of `n` section-quiz misses of t1/t2 (n <= 6). */
function reviewOf(w: ReturnType<typeof world>, n: number) {
  for (let i = 0; i < n; i++) recordQuizAnswer(w.userId, i < 3 ? w.t1 : w.t2, i % 3, 1, false);
  return openLectureReview(w.userId, w.examId, w.doc1);
}

beforeEach(() => signIn(null));

// ---------------------------------------------------------------------------------------------------------------
describe("copies in the next round", () => {
  it("every copy keeps its text, key, notes (each note still on its option), ref, source_qid, concept, source_page_id, image_page_id, explanation; only options/order, round and answer slot change", () => {
    const w = world();
    // give the section question the extra fields the copy must carry
    const qs = JSON.parse(w.topicRow(w.t1).checks_json!) as QuizQuestion[];
    qs[0] = { ...qs[0], source_page_id: w.pageIds[0], option_notes: ["note-right", "note-w1", "note-w2", "note-w3"], concept: "Pulp vitality" };
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(qs), w.t1);
    recordQuizAnswer(w.userId, w.t1, 0, 1, false);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    // a picture on the question: the copy must carry it (a real slide of the lecture)
    const withPic = stored(v.id);
    withPic[0].image_page_id = w.pageIds[1];
    db.prepare("UPDATE quizme SET questions_json = ? WHERE id = ?").run(JSON.stringify(withPic), v.id);
    expect(ans(w.userId, v.id, 0, wrongIdx(v.id, 0))).toMatchObject({ correct: false, finished: false });
    const [orig, copy] = stored(v.id);
    expect(copy).toMatchObject({
      question: orig.question,
      explanation: orig.explanation,
      ref: `quiz:${w.t1}:0`,
      source_qid: "a0",
      concept: "Pulp vitality",
      source_page_id: w.pageIds[0],
      image_page_id: w.pageIds[1],
      round: 2,
    });
    expect(copy.hidden).toBeFalsy();
    expect([...copy.options].sort()).toEqual(["right", "w1", "w2", "w3"]);
    expect(copy.options[copy.correct_index]).toBe("right");
    copy.options.forEach((o, i) => expect(copy.option_notes![i]).toBe(`note-${o}`));
    expect(storedAnswers(v.id)).toEqual([orig.options.indexOf("w1"), null]);
    // the original is untouched
    expect(orig).toMatchObject({ round: 1, correct_index: stored(v.id)[0].options.indexOf("right") });
  });

  it("across many questions and rounds: key and notes always follow their option, and the order does get shuffled", () => {
    const w = world();
    const hl = highlightQuiz(w.userId, w.examId, w.t1, 12);
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    expect(v.questions).toHaveLength(12);
    const orders = new Set<string>();
    let at = 0;
    for (let round = 1; round < REVIEW_MAX_ROUNDS; round++) {
      const roundSize = stored(v.id).filter((q) => q.round === round).length;
      for (let k = 0; k < roundSize; k++) ans(w.userId, v.id, at++, wrongIdx(v.id, at - 1));
    }
    const all = stored(v.id);
    expect(all).toHaveLength(12 * REVIEW_MAX_ROUNDS);
    for (const q of all) {
      expect(q.options[q.correct_index]).toBe("right");
      expect(q.option_notes![q.correct_index]).toBe("nr");
      q.options.forEach((o, i) => expect(q.option_notes![i]).toBe({ right: "nr", w1: "n1", w2: "n2", w3: "n3" }[o as "right"]));
      orders.add(q.options.join());
    }
    expect(orders.size).toBeGreaterThan(3);
    expect(hl).toBeGreaterThan(0);
  });

  it("only the WRONG questions of the round come back: a question answered right is never in a later round", () => {
    const w = world();
    const v = reviewOf(w, 5); // a0 a1 a2 b0 b1
    const results = [true, false, true, false, true];
    results.forEach((ok, i) => ans(w.userId, v.id, i, ok ? rightIdx(v.id, i) : wrongIdx(v.id, i)));
    const qs = stored(v.id);
    expect(qs.slice(5).map((q) => q.question)).toEqual([qs[1].question, qs[3].question]);
    expect(qs.slice(5).map((q) => q.round)).toEqual([2, 2]);
    // round 2: both right → finished; nothing for a round 3
    ans(w.userId, v.id, 5, rightIdx(v.id, 5));
    expect(ans(w.userId, v.id, 6, rightIdx(v.id, 6))).toMatchObject({ correct: true, finished: true });
    expect(stored(v.id)).toHaveLength(7);
  });

  it("a hidden (reported) question in the finished round is not copied, and a reported-then-answered attempt is refused", () => {
    const w = world();
    const v = reviewOf(w, 3);
    hideQuizMeQuestion(w.userId, v.id, 2);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    expect(stored(v.id).slice(3).map((q) => q.question)).toEqual([stored(v.id)[0].question, stored(v.id)[1].question]);
    expect(() => answerQuizMe({ userId: w.userId, id: v.id, index: 2, chosen: 0 })).toThrow();
  });

  it("double submit of the round-closing answer (two tabs / double tap): the second gets the first result back and no second set of copies appears", () => {
    const w = world();
    const v = reviewOf(w, 2);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    const first = ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    const again = ans(w.userId, v.id, 1, rightIdx(v.id, 1)); // different pick: the first one stands
    expect(first).toMatchObject({ correct: false, finished: false });
    expect(again).toMatchObject({ correct: false, already: true, finished: false });
    expect(stored(v.id)).toHaveLength(4);
    expect(storedAnswers(v.id)).toHaveLength(4);
    expect(refsOf(w.userId, w.examId, w.doc1)).toHaveLength(2);
  });

  it("a wrong answer given in round 2 to a question answered RIGHT in round 1 cannot happen: that question has no round-2 copy to answer", () => {
    const w = world();
    const v = reviewOf(w, 2);
    ans(w.userId, v.id, 0, rightIdx(v.id, 0));
    ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    expect(stored(v.id).filter((q) => q.question === stored(v.id)[0].question)).toHaveLength(1);
    expect(() => answerQuizMe({ userId: w.userId, id: v.id, index: 3, chosen: 0 })).toThrow(); // beyond the list
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the round cap", () => {
  it("exactly REVIEW_MAX_ROUNDS rounds, never a sixth; the fifth finished with a miss finishes the review (finished_at set) and the miss is still a miss", () => {
    const w = world();
    const v = reviewOf(w, 1);
    for (let at = 0; at < REVIEW_MAX_ROUNDS - 1; at++) {
      expect(ans(w.userId, v.id, at, wrongIdx(v.id, at))).toMatchObject({ finished: false });
      expect(row(v.id).finished_at).toBeNull();
      expect(getQuizMe(w.userId, v.id)).toMatchObject({ round: at + 2, left: 1, finished: false });
    }
    expect(stored(v.id).map((q) => q.round)).toEqual([1, 2, 3, 4, 5]);
    expect(ans(w.userId, v.id, 4, wrongIdx(v.id, 4))).toMatchObject({ correct: false, finished: true });
    expect(row(v.id).finished_at).not.toBeNull();
    expect(stored(v.id)).toHaveLength(REVIEW_MAX_ROUNDS);
    expect(getQuizMe(w.userId, v.id)).toMatchObject({ round: 5, left: 0, finished: true });
    // never retired: the next review of the lecture asks it again, from round 1
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quiz:${w.t1}:0`]);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toMatchObject({ missed: 1, open: null });
    const next = openLectureReview(w.userId, w.examId, w.doc1);
    expect(next.id).not.toBe(v.id);
    expect(next).toMatchObject({ round: 1, left: 1 });
  });

  it("a right answer in round 5 finishes the review and retires the miss", () => {
    const w = world();
    const v = reviewOf(w, 1);
    for (let at = 0; at < REVIEW_MAX_ROUNDS - 1; at++) ans(w.userId, v.id, at, wrongIdx(v.id, at));
    expect(ans(w.userId, v.id, 4, rightIdx(v.id, 4))).toMatchObject({ correct: true, finished: true });
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toEqual({ missed: 0, open: null });
  });

  it("round 5 with two questions: the round only finishes once both are answered; one right + one wrong ends the review with one miss left", () => {
    const w = world();
    const v = reviewOf(w, 2);
    let at = 0;
    for (let round = 1; round < REVIEW_MAX_ROUNDS; round++) {
      ans(w.userId, v.id, at, wrongIdx(v.id, at));
      ans(w.userId, v.id, at + 1, wrongIdx(v.id, at + 1));
      at += 2;
    }
    expect(stored(v.id)).toHaveLength(10);
    expect(ans(w.userId, v.id, 8, rightIdx(v.id, 8))).toMatchObject({ correct: true, finished: false });
    expect(row(v.id).finished_at).toBeNull();
    expect(ans(w.userId, v.id, 9, wrongIdx(v.id, 9))).toMatchObject({ correct: false, finished: true });
    expect(stored(v.id)).toHaveLength(10);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([stored(v.id)[9].ref]);
  });

  it("a quiz-me (highlight) quiz never gets a round, whatever the misses; its answers and left behave as before", () => {
    const w = world();
    const id = highlightQuiz(w.userId, w.examId, w.t1, 4, null);
    for (let i = 0; i < 3; i++) expect(ans(w.userId, id, i, 1)).toMatchObject({ finished: false });
    expect(ans(w.userId, id, 3, 1)).toMatchObject({ finished: true });
    expect(stored(id)).toHaveLength(4);
    expect(stored(id).every((q) => q.round === undefined)).toBe(true);
    expect(getQuizMe(w.userId, id)).toMatchObject({ round: 1, kind: "highlight", left: 0, finished: true });
    expect(getQuizMe(w.userId, id)!.questions.every((q) => q.round === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the view of a review with rounds", () => {
  it("round-2 questions unanswered carry no key/explanation/notes; answered ones do; round on the quiz = the latest, on each question its own; left counts across rounds", () => {
    const w = world();
    const v = reviewOf(w, 3);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, rightIdx(v.id, 1));
    ans(w.userId, v.id, 2, wrongIdx(v.id, 2));
    const view = getQuizMe(w.userId, v.id)!;
    expect(view.round).toBe(2);
    expect(view.questions.map((q) => q.round)).toEqual([1, 1, 1, 2, 2]);
    expect(view.left).toBe(2);
    for (const q of view.questions.slice(3)) {
      expect(q.chosen).toBeNull();
      expect(q).not.toHaveProperty("correct_index");
      expect(q).not.toHaveProperty("explanation");
      expect(q).not.toHaveProperty("option_notes");
    }
    for (const q of view.questions.slice(0, 3)) expect(q.correct_index).toBeDefined();
    expect(view.answers).toEqual([...storedAnswers(v.id)]);
    // the HTTP view says the same, and also never leaks the key of an open round-2 question
    signIn(w.userId);
    return quizmeGET(new Request("http://x/api"), ctx(v.id)).then(async (res) => {
      const body = (await res.json()) as { questions: Record<string, unknown>[]; round: number };
      expect(body.round).toBe(2);
      expect(JSON.stringify(body.questions.slice(3))).not.toMatch(/correct_index|explanation|because/);
    });
  });

  it("answering through the route: the round-closing answer says finished:false and the refetched quiz holds the new round", async () => {
    const w = world();
    const v = reviewOf(w, 1);
    signIn(w.userId);
    const res = await quizmeAnswerPOST(post({ index: 0, chosen: wrongIdx(v.id, 0) }), ctx(v.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ correct: false, finished: false });
    expect(getQuizMe(w.userId, v.id)).toMatchObject({ round: 2, left: 1 });
  });

  it("old rows without `round`: view says round 1 everywhere, and a wrong answer appends a proper round 2", () => {
    const w = world();
    const id = lectureRow(w, [{}, { question: "hand question 1?" }], [null, null]);
    expect(stored(id).every((q) => q.round === undefined)).toBe(true);
    const view = getQuizMe(w.userId, id)!;
    expect(view.round).toBe(1);
    expect(view.questions.map((q) => q.round)).toEqual([1, 1]);
    ans(w.userId, id, 0, rightIdx(id, 0));
    expect(ans(w.userId, id, 1, wrongIdx(id, 1))).toMatchObject({ correct: false, finished: false });
    expect(stored(id)).toHaveLength(3);
    expect(stored(id)[2]).toMatchObject({ question: "hand question 1?", round: 2 });
    expect(getQuizMe(w.userId, id)).toMatchObject({ round: 2, left: 1 });
    expect(ans(w.userId, id, 2, rightIdx(id, 2))).toMatchObject({ correct: true, finished: true });
  });

  it("a round value that is odd in the stored row (0, null, a string) reads as round 1 and does not crash the view or the answer", () => {
    const w = world();
    const id = lectureRow(w, [{ round: 0 }, { round: null as unknown as number }], [null, null]);
    expect(() => getQuizMe(w.userId, id)).not.toThrow();
    expect(getQuizMe(w.userId, id)!.round).toBeGreaterThanOrEqual(1);
    expect(() => ans(w.userId, id, 0, wrongIdx(id, 0))).not.toThrow();
    expect(() => ans(w.userId, id, 1, wrongIdx(id, 1))).not.toThrow();
  });

  it("round 2 index answered while round 1 still has an unanswered question (hand-edited data): no crash, not finished, no copies yet", () => {
    const w = world();
    const id = lectureRow(w, [{ round: 1 }, { round: 1 }, { round: 2, question: "hand question 0?" }], [null, null, null]);
    expect(ans(w.userId, id, 2, wrongIdx(id, 2))).toMatchObject({ correct: false, finished: false });
    expect(stored(id)).toHaveLength(3); // round 1 is still open: nothing is appended
    expect(getQuizMe(w.userId, id)).toMatchObject({ left: 2, finished: false });
  });

  it("(documented) hand-edited data: round 1 left open while round 2 is answered wrong and then round 1 completes: only the LATEST round's misses come back", () => {
    const w = world();
    const id = lectureRow(w, [{ round: 1 }, { round: 1 }, { round: 2, question: "hand question 0?" }], [null, null, null]);
    ans(w.userId, id, 2, wrongIdx(id, 2));
    ans(w.userId, id, 0, wrongIdx(id, 0));
    ans(w.userId, id, 1, wrongIdx(id, 1));
    // by construction this cannot happen in real data; the outcome is only pinned so a change is noticed
    expect(stored(id).slice(3).map((q) => q.round)).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("misses, status and the section quizzes while rounds are open", () => {
  it("lectureMisses ignores review rows (it reads quiz_answers and highlight quizzes only); status.missed is the open review's left, round-2 copies included", () => {
    const w = world();
    const v = reviewOf(w, 3);
    const before = refsOf(w.userId, w.examId, w.doc1);
    expect(before).toHaveLength(3);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, rightIdx(v.id, 1));
    ans(w.userId, v.id, 2, wrongIdx(v.id, 2));
    // the two copies sit in the review; the misses are the two still wrong, each once (the copies do not double them)
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([before[0], before[2]]);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toMatchObject({ missed: 2, open: { id: v.id, round: 2, left: 2 } });
    // a brand new miss in the meantime is not in the open review's count
    recordQuizAnswer(w.userId, w.t2, 2, 1, false);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1).missed).toBe(2);
    expect(openLectureReview(w.userId, w.examId, w.doc1).id).toBe(v.id);
  });

  it("a miss that came from a quiz-me quiz: a right answer in round 2 retires it, by ref and by text, so the highlight quiz's wrong answer is gone from the misses", () => {
    const w = world();
    const hl = highlightQuiz(w.userId, w.examId, w.t1, 2, 1, "src");
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    expect(stored(v.id).map((q) => q.ref)).toEqual([`quizme:${hl}:0`, `quizme:${hl}:1`]);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    expect(refsOf(w.userId, w.examId, w.doc1)).toHaveLength(2);
    ans(w.userId, v.id, 2, rightIdx(v.id, 2));
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([`quizme:${hl}:1`]);
    ans(w.userId, v.id, 3, rightIdx(v.id, 3));
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
  });

  it("concept mastery: wrong in round 1 then right in round 2 records two results (2 attempts, 1 correct); each round answer counts once", () => {
    const w = world();
    const v = reviewOf(w, 1);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    expect(conceptRow(w.userId, "C")).toEqual({ attempts: 1, correct: 0 });
    ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    ans(w.userId, v.id, 1, rightIdx(v.id, 1)); // repeat of an answered question records nothing
    expect(conceptRow(w.userId, "C")).toEqual({ attempts: 2, correct: 0 });
    ans(w.userId, v.id, 2, rightIdx(v.id, 2));
    expect(conceptRow(w.userId, "C")).toEqual({ attempts: 3, correct: 1 });
  });

  it("the other student's review / misses are untouched, and she cannot answer the first student's round-2 question", () => {
    const w = world();
    const other = world(apiReadyUser());
    const v = reviewOf(w, 1);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    expect(answerQuizMe({ userId: other.userId, id: v.id, index: 1, chosen: 0 })).toBeNull();
    expect(getQuizMe(other.userId, v.id)).toBeNull();
    expect(lectureReviewStatus(other.userId, other.examId, other.doc1)).toEqual({ missed: 0, open: null });
    expect(storedAnswers(v.id)).toHaveLength(2);
    expect(storedAnswers(v.id)[1]).toBeNull();
  });

  it("openQuizMe (resume a quiz me) never returns a lecture review with rounds", () => {
    const w = world();
    reviewOf(w, 2);
    expect(openQuizMe(w.userId, w.examId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("reporting with rounds", () => {
  it("reporting a round-2 copy hides every copy of that question (the round-1 original too, so it leaves the first-pass score); the source is hidden and the miss never returns; the quiz finishes", async () => {
    const w = world();
    const v = reviewOf(w, 2);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, rightIdx(v.id, 1));
    // round 2 = [copy of q0] at index 2
    signIn(w.userId);
    const res = await quizmeReportPOST(post({ index: 2, reason: "bad" }), ctx(v.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quiz: { questions: { hidden?: boolean; chosen: number | null }[]; left: number; finished: boolean } };
    expect(body.quiz.questions.map((q) => !!q.hidden)).toEqual([true, false, true]);
    expect(body.quiz.questions[0].chosen).toBe(storedAnswers(v.id)[0]); // the original keeps its (wrong) answer, hidden
    expect(body.quiz).toMatchObject({ left: 0, finished: true });
    expect(row(v.id).finished_at).not.toBeNull();
    // the section quiz's question is hidden at the source; the miss does not return
    expect((JSON.parse(w.topicRow(w.t1).checks_json!) as QuizQuestion[]).map((q) => !!q.hidden)).toEqual([true, false, false]);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
    expect(lectureReviewStatus(w.userId, w.examId, w.doc1)).toEqual({ missed: 0, open: null });
    // recorded against the copy's own index
    expect(listReportedQuestions()[0]).toMatchObject({ source: "lecture_review", ref: `quizme:${v.id}:2` });
  });

  it("reporting a round-2 copy of a quiz-me miss hides the question in the highlight quiz too", async () => {
    const w = world();
    const hl = highlightQuiz(w.userId, w.examId, w.t1, 1, 1, "src");
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    signIn(w.userId);
    expect((await quizmeReportPOST(post({ index: 1 }), ctx(v.id))).status).toBe(200);
    expect((JSON.parse(row(hl).questions_json) as QuizMeQuestion[])[0].hidden).toBe(true);
    expect(refsOf(w.userId, w.examId, w.doc1)).toEqual([]);
  });

  // A section-quiz miss carries source_qid, and hideQuizQuestionEverywhere also hides the open review's questions by it, so
  // the round-2 copy of a reported round-1 question goes too. (This is why the quiz-me case below is a bug.)
  it("reporting a round-1 question after its round-2 copy exists hides the copy too when the miss came from a section quiz (source_qid)", async () => {
    const w = world();
    const v = reviewOf(w, 2);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    signIn(w.userId);
    expect((await quizmeReportPOST(post({ index: 0, reason: "wrong key" }), ctx(v.id))).status).toBe(200);
    const view = getQuizMe(w.userId, v.id)!;
    expect(view.questions.map((q) => !!q.hidden)).toEqual([true, false, true, false]);
    expect(view.left).toBe(1);
  });

  // Same, but the miss came from a "quiz me" quiz: such a question has NO source_qid (lectureMisses strips it), so only
  // the single reported index WAS hidden (fixed: hideQuizMeQuestion now hides every copy, by ref or text). Reachable from the panel: after the last answer of round 1 the quiz is refetched
  // (round 2 now exists) while the panel still shows that answered round-1 question, whose Report button is live.
  // Input: quiz me [h0, h1] both answered wrong; review [h0, h1]; both wrong → round 2 = [h0', h1'] (indexes 2, 3);
  // report index 0. Wrong output: index 2 (copy of the reported h0) stays visible: hidden=false, left=2, still asked in
  // round 2 (src/lib/quizMe.ts hideQuizMeQuestion: `questions[index] = { ...q, hidden: true }`, no copies of it hidden).
  it("fixed: reporting a round-1 question from a quiz-me miss after its round-2 copy exists leaves the copy open (the reported question is asked again)", async () => {
    const w = world();
    highlightQuiz(w.userId, w.examId, w.t1, 2, 1, "src");
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    signIn(w.userId);
    expect((await quizmeReportPOST(post({ index: 0, reason: "wrong key" }), ctx(v.id))).status).toBe(200);
    const view = getQuizMe(w.userId, v.id)!;
    expect(view.questions[0].hidden).toBe(true);
    expect(view.questions[2].hidden).toBe(true); // the copy of the reported question
    expect(view.left).toBe(1);
  });

  // Same defect when the copy is the only thing left. Input: quiz me [h0] wrong; review [h0]; wrong → round 2 = [h0'];
  // report index 0. Wrong output: left=1, finished=false: the reported question is the one thing still to answer.
  it("fixed: reporting the only round-1 question (a quiz-me miss) leaves its round-2 copy as the one question still to answer", async () => {
    const w = world();
    highlightQuiz(w.userId, w.examId, w.t1, 1, 1, "src");
    const v = openLectureReview(w.userId, w.examId, w.doc1);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    signIn(w.userId);
    await quizmeReportPOST(post({ index: 0 }), ctx(v.id));
    expect(getQuizMe(w.userId, v.id)).toMatchObject({ left: 0, finished: true });
  });

  // hideQuizMeQuestion only stamped finished_at; it never opened the next round, so the outcome depended on the ORDER of
  // the same two actions (fixed: both paths go through settle()). Input: review [q0, q1]. (a) report q1, then answer q0 wrong: round 2 = [q0'], not finished.
  // (b) answer q0 wrong, then report q1: finished=true, no round 2 (q0 is never re-asked this session).
  it("fixed: answering one wrong then reporting the other question ends the review without a second round, but the reverse order opens one", () => {
    const a = world();
    const va = reviewOf(a, 2);
    hideQuizMeQuestion(a.userId, va.id, 1);
    ans(a.userId, va.id, 0, wrongIdx(va.id, 0));
    expect(getQuizMe(a.userId, va.id)).toMatchObject({ round: 2, left: 1, finished: false });
    const b = world();
    const vb = reviewOf(b, 2);
    ans(b.userId, vb.id, 0, wrongIdx(vb.id, 0));
    hideQuizMeQuestion(b.userId, vb.id, 1);
    expect(getQuizMe(b.userId, vb.id)).toMatchObject({ round: 2, left: 1, finished: false });
  });

  it("(documented) hiding the last unanswered question of round 2 when round-1 answers exist stamps finished_at (something was answered); hiding with nothing answered does not", () => {
    const w = world();
    const v = reviewOf(w, 2);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, rightIdx(v.id, 1));
    expect(row(v.id).finished_at).toBeNull();
    hideQuizMeQuestion(w.userId, v.id, 2); // the only round-2 copy
    expect(row(v.id).finished_at).not.toBeNull();
    // nothing answered at all: the row is left open (status closes it lazily)
    const n = world();
    const vn = reviewOf(n, 2);
    hideQuizMeQuestion(n.userId, vn.id, 0);
    hideQuizMeQuestion(n.userId, vn.id, 1);
    expect(row(vn.id).finished_at).toBeNull();
    expect(lectureReviewStatus(n.userId, n.examId, n.doc1)).toEqual({ missed: 0, open: null });
  });

  it("reporting an index beyond the list, a negative one, a second time, or on someone else's review changes nothing", async () => {
    const w = world();
    const v = reviewOf(w, 1);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    const before = row(v.id).questions_json;
    signIn(w.userId);
    for (const index of [2, 99, -1]) expect((await quizmeReportPOST(post({ index }), ctx(v.id))).status).toBe(404);
    expect((await quizmeReportPOST(post({ index: 1 }), ctx(v.id))).status).toBe(200);
    expect((await quizmeReportPOST(post({ index: 1 }), ctx(v.id))).status).toBe(404);
    signIn(apiReadyUser());
    expect((await quizmeReportPOST(post({ index: 0 }), ctx(v.id))).status).toBe(404);
    expect(JSON.parse(before)).toHaveLength(2);
  });

  it("a quiz whose round-2 copies are all reported reads as round 1 again (hidden questions don't count), so the panel never shows an empty round", async () => {
    const w = world();
    const v = reviewOf(w, 2);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    ans(w.userId, v.id, 1, wrongIdx(v.id, 1));
    hideQuizMeQuestion(w.userId, v.id, 2);
    hideQuizMeQuestion(w.userId, v.id, 3);
    const view = getQuizMe(w.userId, v.id)!;
    expect(view).toMatchObject({ round: 1, left: 0, finished: true });
    expect(view.questions.map((q) => !!q.hidden)).toEqual([true, true, true, true]); // the originals go with their copies
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("marks on quiz-me questions", () => {
  const put = (key: unknown, marks: unknown = { hl: { stem: [[0, 4]] }, crossed: [1] }) => marksPUT(new Request("http://x/api/marks", { method: "PUT", body: JSON.stringify({ key, marks }) }));
  const get = (key: string) => marksGET(new Request(`http://x/api/marks?key=${encodeURIComponent(key)}`));

  it("the key pattern: quizme:<id>:<index> up to 4 digits of index and 12 of id; nothing else", () => {
    for (const ok of ["quizme:1:0", "quizme:123456789012:9999", "quizme:7:12"]) expect(MARKS_KEY.test(ok), ok).toBe(true);
    for (const bad of ["quizme:1:10000", "quizme:1:-1", "quizme:1", "quizme::1", "quizme:a:1", "quizme:1:2:3", "quizme:1234567890123:1", "quizme:1:1 ", " quizme:1:1", "quizme:1:1\n", "QUIZME:1:1", "quizme:1.5:1", "quizme:1:1e3"])
      expect(MARKS_KEY.test(bad), JSON.stringify(bad)).toBe(false);
  });

  it("the signed-in student can save, read and clear marks on a quiz-me / review question (round-2 copies too); another student reads nothing of hers", async () => {
    const w = world();
    const v = reviewOf(w, 1);
    ans(w.userId, v.id, 0, wrongIdx(v.id, 0));
    const key = `quizme:${v.id}:1`;
    signIn(w.userId);
    expect((await put(key)).status).toBe(200);
    expect(await (await get(key)).json()).toMatchObject({ marks: { hl: { stem: [[0, 4]] }, crossed: [1] } });
    signIn(apiReadyUser());
    expect(await (await get(key)).json()).toEqual({ marks: null, updated_at: null });
    // her own marks on the same key do not touch the first student's
    expect((await put(key, { hl: {}, crossed: [3] })).status).toBe(200);
    signIn(w.userId);
    expect(await (await get(key)).json()).toMatchObject({ marks: { crossed: [1] } });
    // empty marks delete the row
    expect((await put(key, { hl: {}, crossed: [] })).status).toBe(200);
    expect((await (await get(key)).json()).marks).toBeNull();
  });

  it("an index above 9999, a negative or malformed key, and a signed-out request are refused", async () => {
    signIn(apiReadyUser());
    expect((await put("quizme:5:10000")).status).toBe(400);
    expect((await put("quizme:5:9999")).status).toBe(200);
    expect((await put("quizme:5:-1")).status).toBe(400);
    expect((await put("quizme:5")).status).toBe(400);
    expect((await put(5)).status).toBe(400);
    expect((await put(null)).status).toBe(400);
    expect((await get("quizme:5:10000")).status).toBe(400);
    signIn(null);
    expect((await put("quizme:5:1")).status).toBe(401);
    expect((await get("quizme:5:1")).status).toBe(401);
  });

  it("fields on a quiz-me question: only stem / opt0-9 highlights and crossed 0-9 survive; bad marks are 400", async () => {
    signIn(apiReadyUser());
    expect((await put("quizme:5:2", { hl: { stem: [[0, 3]], opt3: [[1, 2]], evil: [[0, 1]], case: [[0, 1]] }, crossed: [0, 12, -1, "x"] })).status).toBe(200);
    const body = (await (await get("quizme:5:2")).json()) as { marks: { hl: Record<string, unknown>; crossed: number[] } };
    expect(Object.keys(body.marks.hl).sort()).toEqual(["case", "opt3", "stem"]);
    expect(body.marks.crossed).toEqual([0]);
    expect((await put("quizme:5:2", "nope")).status).toBe(400);
  });

  it("(documented) a key for a quiz that does not exist, or is another student's, is accepted: marks are stored per student and never read back across students", async () => {
    const w = world();
    const v = reviewOf(w, 1);
    const stranger = apiReadyUser();
    signIn(stranger);
    expect((await put(`quizme:${v.id}:0`)).status).toBe(200); // not her quiz: stored under her own account only
    expect((await put("quizme:999999999:0")).status).toBe(200);
    signIn(w.userId);
    expect((await (await get(`quizme:${v.id}:0`)).json()).marks).toBeNull();
  });
});
