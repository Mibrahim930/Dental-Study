// Classes: students join with an invite code and share exams. Adding a shared exam copies the
// already-processed lectures (slide notes, topic map, lessons, question bank) into the classmate's
// account, so they pay nothing for slide reading. Progress, mastery and review stay per student.
import crypto from "crypto";
import { db, type Exam, type PageRow, type Question, type Topic } from "./db";
import { upsertConcept } from "./memory";
import { parseNotes } from "./processing";
import { rebuildPlan } from "./planner";

export type ClassRow = { id: number; name: string; invite_code: string; owner_id: number; created_at: string };

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newInviteCode(): string {
  for (;;) {
    const code = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    if (!db.prepare("SELECT 1 FROM classes WHERE invite_code = ?").get(code)) return code;
  }
}

export function isMember(userId: number, classId: number): boolean {
  return !!db.prepare("SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?").get(classId, userId);
}

export function createClass(userId: number, name: string): number {
  return db.transaction(() => {
    const id = Number(db.prepare("INSERT INTO classes (name, invite_code, owner_id) VALUES (?, ?, ?)").run(name, newInviteCode(), userId).lastInsertRowid);
    db.prepare("INSERT INTO class_members (class_id, user_id) VALUES (?, ?)").run(id, userId);
    return id;
  })();
}

export function joinClass(userId: number, code: string): ClassRow | null {
  const cls = db.prepare("SELECT * FROM classes WHERE invite_code = ?").get(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")) as ClassRow | undefined;
  if (!cls) return null;
  db.prepare("INSERT OR IGNORE INTO class_members (class_id, user_id) VALUES (?, ?)").run(cls.id, userId);
  return cls;
}

/** Leaving removes your shares from the class. If the owner leaves, the class is deleted. */
export function leaveClass(userId: number, classId: number) {
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId) as ClassRow | undefined;
  if (!cls) return;
  db.transaction(() => {
    if (cls.owner_id === userId) {
      db.prepare("DELETE FROM classes WHERE id = ?").run(classId);
    } else {
      db.prepare("DELETE FROM shared_exams WHERE class_id = ? AND shared_by = ?").run(classId, userId);
      db.prepare("DELETE FROM class_members WHERE class_id = ? AND user_id = ?").run(classId, userId);
    }
  })();
}

export function shareExam(userId: number, classId: number, examId: number): string | null {
  if (!isMember(userId, classId)) return "You're not in that class.";
  const exam = db.prepare("SELECT * FROM exams WHERE id = ? AND user_id = ?").get(examId, userId) as Exam | undefined;
  if (!exam) return "Exam not found.";
  if (exam.topic_status !== "ready") return "Wait until the exam's lectures are processed and its topic map is ready.";
  db.prepare("INSERT OR IGNORE INTO shared_exams (class_id, exam_id, shared_by) VALUES (?, ?, ?)").run(classId, examId, userId);
  return null;
}

/** Copy a shared exam into the user's account (or return their existing copy). */
export function addSharedExam(userId: number, sharedId: number): { examId: number } | { error: string } {
  const share = db.prepare("SELECT * FROM shared_exams WHERE id = ?").get(sharedId) as { class_id: number; exam_id: number } | undefined;
  if (!share || !isMember(userId, share.class_id)) return { error: "That shared exam isn't available to you." };
  const existing = db.prepare("SELECT id FROM exams WHERE user_id = ? AND (id = ? OR source_exam_id = ?)").get(userId, share.exam_id, share.exam_id) as
    | { id: number }
    | undefined;
  if (existing) return { examId: existing.id };
  const examId = copyExam(share.exam_id, userId);
  rebuildPlan(userId);
  return { examId };
}

