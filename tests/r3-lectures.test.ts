// Release 3, Job A: topic maps by lecture. Each lecture is mapped on its own (one AI call per lecture), sections stay in
// slide order, study order is lecture by lecture, and a one-time startup job re-maps old cross-lecture maps.
import { beforeEach, describe, expect, it, vi } from "vitest";

type AiTopic = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[] };
let reply: (content: string) => { topics: AiTopic[] } = () => ({ topics: [] });
let delay = 0;
let running = 0;
let maxRunning = 0;
const prompts: string[] = [];
/** topic_status of each exam as seen while its AI calls run. */
const statusDuringCall: string[] = [];
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    if (opts.purpose !== "topic map") throw new Error("unexpected " + opts.purpose);
    prompts.push(opts.content);
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const id = Number(/\[P(\d+)\]/.exec(opts.content)?.[1]);
      const s = db.prepare("SELECT e.topic_status FROM exams e JOIN documents d ON d.exam_id = e.id JOIN pages p ON p.document_id = d.id WHERE p.id = ?").get(id) as
        | { topic_status: string }
        | undefined;
      if (s) statusDuringCall.push(s.topic_status);
      return reply(opts.content);
    } finally {
      running--;
    }
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, getMeta, setMeta, type Topic } from "@/lib/db";
import { buildTopicMap, lectureMapsKey, rebuildLectureMaps } from "@/lib/topics";
import { removeDocument } from "@/lib/processing";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { groupByLecture, sectionPlaces } from "@/lib/lectures";
import { lectureProgressMany } from "@/lib/readiness";
import { addDays, plannerSettings, todayIn } from "@/lib/planner";
import { makeUser } from "./helpers";

const notes = (title: string, filler = false) =>
  JSON.stringify({
    title,
    summary: `about ${title}`,
    image_description: null,
    key_facts: ["fact"],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: ["c"],
    is_filler: filler,
  });

/** A read lecture of `n` slides; `filler` lists 1-based slide numbers that are title/agenda slides. */
function lecture(examId: number, name: string, n: number, filler: number[] = [], status = "done") {
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, ?, ?)").run(examId, name, status, n).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, ?, 'done', ?)")
        .run(doc, i + 1, `doc-${doc}/p${i + 1}.jpg`, notes(`${name} s${i + 1}`, filler.includes(i + 1))).lastInsertRowid,
    ),
  );
  return { doc, pages };
}
const t = (title: string, page_ids: number[]): AiTopic => ({ title, summary: "s", page_ids, emphasized: false, concepts: [title + " concept"] });
const topics = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
const pagesOf = (x: Topic) => JSON.parse(x.page_ids) as number[];
const status = (examId: number) => (db.prepare("SELECT topic_status FROM exams WHERE id = ?").get(examId) as { topic_status: string }).topic_status;
const idsIn = (content: string) => [...content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));

function exam(date: string | null = null) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, exam_date) VALUES (?, 'E', ?)").run(userId, date).lastInsertRowid);
  return { userId, examId };
}

