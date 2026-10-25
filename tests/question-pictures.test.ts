// A question that talks about a picture always shows one (quizzes and practice exams), and older ones are repaired.
import { beforeEach, describe, expect, it, vi } from "vitest";

type QuizOut = { slot: number; question: string; options: string[]; correct_index: number; correct_answer: string; explanation: string; source_page_id: number; image_page_id: number | null; concept: string };
let quizWriter: (slots: { n: number; page: number }[]) => QuizOut[] = () => [];
let practiceWriter: (content: string) => unknown[] = () => [];
/** Question texts the mocked checking pass says need a picture. */
let judgePicture: (question: string) => boolean = () => false;
const systems: Record<string, string> = {};
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; system: string; content: string }) => {
    systems[opts.purpose] = opts.system;
    if (opts.purpose === "section quiz") {
      const slots = [...opts.content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return { questions: quizWriter(slots) };
    }
    if (opts.purpose === "section quiz check") {
      const stems = [...opts.content.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
      return { verdicts: stems.map((t, i) => ({ n: i + 1, ok: true, picture: judgePicture(t), reason: "" })) };
    }
    if (opts.purpose === "practice questions") return { questions: practiceWriter(opts.content) };
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db, type Topic } from "@/lib/db";
import { getSectionQuiz, type QuizQuestion } from "@/lib/study";
import { startAttempt } from "@/lib/practice";
import { markPictures, mentionsPicture, pictureFor, pictureForIds, repairPictureQuestions, slideNumberIn } from "@/lib/questionImage";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as quizGET } from "@/app/api/sessions/[id]/quiz/route";
import { makeUser } from "./helpers";

const notes = (o: { image?: string | null; crop?: boolean } = {}) =>
  JSON.stringify({
    title: "t",
    summary: "s",
    image_description: o.image ?? null,
    key_facts: ["a", "b"],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: o.crop ? "What is the diagnosis?" : null,
    case_answer: null,
    case_image_box: o.crop ? { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } : null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
  });

/** One topic over three slides: plain text, a slide with a photo, and a clinical-image case with a crop box. */
function world() {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, topic_status) VALUES (?, 'E', 'ready')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const ins = db.prepare("INSERT INTO pages (document_id, page_number, image_path, aspect, status, notes_json) VALUES (?, ?, 'x.jpg', 1.5, 'done', ?)");
  const plain = Number(ins.run(docId, 1, notes()).lastInsertRowid);
  const photo = Number(ins.run(docId, 2, notes({ image: "A periapical radiograph of tooth #19 with a radiolucency" })).lastInsertRowid);
  const cropped = Number(ins.run(docId, 3, notes({ image: "Clinical photo of a swelling", crop: true })).lastInsertRowid);
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', '', ?)").run(examId, JSON.stringify([plain, photo, cropped])).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, topicId, sessionId, topic, plain, photo, cropped };
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const pageRows = (ids: number[]) => db.prepare(`SELECT id, aspect, notes_json FROM pages WHERE id IN (${ids.join(",")})`).all() as { id: number; aspect: number; notes_json: string }[];
const q = (slot: number, page: number, text: string, image: number | null): QuizOut => ({
  slot,
  question: text,
  options: ["right", "w1", "w2", "w3"],
  correct_index: 0,
  correct_answer: "right",
  explanation: "because",
  source_page_id: page,
  image_page_id: image,
  concept: "C",
});

beforeEach(() => {
  quizWriter = () => [];
  practiceWriter = () => [];
  judgePicture = () => false;
});

describe("helpers", () => {
  it("knows when a question sends the student to a picture", () => {
    for (const t of [
      "In the radiograph shown, what is the diagnosis?",
      "Based on the image below, which canal is widest?",
      "The photograph depicts which lesion?",
      "Which X-ray finding is seen here?",
      "What is pictured?",
      "What does the radiograph show at tooth #19?",
      "Look at the clinical image. What is the diagnosis?",
      "In the picture below, which instrument is held?",
      "On the X-ray shown, which tooth?",
      "In the figure, what is marked?",
      "Identify the structure in this diagram.",
      // The two stems a student reported showing up without their picture.
      "In the slide's diagram, which tooth surfaces are labeled 'gp' and distinguished from the dotted occlusal line?",
      "On slide 32's diagram, the planes on adjacent teeth are drawn to show what?",
      "Which structure is labeled 'gp'?",
      "What does the dotted line represent?",
      "Identify the structure marked X.",
      "What is the radiolucency indicated by the arrow?",
      "The shaded area on the tooth represents what?",
      "The structure circled in red is?",
      "On this slide, which rest seat is shown?",
      "Refer to the figure. Which structure is labeled A?",
    ])
      expect(mentionsPicture(t), t).toBe(true);
    // Ordinary text questions that merely use the words: these must keep their place.
    for (const t of [
      "What is the most common irrigant?",
      "A 12-year-old presents with pain.",
      "Imaging studies are not indicated for",
      "The best type of radiograph to visualize the pulp chamber of a posterior tooth is?",
      "Radiographs are taken every 6 months in which situation?",
      "Rubber dam use has been shown to improve endodontic success. Why?",
      "The apical constriction lies how far from the radiographic apex?",
      "A periapical radiograph will typically demonstrate which finding in asymptomatic apical periodontitis?",
      "Which figure best approximates the prevalence of TMJ clicking?",
      "Chronic periodontitis is marked by attachment loss. Which is true?",
      "The tooth marked as the abutment must have what?",
      "A patient has a red line along the gingival margin. What is it?",
      // Ordinary dental wording that happens to share words with picture talk (a false positive deletes a stored question).
      "What determines the outline form of a Class II preparation?",
      "The orthodontic bracket is bonded to which surface?",
      "When the probe slides apically into the sulcus, what is being measured?",
      "In the Universal system, teeth are numbered starting from which tooth?",
      "The tooth numbered 14 is which?",
      "A patient's chart is labeled high caries risk. What interval is recommended?",
      "Which of the following best describes the circle of Willis?",
      "The rubber dam clamp is numbered 8A. For which tooth?",
      "Pockets marked 3 mm or less are considered what?",
    ])
      expect(mentionsPicture(t), t).toBe(false);
    expect(slideNumberIn("On slide 32's diagram, what is drawn?")).toBe(32);
    expect(slideNumberIn("See slide #7.")).toBe(7);
    expect(slideNumberIn("In the slide's diagram")).toBeNull();
  });

  it("picks the named slide's picture, else the source slide's, else none; crops only when the notes marked one", () => {
    const w = world();
    const pages = pageRows([w.plain, w.photo, w.cropped]);
    expect(pictureFor(pages, w.cropped, w.plain)).toEqual({ page_id: w.cropped, aspect: 1.5, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } });
    expect(pictureFor(pages, null, w.photo)).toEqual({ page_id: w.photo, aspect: 1.5, crop: null });
    expect(pictureFor(pages, w.plain, w.plain)).toBeNull();
    expect(pictureFor(pages, 999999, null)).toBeNull();
    // Given the question text, a question that needs a picture gets the whole slide when none is marked...
    expect(pictureFor(pages, null, w.plain, "Based on the image below, which canal is widest?")).toEqual({ page_id: w.plain, aspect: 1.5, crop: null });
    expect(pictureFor(pages, 999999, null, "Based on the image below")).toBeNull();
    // ...and the slide the text names by number wins over the slide the question was written from.
    const numbered = db.prepare(`SELECT id, aspect, notes_json, page_number FROM pages WHERE id IN (${[w.plain, w.photo, w.cropped].join(",")})`).all() as never[];
    expect(pictureFor(numbered, null, w.plain, "On slide 2's radiograph, where is the lesion?")).toEqual({ page_id: w.photo, aspect: 1.5, crop: null });
    expect(pictureFor(numbered, null, w.plain, "On slide 9's radiograph, where is the lesion?")).toEqual({ page_id: w.plain, aspect: 1.5, crop: null });
    // A stored image_page_id is always shown, whole when the notes marked nothing.
    expect(pictureForIds(w.plain, null)).toEqual({ page_id: w.plain, aspect: 1.5, crop: null });
    expect(pictureForIds(w.cropped, null)?.crop).not.toBeNull();
    expect(pictureForIds(null, w.plain)).toBeNull();
    const marked = markPictures(`[P${w.plain}] a\n[P${w.photo}] b\n[P${w.cropped}] c`, pages);
    expect(marked).toBe(`[P${w.plain}] a\n[P${w.photo}] [IMAGE] b\n[P${w.cropped}] [IMAGE-CASE] c`);
  });
});

