import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cancel = vi.fn(async (...args: unknown[]) => void args);
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  cancelBatch: (c: unknown, id: string) => cancel(c, id),
  generate: vi.fn(async () => {
    throw new Error("no AI in these tests");
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
let signedIn: { id: number; api_key_enc: string; must_change_password: number; is_admin: number } | null = null;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => signedIn,
}));

import { db, FILES_DIR } from "@/lib/db";
import { removeDocument } from "@/lib/processing";
import { answerQuestion, finishAttempt, dueCards } from "@/lib/practice";
import { attemptView } from "@/lib/attemptView";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { DELETE } from "@/app/api/documents/[id]/route";
import { makeUser } from "./helpers";

type World = ReturnType<typeof world>;
/** Exam with two lectures (A: 3 slides, B: 3 slides). Topics: T0 = A only, T1 = A+B mixed, T2 = B only. */
function world(opts: { files?: boolean } = {}) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, topic_status) VALUES (?, 'E', 'ready')").run(userId).lastInsertRowid);
  const docs: { id: number; pages: number[] }[] = [];
  let pn = 0;
  for (const name of ["A", "B"]) {
    const id = Number(db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, ?, 3, 'done')").run(examId, name).lastInsertRowid);
    const pages = [1, 2, 3].map(() => {
      pn++;
      const pid = Number(
        db
          .prepare("INSERT INTO pages (document_id, page_number, text, image_path, status, title, notes_json) VALUES (?, ?, 't', ?, 'done', 'S', NULL)")
          .run(id, pn, `doc-${id}/p${pn}.jpg`).lastInsertRowid,
      );
      db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, 'S', 'zebra content')").run(pid);
      return pid;
    });
    if (opts.files) {
      fs.mkdirSync(path.join(FILES_DIR, `doc-${id}`), { recursive: true });
      fs.writeFileSync(path.join(FILES_DIR, `doc-${id}`, "original.pdf"), "x");
    }
    docs.push({ id, pages });
  }
  const [A, B] = docs;
  const topicDefs = [A.pages.slice(0, 2), [A.pages[2], B.pages[0]], B.pages.slice(1)];
  const topicIds = topicDefs.map((pages, i) =>
    Number(
      db
        .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, lesson_json, checks_json) VALUES (?, ?, ?, '', ?, ?, ?)")
        .run(examId, i, `T${i}`, JSON.stringify(pages), '{"x":1}', "[1]").lastInsertRowid,
    ),
  );
  return { userId, examId, A, B, topicIds };
}
function q(w: World, topicId: number, pageId: number | null, extra: { caseId?: number; image?: number | null } = {}) {
  return Number(
    db
      .prepare(
        "INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id, image_page_id, case_id) VALUES (?, ?, 'recall', 's', ?, 0, 'e', ?, ?, ?)",
      )
      .run(w.examId, topicId, '["a","b","c"]', pageId, extra.image ?? null, extra.caseId ?? null).lastInsertRowid,
  );
}
function attempt(examId: number, ids: number[], status = "ready") {
  const id = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', ?)").run(examId, status).lastInsertRowid);
  ids.forEach((x, i) => db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)").run(id, x, i));
  return id;
}
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const topicRows = (examId: number) =>
  db.prepare("SELECT id, position, page_ids, lesson_json, checks_json FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as {
    id: number;
    position: number;
    page_ids: string;
    lesson_json: string | null;
    checks_json: string | null;
  }[];

beforeEach(() => {
  cancel.mockClear();
  signedIn = null;
});

