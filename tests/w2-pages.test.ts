// Wave 2, exam page: loadExamPage (lib/examPage.ts) loads what app/exams/[id]/page.tsx used to load inline, and counts
// title / agenda slides from pages.is_filler (examSlideKinds) instead of parsing every slide's notes on each refresh.
// The counts must be the ones the old per-slide parse gave: with the column filled, NULL (falls back to the notes),
// and with damaged or missing notes. The split page is rendered with its client components stubbed out.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, type Topic } from "@/lib/db";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { makeUser } from "./helpers";

const state = vi.hoisted(() => ({ userId: 0 }));

vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  requireUser: async () => (await import("@/lib/db")).db.prepare("SELECT * FROM users WHERE id = ?").get(state.userId),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh() {}, push() {} }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("@/app/actions", () => ({ updateExam: function updateExam() {}, setArchived: function setArchived() {} }));
// Client components: rendered as a tag with their (serialisable) props, so the page's HTML can be compared.
const stub = (name: string) =>
  Object.assign((props: Record<string, unknown>) => createElement("x-" + name.toLowerCase(), { "data-props": JSON.stringify(props) }), { displayName: name });
vi.mock("@/components/AutoRefresh", () => ({ AutoRefresh: stub("AutoRefresh") }));
vi.mock("@/components/QuizMe", () => ({ QuizMe: stub("QuizMe") }));
vi.mock("@/components/Uploader", () => ({ Uploader: stub("Uploader") }));
vi.mock("@/components/PracticeForm", () => ({ PracticeForm: stub("PracticeForm") }));
vi.mock("@/components/ActionButton", () => ({ ActionButton: stub("ActionButton") }));
vi.mock("@/components/RemoveLectureButton", () => ({ RemoveLectureButton: stub("RemoveLectureButton") }));
vi.mock("@/components/LectureReviewCard", () => ({ LectureReviewCard: stub("LectureReviewCard") }));

const { loadExamPage } = await import("@/lib/examPage");
const { default: ExamPage } = await import("@/app/exams/[id]/page");

/** The exam page's slide counts as the page computed them before is_filler (one JSON.parse per slide), kept as the reference. */
function slideCountsOld(examId: number) {
  const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
  const inTopics = new Set(topics.flatMap((t) => JSON.parse(t.page_ids) as number[]));
  const slideRows = db
    .prepare("SELECT p.id, p.notes_json FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ? AND p.status = 'done'")
    .all(examId) as { id: number; notes_json: string | null }[];
  let fillerSlides = 0;
  let contentSlides = 0;
  let missingSlides = 0;
  for (const p of slideRows) {
    let filler: boolean;
    try {
      if (!p.notes_json) continue;
      filler = !!(JSON.parse(p.notes_json) as { is_filler?: boolean }).is_filler;
    } catch {
      continue;
    }
    if (filler) fillerSlides++;
    else {
      contentSlides++;
      if (!inTopics.has(p.id)) missingSlides++;
    }
  }
  return { fillerSlides, contentSlides, missingSlides };
}

type Column = "filled" | "null";

/**
 * A student's exam with two read lectures and one still reading. Lecture 1 has two sections; lecture 2 has none yet.
 * Slides: title / agenda (filler), content slides in a section, content slides in no section, one with damaged notes,
 * one with no notes, one that failed to read. `column` says whether pages.is_filler was written (as reading does now)
 * or left NULL (slides read before the column existed).
 */