describe("section quiz", () => {
  it("keeps the picture the writer named, falls back to the tested slide's picture, and shows the whole slide for picture talk with no marked picture", async () => {
    const w = world();
    currentUserId = w.userId;
    quizWriter = (slots) =>
      slots.map((s, i) => {
        if (i === 0) return q(s.n, w.cropped, "In the clinical photo shown, what is the swelling?", w.cropped); // named
        if (i === 1) return q(s.n, w.photo, "What does the radiograph show at tooth #19?", null); // falls back to its slide
        if (i === 2) return q(s.n, w.plain, "Based on the image below, which canal is widest?", null); // no marked picture: the whole slide
        if (i === 3) return q(s.n, w.plain, "In the slide's diagram, which surfaces are labeled 'gp'?", null); // the reported wording
        if (i === 4) return q(s.n, w.plain, "On slide 2's diagram, the planes are drawn to show what?", null); // names slide 2
        if (i === 5) return q(s.n, 999999, "On slide 9's diagram, what is drawn?", null); // not one of the topic's slides
        return q(s.n, s.page, `Plain question ${s.n}`, null);
      });
    const quiz = await getSectionQuiz(w.topic());
    const byText = (t: string) => quiz.find((x) => x.question.startsWith(t));
    expect(byText("In the clinical photo")?.image_page_id).toBe(w.cropped);
    expect(byText("What does the radiograph")?.image_page_id).toBe(w.photo);
    expect(byText("Based on the image below")?.image_page_id).toBe(w.plain);
    expect(byText("In the slide's diagram")?.image_page_id).toBe(w.plain);
    expect(byText("On slide 2's diagram")?.image_page_id).toBe(w.photo);
    expect(byText("On slide 9's diagram")).toBeUndefined();
    expect(systems["section quiz check"]).toContain("picture = true");
    expect(quiz.filter((x) => x.question.startsWith("Plain")).every((x) => x.image_page_id == null)).toBe(true);
    expect(systems["section quiz"]).toContain("[IMAGE-CASE]");
    expect(systems["section quiz check"]).toContain("picture shown");

    // The page gets the picture to draw: crop for the case slide, none for a plain photo slide.
    const res = await quizGET(new Request(`http://x/q?position=0`), ctx(w.sessionId));
    const json = (await res.json()) as { questions: (QuizQuestion & { image: { page_id: number; aspect: number; crop: unknown } | null })[] };
    const shown = json.questions.find((x) => x.question.startsWith("In the clinical photo"))!;
    expect(shown.image).toEqual({ page_id: w.cropped, aspect: 1.5, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } });
    expect(json.questions.find((x) => x.question.startsWith("What does the radiograph"))!.image).toEqual({ page_id: w.photo, aspect: 1.5, crop: null });
    expect(json.questions.find((x) => x.question.startsWith("Based on the image below"))!.image).toEqual({ page_id: w.plain, aspect: 1.5, crop: null });
    expect(json.questions.find((x) => x.question.startsWith("Plain"))!.image).toBeNull();
  });

  it("the checking pass catches picture wording the detector misses: the question gets its slide's picture or goes", async () => {
    const w = world();
    quizWriter = (slots) =>
      slots.map((s, i) => {
        if (i === 0) return q(s.n, w.photo, "Which tooth has the lesion?", null); // reads as text, but the checker says it needs the picture
        if (i === 1) return q(s.n, w.plain, "Which surfaces carry the rest?", null); // same, on a slide with no marked picture
        return q(s.n, s.page, `Plain question ${s.n}`, null);
      });
    judgePicture = (t) => t.startsWith("Which tooth has") || t.startsWith("Which surfaces carry");
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz.find((x) => x.question.startsWith("Which tooth has"))?.image_page_id).toBe(w.photo);
    expect(quiz.find((x) => x.question.startsWith("Which surfaces carry"))?.image_page_id).toBe(w.plain);
    expect(quiz.filter((x) => x.question.startsWith("Plain")).every((x) => x.image_page_id == null)).toBe(true);
  });

  it("a class copy points the picture at the copy's own slide", async () => {
    const w = world();
    quizWriter = (slots) => slots.map((s) => q(s.n, w.photo, `Radiograph question ${s.n}`, w.photo));
    await getSectionQuiz(w.topic());
    const mate = makeUser();
    const classId = createClass(w.userId, "C");
    joinClass(mate, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code);
    expect(shareExam(w.userId, classId, w.examId)).toBeNull();
    const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE class_id = ?").get(classId) as { id: number }).id;
    const copy = (addSharedExam(mate, sharedId) as { examId: number }).examId;
    const t2 = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(copy) as Topic;
    const copyPages = new Set(JSON.parse(t2.page_ids) as number[]);
    const qs = JSON.parse(t2.checks_json!) as QuizQuestion[];
    expect(qs.every((x) => x.image_page_id != null && copyPages.has(x.image_page_id) && x.image_page_id !== w.photo)).toBe(true);
  });
});

