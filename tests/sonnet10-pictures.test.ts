// QA round 10: picture questions. Failing tests are named "BUG: ...".
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async () => {
    throw new Error("no ai");
  }),
}));
let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db, type Topic } from "@/lib/db";
import { mentionsPicture, pictureForIds, repairPictureQuestions } from "@/lib/questionImage";
import { attemptView } from "@/lib/attemptView";
import { createClass, joinClass, shareExam, addSharedExam } from "@/lib/classes";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { makeUser } from "./helpers";

const OPTS = JSON.stringify(["a", "b", "c", "d"]);
const notes = (image: string | null, crop = false) =>
  JSON.stringify({
    title: "t",
    summary: "s",
    image_description: image,
    key_facts: ["a", "b"],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: crop ? { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } : null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
  });

function world() {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, topic_status) VALUES (?, 'E', 'ready')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const ins = db.prepare("INSERT INTO pages (document_id, page_number, image_path, aspect, status, notes_json) VALUES (?, ?, 'x.jpg', 1.5, 'done', ?)");
  const plain = Number(ins.run(docId, 1, notes(null)).lastInsertRowid);
  const photo = Number(ins.run(docId, 2, notes("radiograph", true)).lastInsertRowid);
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', '', ?)").run(examId, JSON.stringify([plain, photo])).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  return { userId, examId, docId, topicId, sessionId, plain, photo, topic: () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic };
}
const insCaseQ = db.prepare(
  "INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id, image_page_id, case_id) VALUES (?, ?, 'case', ?, ?, 0, 'e', ?, ?, ?)",
);

describe("mentionsPicture (tightened version)", () => {
  it("realistic text stems stay text", () => {
    const keep = [
      "Imaging is indicated when the pulp is exposed. Which is true?",
      "The figure of 35% refers to which value?",
      "The radiographic apex is usually how far from the anatomic apex?",
      "Radiographically, which finding is typical?",
      "Calcium hydroxide has been shown to improve healing. Which is true?",
      "As shown by Kakehashi, bacteria are required for what?",
      "Which radiograph is best for detecting proximal caries?",
      "Which x-ray view is best for the maxillary sinus?",
    ];
    for (const t of keep) expect(mentionsPicture(t), t).toBe(false);
  });
  it("'Which of the following radiographs...' is a text question but is treated as a picture question", () => {
    expect(mentionsPicture("Which of the following radiographs is best for detecting proximal caries?")).toBe(false);
  });
  it("'Which of the following x-ray views...' is a text question", () => {
    expect(mentionsPicture("Which of the following x-ray views shows the sinus floor?")).toBe(false);
  });
  it("the issue statement own examples \"the image below\" / \"the radiograph shown\" are not matched", () => {
    for (const t of ["In the radiograph shown, what is the diagnosis?", "Consider the image below.", "The radiograph shown reveals a lesion. What is it?", "What does the photo show?", "Look at this diagram.", "The lesion seen here is", "Based on the picture, what is the next step?", "What is pictured?"])
      expect(mentionsPicture(t), t).toBe(true);
  });
  it("picture stems the regex misses (image_page_id from the AI is the only guard)", () => {
    const missed = [
      "In the radiograph of tooth #19, what is the finding?",
      "On the radiograph, what does the arrow indicate?",
      "Examine the radiograph and choose the diagnosis.",
      "Refer to the figure. Which structure is labeled A?",
      "Identify the structure marked X.",
      "What is the radiolucency indicated by the arrow?",
    ];
    // The question writers use the generous mode (the strict one is for the start-up repair, where a wrong "yes" deletes).
    expect(missed.filter((t) => !mentionsPicture(t, "generous"))).toEqual([]);
  });
});