function seed(column: Column, opts: { sections?: boolean } = {}) {
  const userId = makeUser();
  state.userId = userId;
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, course, exam_date) VALUES (?, 'Endo block', 'Endodontics', '2026-12-01')").run(userId).lastInsertRowid);
  const doc = (filename: string, status: string, pages: number) =>
    Number(db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, ?, ?, ?)").run(examId, filename, pages, status).lastInsertRowid);
  const d1 = doc("01 Access cavities.pdf", "done", 6);
  const d2 = doc("02 Irrigation.pdf", "done", 5);
  const d3 = doc("03 Obturation.pdf", "processing", 4);
  let n = 0;
  const page = (docId: number, notes: string | null, isFiller: 0 | 1 | null, status = "done") =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, is_filler) VALUES (?, ?, 'x.png', ?, ?, ?)")
        .run(docId, ++n, status, notes, column === "filled" ? isFiller : null).lastInsertRowid,
    );
  const notes = (isFiller: boolean) => JSON.stringify({ title: "t", is_filler: isFiller, key_facts: ["fact"] });
  const ids = {
    title1: page(d1, notes(true), 1),
    a: page(d1, notes(false), 0),
    b: page(d1, notes(false), 0),
    c: page(d1, notes(false), 0),
    damaged: page(d1, "{not json", null), // damaged notes: left out, as before
    noNotes: page(d1, null, null), // no notes yet: left out
    agenda2: page(d2, JSON.stringify({ title: "Agenda", is_filler: true }), 1),
    e: page(d2, notes(false), 0),
    f: page(d2, JSON.stringify({ title: "no flag" }), 0), // no is_filler in the notes: a content slide
    g: page(d2, notes(false), 0),
    failed: page(d2, null, null, "error"),
    reading: page(d3, null, null, "pending"),
  };
  const topic = (position: number, title: string, pages: number[], documentId: number | null, emphasized = 0) =>
    Number(
      db
        .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id, emphasized) VALUES (?, ?, ?, '', ?, ?, ?)")
        .run(examId, position, title, JSON.stringify(pages), documentId, emphasized).lastInsertRowid,
    );
  const topics: number[] = [];
  if (opts.sections !== false) {
    topics.push(topic(0, "Outline form", [ids.a, ids.b], d1, 1));
    topics.push(topic(1, "Access errors", [ids.c], d1));
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(userId, topics[0]);
    db.prepare("INSERT INTO study_sessions (exam_id, current_position, summary, ended_at) VALUES (?, 1, 'Went over outline form.', '2026-11-10 18:00:00')").run(examId);
    // A practice exam in progress and a finished one.
    const q = () =>
      Number(
        db
          .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 's', '[\"a\",\"b\"]', 0, 'e')")
          .run(examId, topics[0]).lastInsertRowid,
      );
    const open = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, started_at) VALUES (?, 'tutor', 'ready', '2026-11-12 09:00:00')").run(examId).lastInsertRowid);
    const done = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status, score, started_at) VALUES (?, 'timed', 'finished', 0.5, '2026-11-11 09:00:00')").run(examId).lastInsertRowid);
    const [q1, q2] = [q(), q()];
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, 0, 0, 1), (?, ?, 1, NULL, NULL)").run(open, q1, open, q2);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, 0, 0, 1), (?, ?, 1, 1, 0)").run(done, q1, done, q2);
  }
  return { userId, examId, ids, docs: [d1, d2, d3], topics };
}

/** Shares the exam with a classmate through a class and returns her copy. */
function copyClassExam(owner: number, examId: number) {
  db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(examId);
  const classId = createClass(owner, "Class");
  const { invite_code } = db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string };
  const userId = makeUser();
  expect(joinClass(userId, invite_code)).not.toBeNull();
  expect(shareExam(owner, classId, examId)).toBeNull();
  const shared = db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(examId) as { id: number };
  const copy = addSharedExam(userId, shared.id) as { examId: number };
  expect(copy.examId).not.toBe(examId);
  return { userId, examId: copy.examId };
}

const render = async (examId: number) => renderToStaticMarkup(await ExamPage({ params: Promise.resolve({ id: String(examId) }) } as never));