/** The AI splits whatever slides it was sent into sections of `size`, in the order given. */
const chunked = (size: number, reverse = false) => (content: string) => {
  const ids = idsIn(content);
  const out: AiTopic[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(t(`S${ids[i]}`, ids.slice(i, i + size)));
  return { topics: reverse ? out.reverse() : out };
};

beforeEach(() => {
  prompts.length = 0;
  statusDuringCall.length = 0;
  delay = 0;
  running = 0;
  maxRunning = 0;
  reply = chunked(3);
});

describe("per-lecture topic map", () => {
  it("one AI call per lecture with only that lecture's content slides; sections never mix lectures", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "Pulp biology.pdf", 7, [1]);
    const l2 = lecture(w.examId, "Diagnosis.pdf", 5);
    const l3 = lecture(w.examId, "Agenda only.pdf", 2, [1, 2]); // no content: no call, no section
    // A greedy AI puts every slide id of the exam it can think of into the first section.
    const all = [...l1.pages, ...l2.pages, ...l3.pages];
    reply = (content) => ({ topics: [t("Grab", all), t("Mine", idsIn(content))] });
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("ready");
    expect(prompts).toHaveLength(2);
    const sent = prompts.map(idsIn);
    expect(sent.find((s) => s.includes(l1.pages[1]))!.sort((a, b) => a - b)).toEqual(l1.pages.slice(1)); // title slide left out
    expect(sent.find((s) => s.includes(l2.pages[0]))!.sort((a, b) => a - b)).toEqual(l2.pages);
    for (const x of topics(w.examId)) {
      const docs = new Set(pagesOf(x).map((p) => (l1.pages.includes(p) ? l1.doc : l2.pages.includes(p) ? l2.doc : -1)));
      expect([...docs]).toEqual([x.document_id]);
    }
    const flat = topics(w.examId).flatMap(pagesOf);
    expect(flat.sort((a, b) => a - b)).toEqual([...l1.pages.slice(1), ...l2.pages].sort((a, b) => a - b));
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("positions are lecture-major (upload order), sections and their slides in slide order, even when the AI lists them backwards", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 7);
    const l2 = lecture(w.examId, "L2.pdf", 5);
    reply = (content) => {
      const ids = idsIn(content).reverse(); // slides backwards, sections backwards
      const out: AiTopic[] = [];
      for (let i = 0; i < ids.length; i += 3) out.push(t(`S${i}`, ids.slice(i, i + 3)));
      return { topics: out };
    };
    await buildTopicMap(w.examId);
    const now = topics(w.examId);
    expect(now.map((x) => x.position)).toEqual(now.map((_, i) => i));
    expect(now.flatMap(pagesOf)).toEqual([...l1.pages, ...l2.pages]);
    expect(now.map((x) => x.document_id)).toEqual([l1.doc, l1.doc, l1.doc, l2.doc, l2.doc]);
  });

  it("maps lectures 3 at a time", async () => {
    const w = exam();
    for (let i = 1; i <= 6; i++) lecture(w.examId, `L${i}.pdf`, 3);
    delay = 20;
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(6);
    expect(maxRunning).toBe(3);
    expect(status(w.examId)).toBe("ready");
  });

  it("auto after an upload maps only the new lecture and appends it; mapped lectures keep ids, positions, lessons and quizzes", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    const l2 = lecture(w.examId, "L2.pdf", 6);
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    for (const x of before) db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[]', checks_version = 2 WHERE id = ?").run(x.id);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, before[1].id);
    const l3 = lecture(w.examId, "L3.pdf", 4);
    prompts.length = 0;
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(1);
    expect(idsIn(prompts[0]).sort((a, b) => a - b)).toEqual(l3.pages);
    const now = topics(w.examId);
    expect(now.slice(0, before.length).map((x) => [x.id, x.position, x.lesson_json, x.checks_version])).toEqual(before.map((x) => [x.id, x.position, "L", 2]));
    expect(now.slice(before.length).every((x) => x.document_id === l3.doc)).toBe(true);
    expect(now.slice(before.length).flatMap(pagesOf)).toEqual(l3.pages);
    expect(now.map((x) => x.position)).toEqual(now.map((_, i) => i));
    expect(db.prepare("SELECT 1 x FROM topic_study WHERE topic_id = ?").get(before[1].id)).toEqual({ x: 1 });
    void l1;
    void l2;
  });

  it("auto: a mapped lecture that gains a slide (a retried slide) gets it in the nearest section without an AI call", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    // Slide 4 failed at first: not read yet.
    db.prepare("UPDATE pages SET status = 'error' WHERE id = ?").run(l1.pages[3]);
    await buildTopicMap(w.examId);
    const [a, b] = topics(w.examId);
    expect(pagesOf(a)).toEqual(l1.pages.slice(0, 3));
    expect(pagesOf(b)).toEqual([l1.pages[4], l1.pages[5]]);
    db.prepare("UPDATE topics SET lesson_json = 'L' WHERE exam_id = ?").run(w.examId);
    db.prepare("UPDATE pages SET status = 'done' WHERE id = ?").run(l1.pages[3]);
    prompts.length = 0;
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(0);
    const now = topics(w.examId);
    expect(now.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(now.flatMap(pagesOf)).toEqual(l1.pages);
    // Slide 4 is next to slide 3 and slide 5 (a tie): it joins the earlier section, whose lesson is rewritten to include it.
    expect(pagesOf(now[0])).toEqual(l1.pages.slice(0, 4));
    expect(now[0].lesson_json).toBeNull();
    expect(now[1].lesson_json).toBe("L");
  });

  it("full (Rebuild) re-maps every lecture and keeps topic ids whose slides mostly match", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    const l2 = lecture(w.examId, "L2.pdf", 6);
    await buildTopicMap(w.examId);
    const before = topics(w.examId); // L1: 1-3, 4-6; L2: 1-3, 4-6
    for (const x of before) db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[]', checks_version = 2 WHERE id = ?").run(x.id);
    // Rebuild: L1 the same; L2 split 1-4, 5-6 (the first still matches, the second too: 2 of 2 new and 2 of 3 old).
    reply = (content) => {
      const ids = idsIn(content);
      return ids.includes(l1.pages[0]) ? { topics: [t("A", ids.slice(0, 3)), t("B", ids.slice(3))] } : { topics: [t("C2", ids.slice(0, 4)), t("D2", ids.slice(4))] };
    };
    prompts.length = 0;
    await buildTopicMap(w.examId, "full");
    expect(prompts).toHaveLength(2);
    const now = topics(w.examId);
    expect(now.map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(now.map((x) => x.document_id)).toEqual([l1.doc, l1.doc, l2.doc, l2.doc]);
    expect(now[0].lesson_json).toBe("L"); // unchanged slides: lesson and quiz kept
    expect(now[2].lesson_json).toBeNull(); // slides changed: rewritten
    expect(now[2].checks_json).toBeNull();
    expect(pagesOf(now[2])).toEqual(l2.pages.slice(0, 4));
  });

  it("practice questions are filed under the section that holds their slide", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    const l2 = lecture(w.examId, "L2.pdf", 4);
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, NULL, 'recall', 's', '[]', 0, 'e', ?)");
    const q1 = Number(ins.run(w.examId, l1.pages[3]).lastInsertRowid);
    const q2 = Number(ins.run(w.examId, l2.pages[0]).lastInsertRowid);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    const holder = (p: number) => topics(w.examId).find((x) => pagesOf(x).includes(p))!.id;
    expect((db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q1) as { topic_id: number }).topic_id).toBe(holder(l1.pages[3]));
    expect((db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q2) as { topic_id: number }).topic_id).toBe(holder(l2.pages[0]));
  });

  it("removing a lecture removes its sections and keeps the others numbered 0..n-1", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    const l2 = lecture(w.examId, "L2.pdf", 6);
    await buildTopicMap(w.examId);
    await removeDocument(l1.doc);
    const now = topics(w.examId);
    expect(now.every((x) => x.document_id === l2.doc)).toBe(true);
    expect(now.map((x) => x.position)).toEqual([0, 1]);
  });
});