describe("practice exam", () => {
  it("attaches a picture to picture questions (named or inferred), the whole slide when none is marked", async () => {
    const w = world();
    practiceWriter = () => [
      { type: "image", image_page_id: w.cropped, patient_box: null, stem: "Look at the clinical image. What is the diagnosis?", options: ["a", "b", "c", "d", "e"], correct_index: 0, correct_answer: "a", explanation: "e", source_page_id: w.cropped, concept: "C" },
      { type: "recall", image_page_id: null, patient_box: null, stem: "On the radiograph shown, where is the lesion?", options: ["a", "b", "c", "d", "e"], correct_index: 1, correct_answer: "b", explanation: "e", source_page_id: w.photo, concept: "C" },
      { type: "recall", image_page_id: null, patient_box: null, stem: "In the picture below, which instrument is held?", options: ["a", "b", "c", "d", "e"], correct_index: 2, correct_answer: "c", explanation: "e", source_page_id: w.plain, concept: "C" },
      { type: "recall", image_page_id: null, patient_box: null, stem: "What is the most common irrigant?", options: ["a", "b", "c", "d", "e"], correct_index: 3, correct_answer: "d", explanation: "e", source_page_id: w.plain, concept: "C" },
    ];
    const attemptId = startAttempt(w.examId, { size: 5, mode: "tutor", style: "mixed", adaptive: false });
    for (let i = 0; i < 100; i++) {
      const s = (db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId) as { status: string }).status;
      if (s !== "generating") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const rows = db.prepare("SELECT stem, type, image_page_id FROM questions WHERE exam_id = ? ORDER BY id").all(w.examId) as { stem: string; type: string; image_page_id: number | null }[];
    expect(rows.map((r) => r.stem.slice(0, 12))).toEqual(["Look at the ", "On the radio", "In the pictu", "What is the "]);
    expect(rows[0]).toMatchObject({ type: "image", image_page_id: w.cropped });
    expect(rows[1]).toMatchObject({ type: "recall", image_page_id: w.photo });
    expect(rows[2]).toMatchObject({ type: "recall", image_page_id: w.plain });
    expect(rows[3]).toMatchObject({ type: "recall", image_page_id: null });
    expect(systems["practice questions"]).toContain("[IMAGE]");
  });
});