describe("loadExamPage: slide counts from pages.is_filler", () => {
  beforeEach(() => {
    state.userId = 0;
  });

  for (const column of ["filled", "null"] as const) {
    it(`gives the counts the per-slide parse gave (is_filler ${column})`, () => {
      const w = seed(column);
      const data = loadExamPage(w.userId, w.examId)!;
      const counts = { fillerSlides: data.fillerSlides, contentSlides: data.contentSlides, missingSlides: data.missingSlides };
      expect(counts).toEqual(slideCountsOld(w.examId));
      // 2 title/agenda slides; 6 content slides (a, b, c, e, f, g); e, f, g are in no section.
      expect(counts).toEqual({ fillerSlides: 2, contentSlides: 6, missingSlides: 3 });
    });
  }

  it("mixes rows with the column filled and rows still NULL (a half back-filled exam)", () => {
    const w = seed("filled");
    db.prepare("UPDATE pages SET is_filler = NULL WHERE id IN (?, ?, ?)").run(w.ids.title1, w.ids.e, w.ids.f);
    const data = loadExamPage(w.userId, w.examId)!;
    expect({ fillerSlides: data.fillerSlides, contentSlides: data.contentSlides, missingSlides: data.missingSlides }).toEqual(slideCountsOld(w.examId));
  });

  it("damaged notes on every slide: nothing counted, so the 'slides in a section' line is not shown", async () => {
    const w = seed("null");
    db.prepare("UPDATE pages SET notes_json = '{\"is_filler\": tru' WHERE notes_json IS NOT NULL").run();
    const data = loadExamPage(w.userId, w.examId)!;
    expect({ fillerSlides: data.fillerSlides, contentSlides: data.contentSlides, missingSlides: data.missingSlides }).toEqual({ fillerSlides: 0, contentSlides: 0, missingSlides: 0 });
    expect(slideCountsOld(w.examId)).toEqual({ fillerSlides: 0, contentSlides: 0, missingSlides: 0 });
    const html = await render(w.examId);
    expect(html).not.toContain("in your study plan");
    expect(html).not.toContain("in a section yet");
  });

  it("is null for an exam that isn't hers", () => {
    const w = seed("filled");
    expect(loadExamPage(makeUser(), w.examId)).toBeNull();
    expect(loadExamPage(w.userId, 999999)).toBeNull();
  });

  it("a copied class exam keeps is_filler, and its counts match the original's", () => {
    const w = seed("filled");
    const copy = copyClassExam(w.userId, w.examId);
    expect(db.prepare("SELECT COUNT(*) n FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ? AND p.is_filler IS NOT NULL").get(copy.examId)).toEqual({
      n: 8,
    });
    const a = loadExamPage(w.userId, w.examId)!;
    const b = loadExamPage(copy.userId, copy.examId)!;
    expect([b.fillerSlides, b.contentSlides]).toEqual([a.fillerSlides, a.contentSlides]);
  });
});

describe("exam page (split into components)", () => {
  it("renders the hero, study card, lectures with sections, and practice with the open and past attempts", async () => {
    const w = seed("filled");
    const html = await render(w.examId);
    expect(html).toContain("Endo block");
    expect(html).toContain("Endodontics");
    expect(html).toContain("1/2 sections studied");
    expect(html).toContain("0 of 1 lecture done");
    expect(html).toContain("Lecture 1 · Section 2 of 2");
    expect(html).toContain("Access errors");
    expect(html).toContain("Went over outline form.");
    expect(html).toContain("3 of 6 slides aren&#x27;t in a section yet. 2 title or agenda slides were left out.");
    expect(html).toContain("1 of 2 sections done · 3 slides");
    expect(html).toContain("No sections yet. It&#x27;s split into sections once every lecture is read.");
    expect(html).toContain("Learn practice exam in progress");
    expect(html).toContain("Continue · 1 of 2 answered");
    expect(html).toContain("Past attempts");
    expect(html).toContain("1/2");
    expect(html).toContain(`href="/exams/${w.examId}/study?topic=1"`);
    expect(html).toContain("x-autorefresh");
    expect(html).toContain('{&quot;active&quot;:true,&quot;ms&quot;:4000}');
  });

  it("renders an exam with lectures but no sections yet", async () => {
    const w = seed("null", { sections: false });
    const html = await render(w.examId);
    expect(html).toContain("Upload this exam&#x27;s lectures.");
    expect(html).toContain("Available once your lectures are split into sections.");
    expect(html).not.toContain("Past attempts");
    expect(html).not.toContain("in your study plan");
    expect(html).toContain("No sections yet. It&#x27;s split into sections once every lecture is read.");
  });

  it("someone else's exam is a 404", async () => {
    const w = seed("filled");
    state.userId = makeUser();
    await expect(render(w.examId)).rejects.toThrow("NOT_FOUND");
  });
});