function copyExam(sourceId: number, userId: number): number {
  const src = db.prepare("SELECT * FROM exams WHERE id = ?").get(sourceId) as Exam;
  return db.transaction(() => {
    const examId = Number(
      db
        .prepare("INSERT INTO exams (user_id, name, course, exam_date, kind, topic_status, source_exam_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(userId, src.name, src.course, src.exam_date, src.kind, src.topic_status === "ready" ? "ready" : "none", sourceId).lastInsertRowid,
    );

    // Lectures and slides (slide images are shared on disk, not duplicated).
    const pageMap = new Map<number, number>();
    const docs = db.prepare("SELECT * FROM documents WHERE exam_id = ? AND status = 'done'").all(sourceId) as {
      id: number;
      filename: string;
      page_count: number;
    }[];
    const insertDoc = db.prepare("INSERT INTO documents (exam_id, filename, page_count, status, backed_up) VALUES (?, ?, ?, 'done', 1)");
    const insertPage = db.prepare(
      `INSERT INTO pages (document_id, page_number, text, image_path, aspect, status, title, notes_json, emphasized, has_case)
       VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare("INSERT INTO pages_fts (page_id, title, content) SELECT ?, title, content FROM pages_fts WHERE page_id = ?");
    const gloss = db.prepare("INSERT OR IGNORE INTO glossary (user_id, abbr, meaning) VALUES (?, ?, ?)");
    for (const d of docs) {
      const docId = Number(insertDoc.run(examId, d.filename, d.page_count).lastInsertRowid);
      for (const p of db.prepare("SELECT * FROM pages WHERE document_id = ?").all(d.id) as PageRow[]) {
        const pageId = Number(insertPage.run(docId, p.page_number, p.text, p.image_path, p.aspect, p.title, p.notes_json, p.emphasized, p.has_case).lastInsertRowid);
        pageMap.set(p.id, pageId);
        insertFts.run(pageId, p.id);
        for (const a of parseNotes(p)?.abbreviations ?? []) gloss.run(userId, a.abbr.trim(), a.meaning.trim());
      }
    }
    const mapPage = (id: number | null) => (id != null ? (pageMap.get(id) ?? null) : null);

    // Topic map, lessons and concepts.
    const topicMap = new Map<number, number>();
    const conceptFor = new Map<number, number>();
    const insertTopic = db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, emphasized, lesson_json, checks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const t of db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(sourceId) as Topic[]) {
      const pages = (JSON.parse(t.page_ids) as number[]).map(mapPage).filter((x): x is number => x != null);
      let lesson = t.lesson_json;
      if (lesson) {
        const l = JSON.parse(lesson) as { slides: { page_id: number }[] };
        l.slides = l.slides.map((s) => ({ ...s, page_id: mapPage(s.page_id) ?? s.page_id }));
        lesson = JSON.stringify(l);
      }
      const topicId = Number(insertTopic.run(examId, t.position, t.title, t.summary, JSON.stringify(pages), t.emphasized, lesson, t.checks_json).lastInsertRowid);
      topicMap.set(t.id, topicId);
      for (const c of db.prepare("SELECT c.id, c.name FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?").all(t.id) as {
        id: number;
        name: string;
      }[]) {
        const mine = upsertConcept(userId, c.name);
        conceptFor.set(c.id, mine);
        db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(topicId, mine);
      }
    }

    // Question bank (unflagged), including case sets. Answers and attempts are not copied.
    const caseMap = new Map<number, number>();
    const insertCase = db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) SELECT ?, scenario, patient_box, ? FROM cases WHERE id = ?");
    const insertQ = db.prepare(
      `INSERT INTO questions (exam_id, topic_id, concept_id, type, patient_box, stem, options, correct_index, explanation, source_page_id, image_page_id, case_id, root_question_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const q of db.prepare("SELECT * FROM questions WHERE exam_id = ? AND flagged = 0").all(sourceId) as Question[]) {
      let caseId: number | null = null;
      if (q.case_id != null) {
        if (!caseMap.has(q.case_id)) {
          const img = (db.prepare("SELECT image_page_id FROM cases WHERE id = ?").get(q.case_id) as { image_page_id: number | null }).image_page_id;
          caseMap.set(q.case_id, Number(insertCase.run(examId, mapPage(img), q.case_id).lastInsertRowid));
        }
        caseId = caseMap.get(q.case_id)!;
      }
      insertQ.run(
        examId,
        q.topic_id != null ? (topicMap.get(q.topic_id) ?? null) : null,
        q.concept_id != null ? (conceptFor.get(q.concept_id) ?? null) : null,
        q.type,
        q.patient_box,
        q.stem,
        q.options,
        q.correct_index,
        q.explanation,
        mapPage(q.source_page_id),
        mapPage(q.image_page_id),
        caseId,
        q.root_question_id ?? q.id,
      );
    }
    return examId;
  })();
}

/** A reported question is hidden everywhere it was shared: the original and every classmate's copy. */
export function flagQuestionEverywhere(questionId: number, note: string | null) {
  const q = db.prepare("SELECT id, root_question_id FROM questions WHERE id = ?").get(questionId) as { id: number; root_question_id: number | null };
  const root = q.root_question_id ?? q.id;
  db.prepare("UPDATE questions SET flagged = 1, flag_note = COALESCE(flag_note, ?) WHERE id = ? OR root_question_id = ?").run(note, root, root);
}

/** Folders of slide images still used by someone else's copied exam (must not be deleted). */
export function sharedImageDirs(docIds: number[], ownerId: number): Set<number> {
  const keep = new Set<number>();
  for (const id of docIds) {
    const used = db
      .prepare(
        `SELECT 1 FROM pages p JOIN documents d ON d.id = p.document_id JOIN exams e ON e.id = d.exam_id
         WHERE p.image_path LIKE ? AND e.user_id != ? LIMIT 1`,
      )
      .get(`doc-${id}/%`, ownerId);
    if (used) keep.add(id);
  }
  return keep;
}