describe("removeDocument", () => {
  it("removes slides from topics, deletes emptied topics, renumbers, clears only changed caches", async () => {
    const w = world({ files: true });
    await removeDocument(w.A.id);
    const t = topicRows(w.examId);
    expect(t.map((x) => x.position)).toEqual([0, 1]);
    expect(t.map((x) => x.id)).toEqual([w.topicIds[1], w.topicIds[2]]); // T0 (A only) gone
    expect(JSON.parse(t[0].page_ids)).toEqual([w.B.pages[0]]);
    expect(t[0].lesson_json).toBeNull();
    expect(t[0].checks_json).toBeNull();
    expect(t[1].lesson_json).not.toBeNull(); // T2 untouched keeps its cache
    expect(count("SELECT COUNT(*) n FROM documents WHERE id = ?", w.A.id)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM pages WHERE document_id = ?", w.A.id)).toBe(0);
    expect(fs.existsSync(path.join(FILES_DIR, `doc-${w.A.id}`))).toBe(false);
    expect(fs.existsSync(path.join(FILES_DIR, `doc-${w.B.id}`))).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("deletes never-answered questions, keeps answered ones retired (flagged) with history intact", async () => {
    const w = world();
    const fresh = q(w, w.topicIds[0], w.A.pages[0]);
    const answered = q(w, w.topicIds[0], w.A.pages[1]);
    const viaImage = q(w, w.topicIds[2], w.B.pages[1], { image: w.A.pages[0] }); // other lecture's question using A's image
    const other = q(w, w.topicIds[2], w.B.pages[1]);
    const a = attempt(w.examId, [fresh, answered, other]);
    answerQuestion(a, answered, 1, "sure"); // wrong -> review card
    answerQuestion(a, other, 0, "sure");
    finishAttempt(a);
    expect(count("SELECT COUNT(*) n FROM review_cards")).toBeGreaterThanOrEqual(1);
    await removeDocument(w.A.id);
    expect(count("SELECT COUNT(*) n FROM questions WHERE id = ?", fresh)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM questions WHERE id = ?", viaImage)).toBe(0);
    const ans = db.prepare("SELECT flagged, flag_note, source_page_id FROM questions WHERE id = ?").get(answered) as {
      flagged: number;
      flag_note: string;
      source_page_id: number | null;
    };
    expect(ans.flagged).toBe(1);
    expect(ans.flag_note).toBe("Lecture removed");
    expect(ans.source_page_id).toBeNull();
    expect((db.prepare("SELECT flagged FROM questions WHERE id = ?").get(other) as { flagged: number }).flagged).toBe(0);
    // history still renders
    const v = attemptView(a)!;
    expect(v).not.toBeNull();
    expect(v.questions.length).toBe(2); // the never-answered one fell out of the attempt
    // retired answered question's review card never comes back
    expect(dueCards(w.userId, 50).some((c) => c.id === answered)).toBe(false);
  });

  it("DOCUMENTED: a FINISHED attempt's stored score keeps the old denominator after a skipped question is deleted", async () => {
    const w = world();
    const skipped = q(w, w.topicIds[0], w.A.pages[0]);
    const right = q(w, w.topicIds[2], w.B.pages[1]);
    const a = attempt(w.examId, [skipped, right]);
    answerQuestion(a, right, 0);
    finishAttempt(a); // 1/2 = 0.5
    await removeDocument(w.A.id);
    const n = count("SELECT COUNT(*) n FROM attempt_questions WHERE attempt_id = ?", a);
    const score = (db.prepare("SELECT score FROM attempts WHERE id = ?").get(a) as { score: number }).score;
    expect(n).toBe(1);
    expect(score).toBe(0.5); // 1 question left, 100% correct, yet stored score says 50%
  });

  it("an in-progress attempt survives losing questions and can still be finished", async () => {
    const w = world();
    const x = q(w, w.topicIds[0], w.A.pages[0]);
    const y = q(w, w.topicIds[2], w.B.pages[1]);
    const a = attempt(w.examId, [x, y]);
    await removeDocument(w.A.id);
    answerQuestion(a, x, 0); // deleted question: must not throw
    answerQuestion(a, y, 0);
    finishAttempt(a);
    expect(attemptView(a)!.questions.length).toBe(1);
  });

  it("case sets: removed cases leave no empty shell row behind", async () => {
    const w = world();
    const c1 = Number(db.prepare("INSERT INTO cases (exam_id, scenario, patient_box, image_page_id) VALUES (?, 'sc', '{}', ?)").run(w.examId, w.A.pages[0]).lastInsertRowid);
    const k1 = q(w, w.topicIds[0], w.A.pages[0], { caseId: c1 });
    const k2 = q(w, w.topicIds[0], w.A.pages[1], { caseId: c1 });
    await removeDocument(w.A.id);
    expect(count("SELECT COUNT(*) n FROM questions WHERE id IN (?, ?)", k1, k2)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM cases WHERE id = ?", c1)).toBe(0);
  });

  it("study session pointing past the new topic count stays in range", async () => {
    const w = world();
    const s = Number(db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, 2)").run(w.examId).lastInsertRowid);
    await removeDocument(w.A.id); // 3 topics -> 2
    const pos = (db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(s) as { p: number }).p;
    // exam page renders `Topic ${pos+1} of ${topics}` and topics[pos]; out of range shows "Topic 3 of 2".
    expect(pos).toBeLessThan(topicRows(w.examId).length);
  });

  it("removing the last lecture leaves the exam clean and re-uploadable", async () => {
    const w = world();
    const x = q(w, w.topicIds[0], w.A.pages[0]);
    attempt(w.examId, [x]);
    await removeDocument(w.A.id);
    await removeDocument(w.B.id);
    expect(topicRows(w.examId)).toEqual([]);
    expect((db.prepare("SELECT topic_status FROM exams WHERE id = ?").get(w.examId) as { topic_status: string }).topic_status).toBe("none");
    expect(count("SELECT COUNT(*) n FROM documents WHERE exam_id = ?", w.examId)).toBe(0);
    await removeDocument(w.A.id); // idempotent on a missing doc
  });

  it("cancels the running Claude batch; a failing cancel still removes the lecture", async () => {
    const w = world();
    db.prepare("UPDATE documents SET status = 'processing', batch_id = 'msgbatch_1' WHERE id = ?").run(w.A.id);
    await removeDocument(w.A.id);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][1]).toBe("msgbatch_1");
    const w2 = world();
    db.prepare("UPDATE documents SET status = 'processing', batch_id = 'msgbatch_2' WHERE id = ?").run(w2.A.id);
    cancel.mockRejectedValueOnce(new Error("already ended"));
    await removeDocument(w2.A.id);
    expect(count("SELECT COUNT(*) n FROM documents WHERE id = ?", w2.A.id)).toBe(0);
  });

  it("BUG: pages_fts rows of the removed slides are deleted (otherwise they attach to a reused page id)", async () => {
    const w = world();
    const ids = w.A.pages;
    await removeDocument(w.A.id);
    const left = count(`SELECT COUNT(*) n FROM pages_fts WHERE page_id IN (${ids.map(() => "?").join(",")})`, ...ids);
    expect(left).toBe(0);
  });

  it("BUG: slide images shared with a classmate's copy must survive removal of the original lecture", async () => {
    const owner = makeUser();
    const mate = makeUser();
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name, topic_status) VALUES (?, 'E', 'ready')").run(owner).lastInsertRowid);
    const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, 'A', 1, 'done')").run(examId).lastInsertRowid);
    const pid = Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, text, image_path, status, title, notes_json) VALUES (?, 1, 't', ?, 'done', 'S', NULL)")
        .run(docId, `doc-${docId}/p1.jpg`).lastInsertRowid,
    );
    db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, 'S', 'c')").run(pid);
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', '', ?)").run(examId, JSON.stringify([pid]));
    fs.mkdirSync(path.join(FILES_DIR, `doc-${docId}`), { recursive: true });
    fs.writeFileSync(path.join(FILES_DIR, `doc-${docId}`, "p1.jpg"), "img");
    const classId = createClass(owner, "C");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    joinClass(mate, code);
    shareExam(owner, classId, examId);
    const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(examId) as { id: number }).id;
    const res = addSharedExam(mate, sharedId) as { examId: number };
    expect(res.examId).toBeGreaterThan(0);
    await removeDocument(docId);
    const copyPage = db.prepare("SELECT p.image_path FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ?").get(res.examId) as {
      image_path: string;
    };
    expect(fs.existsSync(path.join(FILES_DIR, copyPage.image_path))).toBe(true);
  });
});

