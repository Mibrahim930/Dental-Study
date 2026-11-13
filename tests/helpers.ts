// Shared test fixtures: rows every test file needs (a student, an exam with lectures, slides, sections and a study
// session), the slide-notes JSON, and request builders for route handlers. `vi.mock` calls cannot live here (Vitest
// hoists them to the top of each test file), so the AI / credentials / cookie mocks stay in the files that use them.
import { sessionToken } from "@/lib/auth";
import { db, type Topic } from "@/lib/db";
import type { SlideNotes } from "@/lib/notes";

let n = 0;
export function makeUser(): number {
  n++;
  return Number(db.prepare("INSERT INTO users (email, password_hash) VALUES (?, 'x')").run(`user${n}-${Date.now()}@test.dev`).lastInsertRowid);
}

/** A student the API routes accept: an AI key on file and no password change pending. `admin` makes them the site owner. */
export function apiReadyUser(admin = false): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc', must_change_password = 0, is_admin = ? WHERE id = ?").run(admin ? 1 : 0, id);
  return id;
}

/** The session cookie value for a user, as the sign-in route would set it (null signs out). */
export function sessionCookie(userId: number | null): string | undefined {
  if (userId == null) return undefined;
  const { session_epoch } = db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(userId) as { session_epoch: number };
  return sessionToken(userId, session_epoch);
}

export function makeExam(userId: number, date: string | null, topicSlides: number[] = [], name = "Exam"): { examId: number; topicIds: number[] } {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, exam_date) VALUES (?, ?, ?)").run(userId, name, date).lastInsertRowid);
  const topicIds = topicSlides.map((slides, i) =>
    Number(
      db
        .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)")
        .run(examId, i, `Topic ${i + 1}`, JSON.stringify(Array.from({ length: slides }, (_, k) => 100000 + i * 100 + k))).lastInsertRowid,
    ),
  );
  return { examId, topicIds };
}

/** One slide's notes as the slide reader stores them (pages.notes_json), with plain defaults for every field. */
export function slideNotes(overrides: Partial<SlideNotes> = {}): string {
  const notes: SlideNotes = {
    title: "t",
    summary: "s",
    image_description: null,
    key_facts: ["fact"],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
    ...overrides,
  };
  return JSON.stringify(notes);
}

export type LectureOptions = {
  /** 1-based slide numbers that are title / agenda slides. */
  filler?: number[];
  /** documents.status (default "done"). */
  status?: string;
  /** 1-based slide numbers not read yet (status "pending", no notes). */
  pending?: number[];
  /** notes_json for slide `i` (1-based); default: notes titled "<name> s<i>" with one fact and the concept "c". */
  notes?: (i: number) => string | null;
};

/** A lecture of `slides` slides in an exam: the document row and one page per slide, each with its own image path. */
export function makeLecture(examId: number, name: string, slides: number, o: LectureOptions = {}): { doc: number; pages: number[] } {
  const doc = Number(
    db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, ?, ?)").run(examId, name, o.status ?? "done", slides).lastInsertRowid,
  );
  const insert = db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, ?, ?, ?)");
  const pages = Array.from({ length: slides }, (_, k) => {
    const i = k + 1;
    const pending = !!o.pending?.includes(i);
    const notes = pending
      ? null
      : o.notes
        ? o.notes(i)
        : slideNotes({ title: `${name} s${i}`, summary: `about ${name} s${i}`, concepts: ["c"], is_filler: !!o.filler?.includes(i) });
    return Number(insert.run(doc, i, `doc-${doc}/p${i}.jpg`, pending ? "pending" : "done", notes).lastInsertRowid);
  });
  return { doc, pages };
}

export type SectionSpec = {
  title?: string;
  summary?: string;
  /** Index into `lectures` (default: sections take turns over the lectures). */
  lecture?: number;
  /** Number of slides (default `slidesEach`). */
  slides?: number;
  /** A stored section quiz (checks_json), written as version `quizVersion`. */
  quiz?: unknown[];
};