describe("repairing questions written before pictures were enforced", () => {
  it("gives them their slide's picture, deletes unanswered ones with nothing to show, retires answered ones, hides quiz ones", () => {
    const w = world();
    const insQ = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', ?, '[\"a\",\"b\"]', 0, 'e', ?)");
    const fixable = Number(insQ.run(w.examId, w.topicId, "In the radiograph shown, what is seen?", w.photo).lastInsertRowid);
    const gone = Number(insQ.run(w.examId, w.topicId, "In the image below, what is seen?", w.plain).lastInsertRowid);
    const retired = Number(insQ.run(w.examId, w.topicId, "The photograph depicts which lesion?", w.plain).lastInsertRowid);
    const fine = Number(insQ.run(w.examId, w.topicId, "What is the most common irrigant?", w.plain).lastInsertRowid);
    const reported = Number(insQ.run(w.examId, w.topicId, "In the slide's diagram, which tooth surfaces are labeled 'gp'?", w.photo).lastInsertRowid);
    const bySlideNumber = Number(insQ.run(w.examId, w.topicId, "On slide 1's diagram, the planes are drawn to show what?", w.photo).lastInsertRowid);
    const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(w.examId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, 0, 0, 1)").run(attemptId, retired);
    const quiz: QuizQuestion[] = [
      { id: "aaaaaaaa", question: "On the X-ray shown, which tooth?", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", source_page_id: w.photo },
      { id: "bbbbbbbb", question: "In the figure, what is marked?", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", source_page_id: w.plain },
      { id: "cccccccc", question: "Plain question", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", source_page_id: w.plain },
    ];
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = 2 WHERE id = ?").run(JSON.stringify(quiz), w.topicId);

    expect(repairPictureQuestions()).toBe(7);
    const row = (id: number) => db.prepare("SELECT image_page_id, flagged FROM questions WHERE id = ?").get(id) as { image_page_id: number | null; flagged: number } | undefined;
    expect(row(fixable)).toEqual({ image_page_id: w.photo, flagged: 0 });
    expect(row(gone)).toBeUndefined();
    expect(row(retired)).toEqual({ image_page_id: null, flagged: 1 });
    expect(row(fine)).toEqual({ image_page_id: null, flagged: 0 });
    expect(row(reported)).toEqual({ image_page_id: w.photo, flagged: 0 });
    expect(row(bySlideNumber)).toEqual({ image_page_id: w.plain, flagged: 0 }); // slide 1 is named, so it is shown whole
    const after = JSON.parse(w.topic().checks_json!) as QuizQuestion[];
    expect(after[0]).toMatchObject({ image_page_id: w.photo });
    expect(after[1]).toMatchObject({ hidden: true, report_note: "No picture to show" });
    expect(after[2].hidden).toBeUndefined();
    expect(after).toHaveLength(3); // positions never shift
    expect(repairPictureQuestions()).toBe(0); // idempotent
  });
});