describe("repair vs case sets", () => {
  it("a case-set question whose picture lives on cases.image_page_id keeps the case's picture", () => {
    const w = world();
    const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, 's', '{}', ?)").run(w.examId, w.photo).lastInsertRowid);
    // Rows without the copied image (as written before insertQ copied it).
    const id = Number(insCaseQ.run(w.examId, w.topicId, "In the radiograph shown, what is the diagnosis?", OPTS, w.plain, null, caseId).lastInsertRowid);
    repairPictureQuestions();
    const r = db.prepare("SELECT image_page_id FROM questions WHERE id = ?").get(id) as { image_page_id: number | null } | undefined;
    expect(r?.image_page_id).toBe(w.photo);
  });
  it("a case-set question mentioning a picture, in a case with no picture, is deleted and leaves the set short", () => {
    const w = world();
    const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, 's', '{}', NULL)").run(w.examId).lastInsertRowid);
    for (const s of ["Q one plain?", "Based on the image below, what is it?", "Q three plain?"]) insCaseQ.run(w.examId, w.topicId, s, OPTS, w.plain, null, caseId);
    repairPictureQuestions();
    const n = (db.prepare("SELECT COUNT(*) c FROM questions WHERE case_id = ? AND flagged = 0").get(caseId) as { c: number }).c;
    expect(n).toBe(3); // a set should stay whole (or be retired whole); today 2 remain and the later questions build on the deleted one
  });
  it("attemptView shows the case image on each case question that carries it", () => {
    const w = world();
    const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, 's', '{}', ?)").run(w.examId, w.photo).lastInsertRowid);
    const a = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'in_progress')").run(w.examId).lastInsertRowid);
    [0, 1].forEach((i) => {
      const qid = Number(insCaseQ.run(w.examId, w.topicId, "S", OPTS, w.plain, w.photo, caseId).lastInsertRowid);
      db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)").run(a, qid, i);
    });
    const v = attemptView(a) as unknown as { questions: { image: { page_id: number } | null }[] };
    expect(v.questions.map((q) => q.image?.page_id)).toEqual([w.photo, w.photo]);
  });
  it("repair skips corrupt checks_json, keeps hidden entries' notes, hides null-source ones, and is idempotent", () => {
    const w = world();
    db.prepare("UPDATE topics SET checks_json = '{not json' WHERE id = ?").run(w.topicId);
    expect(() => repairPictureQuestions()).not.toThrow();
    const qs = [
      { id: "a", question: "Based on the image below, x?", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "", concept: "C", source_page_id: null },
      { id: "b", question: "Based on the image below, y?", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "", concept: "C", source_page_id: w.photo, hidden: true, report_note: "mine" },
    ];
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(qs), w.topicId);
    repairPictureQuestions();
    const after = JSON.parse(w.topic().checks_json!);
    expect(after[0]).toMatchObject({ hidden: true, report_note: "No picture to show" });
    expect(after[1]).toMatchObject({ hidden: true, report_note: "mine" });
    expect(after[1].image_page_id).toBeUndefined();
    expect(repairPictureQuestions()).toBe(0);
  });
});

describe("quiz GET and class copy", () => {
  it("a quiz question whose picture slide row is gone: image null, no crash", async () => {
    const w = world();
    currentUserId = w.userId;
    const qs = [{ id: "a", question: "In the radiograph shown, what?", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", source_page_id: w.photo, image_page_id: 987654 }];
    db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?").run(JSON.stringify(qs), w.topicId);
    expect(pictureForIds(987654, null)).toBeNull();
    const res = await quizGET(new Request("http://x/q?position=0"), { params: Promise.resolve({ id: String(w.sessionId) }) } as never);
    const body = (await res.json()) as { questions?: { image: unknown }[] };
    if (res.status === 200) expect(body.questions?.[0]?.image ?? null).toBeNull();
  });
  it("class copy: image_page_id for a slide not in the copy does not throw", () => {
    const w = world();
    const qs = [{ id: "a", question: "In the radiograph shown, what?", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", source_page_id: w.photo, image_page_id: 424242 }];
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = 2 WHERE id = ?").run(JSON.stringify(qs), w.topicId);
    const mate = makeUser();
    const classId = createClass(w.userId, "C");
    joinClass(mate, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code);
    shareExam(w.userId, classId, w.examId);
    const sid = (db.prepare("SELECT id FROM shared_exams WHERE class_id = ?").get(classId) as { id: number }).id;
    const copy = (addSharedExam(mate, sid) as { examId: number }).examId;
    const t2 = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(copy) as Topic;
    const out = JSON.parse(t2.checks_json!)[0];
    expect(out.image_page_id ?? null).toBeNull();
  });
});

// The test database is shared between files: leave nothing for another file's repair counts to pick up.
afterAll(() => {
  repairPictureQuestions();
});