export type WorldOptions = {
  /** The owner (default: a new API-ready student). */
  userId?: number;
  /** Exam name (default "E"). */
  exam?: string;
  examDate?: string | null;
  /** topic_status 'ready', as after a finished topic map. */
  ready?: boolean;
  /** Lecture file names, one document each (default ["lec.pdf"]). */
  lectures?: string[];
  /** documents.status (default "done"). */
  lectureStatus?: string;
  /** documents.page_count (default: the number of slides the lecture got). */
  pageCount?: number;
  /** How many sections, or one spec per section (default 2). */
  sections?: number | SectionSpec[];
  /** Slides per section when a spec does not say (default 3). */
  slidesEach?: number;
  /** notes_json of slide `n` (numbered 1.. across the whole exam); default none. */
  notes?: (n: number) => string | null;
  /** pages.status (default "done"). */
  pageStatus?: string;
  /** pages.text (default "slide text"). */
  text?: string;
  /** pages.image_path (default ""). */
  imagePath?: string;
  /** Set each section's document_id to its lecture (default true; false = an old-style exam). */
  linkLectures?: boolean;
  /** checks_version stored with a section's quiz. */
  quizVersion?: number | null;
  /** Add a study session for the exam (default true). */
  session?: boolean;
};

export type World = {
  userId: number;
  examId: number;
  docIds: number[];
  topicIds: number[];
  /** Slide ids per section, in order. */
  pageIds: number[][];
  sessionId: number;
  topicRow: (id: number) => Topic;
};

/**
 * A student's exam with lectures, slides, sections and a study session, in one call. Slides are numbered across the
 * exam in the order the sections are made; each section's slides come from its lecture.
 */
export function world(o: WorldOptions = {}): World {
  const userId = o.userId ?? apiReadyUser();
  const examId = Number(
    db
      .prepare("INSERT INTO exams (user_id, name, exam_date, topic_status) VALUES (?, ?, ?, ?)")
      .run(userId, o.exam ?? "E", o.examDate ?? null, o.ready ? "ready" : "none").lastInsertRowid,
  );
  const lectures = o.lectures ?? ["lec.pdf"];
  const specs: SectionSpec[] = typeof o.sections === "number" || o.sections === undefined ? Array.from({ length: o.sections ?? 2 }, () => ({})) : o.sections;
  const lectureOf = (s: SectionSpec, i: number) => s.lecture ?? i % lectures.length;
  const slidesOf = (s: SectionSpec) => s.slides ?? o.slidesEach ?? 3;
  const docIds = lectures.map((name, d) => {
    const count = o.pageCount ?? specs.filter((s, i) => lectureOf(s, i) === d).reduce((sum, s) => sum + slidesOf(s), 0);
    return Number(
      db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, ?, ?)").run(examId, name, o.lectureStatus ?? "done", count).lastInsertRowid,
    );
  });
  const page = db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, text, notes_json) VALUES (?, ?, ?, ?, ?, ?)");
  const topic = db.prepare(
    "INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id, checks_json, checks_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let slide = 0;
  const pageIds: number[][] = [];
  const topicIds = specs.map((s, i) => {
    const doc = docIds[lectureOf(s, i)];
    const pages = Array.from({ length: slidesOf(s) }, () => {
      slide++;
      return Number(
        page.run(doc, slide, o.imagePath ?? "", o.pageStatus ?? "done", o.text ?? "slide text", o.notes ? o.notes(slide) : null).lastInsertRowid,
      );
    });
    pageIds.push(pages);
    return Number(
      topic.run(
        examId,
        i,
        s.title ?? `Topic ${i + 1}`,
        s.summary ?? "",
        JSON.stringify(pages),
        o.linkLectures === false ? null : doc,
        s.quiz ? JSON.stringify(s.quiz) : null,
        s.quiz ? (o.quizVersion ?? null) : null,
      ).lastInsertRowid,
    );
  });
  const sessionId = o.session === false ? 0 : Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topicRow = (id: number) => db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Topic;
  return { userId, examId, docIds, topicIds, pageIds, sessionId, topicRow };
}

/** Route params for a handler with one `[id]` segment (also given as `cardId` for /api/review/[cardId]). */
export const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id), cardId: String(id) }) }) as never;

/** A JSON POST (or another method) to a route handler. A string body is sent as it is, so tests can send broken JSON. */
export const postJson = (body: unknown, url = "http://x/api", method = "POST") =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** A GET request to a route handler. */
export const getReq = (url = "http://x/api") => new Request(url);