/** An exam mapped the old way: topics across lectures, no document_id. */
function oldStyleExam(date: string | null = null) {
  const w = exam(date);
  const l1 = lecture(w.examId, "L1.pdf", 4);
  const l2 = lecture(w.examId, "L2.pdf", 4);
  const ins = db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, lesson_json, checks_json, checks_version) VALUES (?, ?, ?, 's', ?, 'L', '[]', 2)");
  // Topic A = L1 slides 1-3 (matches a new section exactly), topic B mixes L1 slide 4 with all of L2.
  const a = Number(ins.run(w.examId, 0, "A", JSON.stringify(l1.pages.slice(0, 3))).lastInsertRowid);
  const b = Number(ins.run(w.examId, 1, "B", JSON.stringify([l1.pages[3], ...l2.pages])).lastInsertRowid);
  db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
  db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, a);
  return { ...w, l1, l2, a, b };
}

describe("startup upgrade: rebuildLectureMaps", () => {
  beforeEach(() => {
    // The upgrade looks at every exam in the database: start each case from none.
    db.prepare("DELETE FROM exams").run();
    db.prepare("DELETE FROM meta WHERE key LIKE 'lecture_maps_v1:%'").run();
  });

  it("re-maps an old-style exam by lecture, keeps a matching topic (and its progress), shows 'building' meanwhile, rebuilds the plan", async () => {
    const date = addDays(todayIn("America/New_York"), 20);
    const w = oldStyleExam(date);
    plannerSettings(w.userId);
    reply = chunked(3);
    expect(await rebuildLectureMaps()).toBe(1);
    expect(statusDuringCall.length).toBeGreaterThan(0);
    expect(statusDuringCall.every((s) => s === "building")).toBe(true);
    expect(status(w.examId)).toBe("ready");
    const now = topics(w.examId);
    expect(now.every((x) => x.document_id != null)).toBe(true);
    expect(now.map((x) => x.document_id)).toEqual([w.l1.doc, w.l1.doc, w.l2.doc, w.l2.doc]);
    expect(now[0].id).toBe(w.a);
    expect(now[0].lesson_json).toBe("L");
    expect(db.prepare("SELECT 1 x FROM topic_study WHERE topic_id = ?").get(w.a)).toEqual({ x: 1 });
    expect(getMeta(lectureMapsKey(w.examId))).toBe("done");
    // The plan now points at the new sections.
    const learn = db.prepare("SELECT topic_ids FROM plan_tasks WHERE user_id = ? AND kind = 'learn' AND status = 'todo'").all(w.userId) as { topic_ids: string }[];
    const ids = new Set(now.map((x) => x.id));
    expect(learn.length).toBeGreaterThan(0);
    for (const l of learn) for (const id of JSON.parse(l.topic_ids) as number[]) expect(ids.has(id)).toBe(true);
  });

  it("is idempotent: a second start does nothing (no AI call)", async () => {
    oldStyleExam();
    await rebuildLectureMaps();
    prompts.length = 0;
    expect(await rebuildLectureMaps()).toBe(0);
    expect(prompts).toHaveLength(0);
  });

  it("is resumable: exams already done in an earlier start are skipped, the rest run one at a time", async () => {
    const first = oldStyleExam();
    const second = oldStyleExam();
    setMeta(lectureMapsKey(first.examId), "done"); // reached before the restart
    delay = 10;
    expect(await rebuildLectureMaps()).toBe(1);
    expect(topics(first.examId).every((x) => x.document_id == null)).toBe(true);
    expect(topics(second.examId).every((x) => x.document_id != null)).toBe(true);
    expect(maxRunning).toBeLessThanOrEqual(3); // one exam at a time; within it, lectures 3 at a time
  });

  it("skips exams with no read lecture, and exams already mapped by lecture", async () => {
    const reading = exam();
    const l = lecture(reading.examId, "Still reading.pdf", 3, [], "processing");
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Old', 's', ?)").run(reading.examId, JSON.stringify(l.pages));
    const mapped = exam();
    lecture(mapped.examId, "L1.pdf", 3);
    await buildTopicMap(mapped.examId);
    prompts.length = 0;
    expect(await rebuildLectureMaps()).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(getMeta(lectureMapsKey(reading.examId))).toBeNull();
  });

  it("a failure is logged and skipped: the old map stays usable, the exam isn't tried again, the next exam still runs", async () => {
    const bad = oldStyleExam();
    const good = oldStyleExam();
    const badIds = new Set([...bad.l1.pages, ...bad.l2.pages]);
    reply = (content) => {
      if (idsIn(content).some((id) => badIds.has(id))) throw new Error("AI down");
      return chunked(3)(content);
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await rebuildLectureMaps()).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect(topics(bad.examId).map((x) => x.id)).toEqual([bad.a, bad.b]);
    expect(status(bad.examId)).toBe("ready");
    // One failed try is recorded; the good exam was still done.
    expect(getMeta(lectureMapsKey(bad.examId))).toBe("failed:1");
    expect(topics(good.examId).every((x) => x.document_id != null)).toBe(true);
    // The next start tries the failed exam again (an AI outage shouldn't leave it on the old map for good)…
    prompts.length = 0;
    const err2 = vi.spyOn(console, "error").mockImplementation(() => {});
    await rebuildLectureMaps();
    err2.mockRestore();
    expect(prompts.length).toBeGreaterThan(0);
    expect(getMeta(lectureMapsKey(bad.examId))).toBe("failed:2");
    // …up to three times; after that it is left alone until someone presses Rebuild.
    setMeta(lectureMapsKey(bad.examId), "failed:3");
    prompts.length = 0;
    await rebuildLectureMaps();
    expect(prompts).toHaveLength(0);
  });
});

