import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addSharedExam, createClass, flagQuestionEverywhere, joinClass, leaveClass, shareExam, sharedImageDirs } from "@/lib/classes";
import { upsertConcept } from "@/lib/memory";
import { makeUser } from "./helpers";

/** An exam with one processed lecture (3 slides), one topic, a lesson, a recall question and a 2-question case. */
function makeProcessedExam(userId: number) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, exam_date, topic_status) VALUES (?, 'Endo', '2030-01-01', 'ready')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, 'Pulp', 3, 'done')").run(examId).lastInsertRowid);
  const pages = [1, 2, 3].map((n) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, text, image_path, status, title, notes_json) VALUES (?, ?, 'text', ?, 'done', 'Slide', ?)")
        .run(docId, n, `doc-${docId}/p${n}.jpg`, JSON.stringify({ abbreviations: [{ abbr: "SIP", meaning: "symptomatic irreversible pulpitis" }] })).lastInsertRowid,
    ),
  );
  for (const p of pages) db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, 'Slide', 'pulpitis')").run(p);
  const topicId = Number(
    db
      .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, lesson_json) VALUES (?, 0, 'Pulpitis', 's', ?, ?)")
      .run(examId, JSON.stringify(pages), JSON.stringify({ slides: [{ page_id: pages[1], caption: "c" }] })).lastInsertRowid,
  );
  const conceptId = upsertConcept(userId, "Pulpitis");
  db.prepare("UPDATE concepts SET attempts = 5, correct = 1 WHERE id = ?").run(conceptId);
  db.prepare("INSERT INTO topic_concepts VALUES (?, ?)").run(topicId, conceptId);
  const q = (caseId: number | null) =>
    Number(
      db
        .prepare(
          `INSERT INTO questions (exam_id, topic_id, concept_id, type, stem, options, correct_index, explanation, source_page_id, image_page_id, case_id)
           VALUES (?, ?, ?, ?, 'stem', '["a","b"]', 0, 'e', ?, ?, ?)`,
        )
        .run(examId, topicId, conceptId, caseId ? "case" : "recall", pages[0], caseId ? pages[2] : null, caseId).lastInsertRowid,
    );
  const recall = q(null);
  const caseId = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, 'A patient', '{}', ?)").run(examId, pages[2]).lastInsertRowid);
  const caseQs = [q(caseId), q(caseId)];
  return { examId, docId, pages, topicId, recall, caseQs };
}

describe("classes and shared exams", () => {
  it("copies a shared exam with remapped slides, lessons, concepts and questions, but no progress", () => {
    const a = makeUser();
    const b = makeUser();
    const src = makeProcessedExam(a);
    const classId = createClass(a, "Class of 2030");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    expect(joinClass(b, code.toLowerCase())?.id).toBe(classId);
    expect(shareExam(a, classId, src.examId)).toBeNull();
    const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(src.examId) as { id: number }).id;

    const res = addSharedExam(b, sharedId);
    expect("examId" in res).toBe(true);
    const copyId = (res as { examId: number }).examId;
    expect(db.prepare("SELECT user_id, source_exam_id, topic_status FROM exams WHERE id = ?").get(copyId)).toEqual({ user_id: b, source_exam_id: src.examId, topic_status: "ready" });

    const copyPages = (db.prepare("SELECT p.id, p.image_path FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ? ORDER BY p.page_number").all(copyId) as {
      id: number;
      image_path: string;
    }[]);
    expect(copyPages.map((p) => p.image_path)).toEqual([1, 2, 3].map((n) => `doc-${src.docId}/p${n}.jpg`)); // images shared, not duplicated
    const topic = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(copyId) as { id: number; page_ids: string; lesson_json: string };
    expect(JSON.parse(topic.page_ids)).toEqual(copyPages.map((p) => p.id));
    expect(JSON.parse(topic.lesson_json).slides[0].page_id).toBe(copyPages[1].id);

    const concept = db.prepare("SELECT c.user_id, c.attempts FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?").get(topic.id);
    expect(concept).toEqual({ user_id: b, attempts: 0 }); // classmate's mastery is their own
    const qs = db.prepare("SELECT * FROM questions WHERE exam_id = ? ORDER BY id").all(copyId) as { source_page_id: number; case_id: number | null; root_question_id: number }[];
    expect(qs).toHaveLength(3);
    expect(qs.every((q) => copyPages.some((p) => p.id === q.source_page_id))).toBe(true);
    expect(new Set(qs.filter((q) => q.case_id).map((q) => q.case_id)).size).toBe(1);
    expect(qs.map((q) => q.root_question_id)).toEqual([src.recall, ...src.caseQs]);
    expect(db.prepare("SELECT meaning FROM glossary WHERE user_id = ? AND abbr = 'SIP'").get(b)).toBeTruthy();

    // Adding again returns the same copy.
    expect(addSharedExam(b, sharedId)).toEqual({ examId: copyId });
    // Images used by the copy are protected if the original owner is removed.
    expect(sharedImageDirs([src.docId], a).has(src.docId)).toBe(true);
  });

  it("only members can add shared exams; non-ready exams can't be shared", () => {
    const a = makeUser();
    const outsider = makeUser();
    const src = makeProcessedExam(a);
    const classId = createClass(a, "Private");
    shareExam(a, classId, src.examId);
    const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(src.examId) as { id: number }).id;
    expect("error" in addSharedExam(outsider, sharedId)).toBe(true);
    db.prepare("UPDATE exams SET topic_status = 'building' WHERE id = ?").run(src.examId);
    expect(shareExam(a, classId, src.examId)).toMatch(/topic map/);
    expect(shareExam(outsider, classId, src.examId)).toMatch(/not in that class/);
  });

  it("a reported question is hidden in the original and every copy", () => {
    const a = makeUser();
    const b = makeUser();
    const src = makeProcessedExam(a);
    const classId = createClass(a, "Flags");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    joinClass(b, code);
    shareExam(a, classId, src.examId);
    const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(src.examId) as { id: number }).id;
    const copyId = (addSharedExam(b, sharedId) as { examId: number }).examId;
    const copyRecall = (db.prepare("SELECT id FROM questions WHERE exam_id = ? AND root_question_id = ?").get(copyId, src.recall) as { id: number }).id;
    flagQuestionEverywhere(copyRecall, "wrong answer");
    expect((db.prepare("SELECT flagged FROM questions WHERE id = ?").get(src.recall) as { flagged: number }).flagged).toBe(1);
    expect((db.prepare("SELECT flagged FROM questions WHERE id = ?").get(copyRecall) as { flagged: number }).flagged).toBe(1);
    expect((db.prepare("SELECT flagged FROM questions WHERE id = ?").get(src.caseQs[0]) as { flagged: number }).flagged).toBe(0);
  });

  it("leaving removes your shares; the owner leaving deletes the class", () => {
    const a = makeUser();
    const b = makeUser();
    const classId = createClass(a, "Temp");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    joinClass(b, code);
    const srcB = makeProcessedExam(b);
    shareExam(b, classId, srcB.examId);
    leaveClass(b, classId);
    expect(db.prepare("SELECT 1 FROM shared_exams WHERE class_id = ?").get(classId)).toBeUndefined();
    leaveClass(a, classId);
    expect(db.prepare("SELECT 1 FROM classes WHERE id = ?").get(classId)).toBeUndefined();
  });
});