describe("DELETE /api/documents/[id]", () => {
  const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) }) as unknown as Parameters<typeof DELETE>[1];
  const asUser = (id: number) => (signedIn = { id, api_key_enc: "k", must_change_password: 0, is_admin: 0 });

  it("401 when signed out, 404 for someone else's lecture (and nothing deleted), 200 for the owner", async () => {
    const w = world();
    const other = makeUser();
    expect((await DELETE(new Request("http://x"), ctx(w.A.id))).status).toBe(401);
    asUser(other);
    expect((await DELETE(new Request("http://x"), ctx(w.A.id))).status).toBe(404);
    expect(count("SELECT COUNT(*) n FROM documents WHERE id = ?", w.A.id)).toBe(1);
    expect((await DELETE(new Request("http://x"), ctx(999999))).status).toBe(404);
    asUser(w.userId);
    const ok = await DELETE(new Request("http://x"), ctx(w.A.id));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(count("SELECT COUNT(*) n FROM documents WHERE id = ?", w.A.id)).toBe(0);
  });

  it("garbage ids are 404, not a crash", async () => {
    const w = world();
    asUser(w.userId);
    for (const id of ["abc", "-1", "1e3"]) {
      const r = await DELETE(new Request("http://x"), ctx(id));
      expect(r.status).toBe(404);
    }
  });
});