describe("class sharing", () => {
  it("copyExam carries each section's lecture over to the copied lecture", async () => {
    const a = makeUser();
    const b = makeUser();
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Shared')").run(a).lastInsertRowid);
    lecture(examId, "L1.pdf", 4);
    lecture(examId, "L2.pdf", 4);
    reply = chunked(2);
    await buildTopicMap(examId);
    const classId = createClass(a, "C");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    joinClass(b, code);
    expect(shareExam(a, classId, examId)).toBeNull();
    const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(examId) as { id: number }).id;
    const copyId = (addSharedExam(b, sharedId) as { examId: number }).examId;
    const copied = topics(copyId);
    expect(copied).toHaveLength(4);
    const docOf = new Map(
      (db.prepare("SELECT p.id, p.document_id, d.filename FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ?").all(copyId) as {
        id: number;
        document_id: number;
        filename: string;
      }[]).map((p) => [p.id, p]),
    );
    for (const x of copied) {
      expect(x.document_id).not.toBeNull();
      for (const p of pagesOf(x)) expect(docOf.get(p)!.document_id).toBe(x.document_id);
    }
    expect(copied.map((x) => docOf.get(pagesOf(x)[0])!.filename)).toEqual(["L1.pdf", "L1.pdf", "L2.pdf", "L2.pdf"]);
  });
});

describe("grouping helpers and lecture progress", () => {
  it("groupByLecture / sectionPlaces: lectures numbered in upload order, sections numbered inside each", () => {
    const docs = [
      { id: 20, filename: "Diagnosis.pdf" },
      { id: 10, filename: "Pulp biology.pdf" },
      { id: 30, filename: "Still reading.pdf" },
    ];
    const s = (id: number, position: number, document_id: number | null) => ({ id, position, document_id });
    const sections = [s(1, 0, 10), s(2, 1, 10), s(3, 2, 20), s(4, 3, 20), s(5, 4, 20)];
    const groups = groupByLecture(sections, docs);
    expect(groups.map((g) => [g.no, g.name, g.sections.map((x) => x.id)])).toEqual([
      [1, "Pulp biology", [1, 2]],
      [2, "Diagnosis", [3, 4, 5]],
    ]);
    const places = sectionPlaces(sections, docs);
    expect(places.get(4)).toEqual({ lectureId: 20, lectureNo: 2, lecture: "Diagnosis", section: 2, sections: 3 });
    // Old-style topics: one group with no lecture.
    expect(groupByLecture([s(9, 0, null)], docs)).toEqual([{ docId: null, no: null, name: "Topics", sections: [s(9, 0, null)] }]);
  });

  it("a lecture is done when every one of its sections is studied (by this student)", async () => {
    const w = exam();
    lecture(w.examId, "L1.pdf", 4);
    lecture(w.examId, "L2.pdf", 4);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    const [s1, s2, s3] = topics(w.examId);
    const study = db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)");
    study.run(w.userId, s1.id);
    study.run(w.userId, s3.id);
    expect(lectureProgressMany(w.userId, [w.examId]).get(w.examId)).toEqual({ lectures: 2, done: 0 });
    study.run(w.userId, s2.id);
    expect(lectureProgressMany(w.userId, [w.examId]).get(w.examId)).toEqual({ lectures: 2, done: 1 });
    expect(lectureProgressMany(makeUser(), [w.examId]).get(w.examId)).toEqual({ lectures: 2, done: 0 });
  });
});
