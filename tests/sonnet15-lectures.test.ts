// Sonnet QA 15 — attack tests for Release 3 Job A (topic maps by lecture, commit 363f248).
// Tests named "BUG: ..." expose a real defect and are left failing on purpose.
import { beforeEach, describe, expect, it, vi } from "vitest";

type AiTopic = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[] };
let reply: (content: string, call: number) => { topics: AiTopic[] } = () => ({ topics: [] });
let delayFor: (content: string, call: number) => number = () => 0;
/** Awaited inside every AI call before it answers (lets a test do something "while the AI is thinking"). */
let hook: ((content: string, call: number) => Promise<void>) | null = null;
let calls = 0;
let running = 0;
let maxRunning = 0;
const prompts: string[] = [];
const noKeyUsers = new Set<number>();
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    if (opts.purpose !== "topic map") throw new Error("unexpected " + opts.purpose);
    const call = ++calls;
    prompts.push(opts.content);
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      const d = delayFor(opts.content, call);
      if (d) await new Promise((r) => setTimeout(r, d));
      if (hook) await hook(opts.content, call);
      return reply(opts.content, call);
    } finally {
      running--;
    }
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => {
    if (noKeyUsers.has(userId)) throw new Error("No API key set");
    return { userId, provider: "anthropic", apiKey: "k" };
  },
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

/**
 * A lecture of `n` slides. `filler`: 1-based title/agenda slides. `pending`: 1-based slides not read yet.
 * Document status defaults to "done".
 */
function lecture(examId: number, name: string, n: number, o: { filler?: number[]; status?: string; pending?: number[] } = {}) {
  const doc = Number(
    db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, ?, ?)").run(examId, name, o.status ?? "done", n).lastInsertRowid,
  );
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, ?, ?, ?)")
        .run(
          doc,
          i + 1,
          `doc-${doc}/p${i + 1}.jpg`,
          o.pending?.includes(i + 1) ? "pending" : "done",
          o.pending?.includes(i + 1) ? null : notes(`${name} s${i + 1}`, !!o.filler?.includes(i + 1)),
        ).lastInsertRowid,
    ),
  );
  return { doc, pages };
}
const t = (title: string, page_ids: number[]): AiTopic => ({ title, summary: "s", page_ids, emphasized: false, concepts: [title + " concept"] });
const topics = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
const pagesOf = (x: Topic) => JSON.parse(x.page_ids) as number[];
const status = (examId: number) => (db.prepare("SELECT topic_status FROM exams WHERE id = ?").get(examId) as { topic_status: string }).topic_status;
const topicError = (examId: number) => (db.prepare("SELECT topic_error FROM exams WHERE id = ?").get(examId) as { topic_error: string | null }).topic_error;
const idsIn = (content: string) => [...content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

function exam(date: string | null = null) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, exam_date) VALUES (?, 'E', ?)").run(userId, date).lastInsertRowid);
  return { userId, examId };
}
const chunked = (size: number) => (content: string) => {
  const ids = idsIn(content);
  const out: AiTopic[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(t(`S${ids[i]}`, ids.slice(i, i + size)));
  return { topics: out };
};

/** Every invariant a lecture-based map must keep, for one exam. */
function checkMap(examId: number) {
  const tps = topics(examId);
  expect(tps.map((x) => x.position)).toEqual(tps.map((_, i) => i));
  const slide = new Map(
    (
      db
        .prepare("SELECT p.id, p.document_id, p.page_number, p.notes_json, p.status FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ?")
        .all(examId) as { id: number; document_id: number; page_number: number; notes_json: string | null; status: string }[]
    ).map((p) => [p.id, p]),
  );
  const seen = new Set<number>();
  let prev: { doc: number; first: number } | null = null;
  for (const x of tps) {
    const ids = pagesOf(x);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      const p = slide.get(id)!;
      expect(p).toBeTruthy();
      if (x.document_id != null) expect(p.document_id).toBe(x.document_id);
      expect(JSON.parse(p.notes_json!).is_filler).toBe(false);
    }
    const nums = ids.map((id) => slide.get(id)!.page_number);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    if (x.document_id != null) {
      const cur = { doc: x.document_id, first: nums[0] };
      if (prev) expect(cur.doc > prev.doc || (cur.doc === prev.doc && cur.first > prev.first)).toBe(true);
      prev = cur;
    }
  }
  return seen;
}
const contentSlides = (examId: number) =>
  (db.prepare("SELECT p.id, p.notes_json FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ? AND p.status = 'done'").all(examId) as {
    id: number;
    notes_json: string;
  }[])
    .filter((p) => !JSON.parse(p.notes_json).is_filler)
    .map((p) => p.id);

beforeEach(() => {
  prompts.length = 0;
  calls = 0;
  running = 0;
  maxRunning = 0;
  hook = null;
  delayFor = () => 0;
  reply = chunked(3);
  noKeyUsers.clear();
  db.prepare("DELETE FROM exams").run();
  db.prepare("DELETE FROM meta WHERE key LIKE 'lecture_maps_v1:%'").run();
});

// ---------------------------------------------------------------------------------------------------------------
describe("A. what the AI gets wrong", () => {
  it("omitted slides join the nearest section of their own lecture; every content slide ends up in exactly one section", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 8, { filler: [1] });
    const l2 = lecture(w.examId, "L2.pdf", 4);
    reply = (c) => {
      const ids = idsIn(c);
      // L1 (slides 2..8): only 2,3 and 6,7 placed. L2: nothing but slide 1.
      return ids.includes(l1.pages[1]) ? { topics: [t("A", [l1.pages[1], l1.pages[2]]), t("B", [l1.pages[5], l1.pages[6]])] } : { topics: [t("X", [ids[0]])] };
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("ready");
    const seen = checkMap(w.examId);
    expect(sorted([...seen])).toEqual(sorted(contentSlides(w.examId)));
    const now = topics(w.examId);
    // slide 4 (idx 3) is nearer slide 3 (A); slide 5 nearer slide 6 (B); slide 8 nearer 7 (B)
    expect(pagesOf(now[0])).toEqual([l1.pages[1], l1.pages[2], l1.pages[3]]);
    expect(pagesOf(now[1])).toEqual([l1.pages[4], l1.pages[5], l1.pages[6], l1.pages[7]]);
    expect(now[2].document_id).toBe(l2.doc);
    expect(pagesOf(now[2])).toEqual(l2.pages);
  });

  it("invented ids, ids of another lecture, ids of title/agenda slides, negative and fractional ids are all dropped", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 5, { filler: [1] });
    const l2 = lecture(w.examId, "L2.pdf", 3);
    reply = (c) => {
      const mine = idsIn(c);
      return { topics: [t("Spam", [999999, -4, 2.5, l2.pages[0], l1.pages[0], ...mine.slice(0, 2)]), t("Rest", mine.slice(2))] };
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("ready");
    checkMap(w.examId);
    const flat = topics(w.examId).flatMap(pagesOf);
    expect(flat).not.toContain(l1.pages[0]); // title slide never studied
    expect(topics(w.examId).filter((x) => x.document_id === l1.doc).flatMap(pagesOf)).toEqual(l1.pages.slice(1));
    expect(topics(w.examId).filter((x) => x.document_id === l2.doc).flatMap(pagesOf)).toEqual(l2.pages);
  });

  it("a slide listed in two sections stays in the first; sections that interleave still come out in slide order", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    reply = () => ({ topics: [t("Late", [l1.pages[4], l1.pages[5], l1.pages[1]]), t("Early", [l1.pages[1], l1.pages[0], l1.pages[2], l1.pages[3]])] });
    await buildTopicMap(w.examId);
    checkMap(w.examId);
    const now = topics(w.examId);
    expect(now.map(pagesOf)).toEqual([[l1.pages[0], l1.pages[2], l1.pages[3]], [l1.pages[1], l1.pages[4], l1.pages[5]]]);
  });

  it("auto: an answer with nothing usable for a new lecture gives one whole-lecture section (no slide lost); full: the Rebuild fails and the old map stays", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    reply = () => ({ topics: [t("Nothing", [424242]), t("Empty", [])] });
    await buildTopicMap(w.examId); // no map yet → fullMap path → error
    expect(status(w.examId)).toBe("error");
    expect(topics(w.examId)).toHaveLength(0);
    expect(topicError(w.examId)).toMatch(/empty/i);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    expect(before).toHaveLength(2);
    const l2 = lecture(w.examId, "L2.pdf", 4);
    reply = () => ({ topics: [] });
    await buildTopicMap(w.examId); // auto with an existing map → new lecture falls back to a single section
    const now = topics(w.examId);
    expect(status(w.examId)).toBe("ready");
    expect(now.slice(0, 2).map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(now).toHaveLength(3);
    expect(now[2].document_id).toBe(l2.doc);
    expect(pagesOf(now[2])).toEqual(l2.pages);
    expect(now[2].title).toBe("L2");
    await buildTopicMap(w.examId, "full"); // Rebuild with an AI that places nothing: fails, nothing changes
    expect(status(w.examId)).toBe("error");
    expect(topics(w.examId).map((x) => [x.id, x.position, x.page_ids])).toEqual(now.map((x) => [x.id, x.position, x.page_ids]));
    void l1;
  });

  it("blank concept names are not stored; a concept named by two sections is one concept linked twice", async () => {
    const w = exam();
    lecture(w.examId, "L1.pdf", 4);
    reply = (c) => {
      const ids = idsIn(c);
      return {
        topics: [
          { title: "A", summary: "s", page_ids: ids.slice(0, 2), emphasized: false, concepts: ["Pulp", "  ", ""] },
          { title: "B", summary: "s", page_ids: ids.slice(2), emphasized: true, concepts: ["Pulp"] },
        ],
      };
    };
    await buildTopicMap(w.examId);
    const rows = db
      .prepare("SELECT c.name, COUNT(*) n FROM topic_concepts tc JOIN concepts c ON c.id = tc.concept_id JOIN topics t ON t.id = tc.topic_id WHERE t.exam_id = ? GROUP BY c.id")
      .all(w.examId) as { name: string; n: number }[];
    expect(rows).toEqual([{ name: "Pulp", n: 2 }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("B. concurrency and mixed states", () => {
  it("three lectures answered in reverse order never swap slides", async () => {
    const w = exam();
    const ls = [lecture(w.examId, "L1.pdf", 4), lecture(w.examId, "L2.pdf", 4), lecture(w.examId, "L3.pdf", 4)];
    delayFor = (c) => (idsIn(c).includes(ls[0].pages[0]) ? 60 : idsIn(c).includes(ls[1].pages[0]) ? 30 : 5);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    const now = topics(w.examId);
    expect(now.map((x) => x.document_id)).toEqual([ls[0].doc, ls[0].doc, ls[1].doc, ls[1].doc, ls[2].doc, ls[2].doc]);
    expect(now.flatMap(pagesOf)).toEqual(ls.flatMap((l) => l.pages));
    checkMap(w.examId);
  });

  it("two auto requests at once share one run (one AI call per lecture)", async () => {
    const w = exam();
    lecture(w.examId, "L1.pdf", 4);
    lecture(w.examId, "L2.pdf", 4);
    delayFor = () => 10;
    await Promise.all([buildTopicMap(w.examId), buildTopicMap(w.examId)]);
    expect(prompts).toHaveLength(2);
  });

  it("a Rebuild asked while an automatic run is going runs after it and the result is consistent", async () => {
    const w = exam();
    lecture(w.examId, "L1.pdf", 6);
    delayFor = () => 20;
    const a = buildTopicMap(w.examId);
    const b = buildTopicMap(w.examId, "full");
    await Promise.all([a, b]);
    expect(prompts).toHaveLength(2);
    expect(status(w.examId)).toBe("ready");
    checkMap(w.examId);
  });

  it("an exam with one lecture still being read (nothing read yet) and one done: only the done one is mapped, then the other is appended", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    const l2 = lecture(w.examId, "L2.pdf", 4, { status: "processing", pending: [1, 2, 3, 4] });
    await buildTopicMap(w.examId, "full");
    expect(topics(w.examId).every((x) => x.document_id === l1.doc)).toBe(true);
    expect(prompts).toHaveLength(1);
    db.prepare("UPDATE documents SET status = 'done' WHERE id = ?").run(l2.doc);
    for (const [i, id] of l2.pages.entries()) db.prepare("UPDATE pages SET status = 'done', notes_json = ? WHERE id = ?").run(notes(`L2 s${i + 1}`), id);
    prompts.length = 0;
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(1);
    expect(topics(w.examId).filter((x) => x.document_id === l2.doc).flatMap(pagesOf)).toEqual(l2.pages);
    checkMap(w.examId);
  });

  it("BUG: a lecture that is only half read is mapped from its first slides, then the rest are dumped into the last section with no AI call", async () => {
    // Happens at the first start after deploy: resumeUnfinished() resumes a direct read while rebuildLectureMaps() maps the exam.
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6, { status: "processing", pending: [4, 5, 6] });
    reply = chunked(3);
    await buildTopicMap(w.examId, "full");
    // The lecture finishes reading.
    db.prepare("UPDATE documents SET status = 'done' WHERE id = ?").run(l1.doc);
    for (const i of [3, 4, 5]) db.prepare("UPDATE pages SET status = 'done', notes_json = ? WHERE id = ?").run(notes(`L1 s${i + 1}`), l1.pages[i]);
    await buildTopicMap(w.examId); // what finishDocument() does
    // Expected: the AI sees the whole lecture and gives 2 sections of 3. (Fixed by leaving a lecture that is still being
    // read out of the map entirely: the first run makes no AI call for it, the run after it finishes maps it whole.)
    expect(topics(w.examId)).toHaveLength(2);
    expect(topics(w.examId).flatMap(pagesOf)).toEqual(l1.pages);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
  });

  it("BUG: an automatic request that arrives while a full run is going is swallowed; the lecture that just finished stays unmapped", async () => {
    const w = exam();
    lecture(w.examId, "L1.pdf", 4);
    delayFor = () => 40;
    const full = buildTopicMap(w.examId, "full"); // e.g. the startup upgrade, or the Rebuild button
    await new Promise((r) => setTimeout(r, 15)); // the AI is thinking; the page snapshot is already taken
    const l2 = lecture(w.examId, "L2.pdf", 4); // a lecture finishes reading → finishDocument() asks for an automatic build
    const auto = buildTopicMap(w.examId);
    await Promise.all([full, auto]);
    expect(topics(w.examId).some((x) => x.document_id === l2.doc)).toBe(true);
  });

  it("a lecture of only title/agenda slides gets no AI call and no section; the lectures around it are numbered and mapped normally", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    lecture(w.examId, "Agenda.pdf", 2, { filler: [1, 2] });
    const l3 = lecture(w.examId, "L3.pdf", 4);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(2);
    expect(topics(w.examId).map((x) => x.document_id)).toEqual([l1.doc, l1.doc, l3.doc, l3.doc]);
    // Later: the agenda-only lecture is the only new upload → auto is a no-op that still ends 'ready'.
    lecture(w.examId, "Agenda2.pdf", 2, { filler: [1, 2] });
    prompts.length = 0;
    const before = topics(w.examId).map((x) => [x.id, x.position]);
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(0);
    expect(status(w.examId)).toBe("ready");
    expect(topics(w.examId).map((x) => [x.id, x.position])).toEqual(before);
  });

  it("an exam whose only lecture is title/agenda slides ends in a plain error, with no topics", async () => {
    const w = exam();
    lecture(w.examId, "Agenda.pdf", 2, { filler: [1, 2] });
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("error");
    expect(topics(w.examId)).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("one lecture failing leaves the old map untouched (full) and adds nothing (auto), and the next try works", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    const l2 = lecture(w.examId, "L2.pdf", 4);
    const l3 = lecture(w.examId, "L3.pdf", 4);
    reply = (c) => {
      if (idsIn(c).includes(l3.pages[0])) throw new Error("rate limit");
      return chunked(2)(c);
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("error");
    expect(topics(w.examId).map((x) => [x.id, x.position, x.page_ids])).toEqual(before.map((x) => [x.id, x.position, x.page_ids]));
    reply = chunked(2);
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("ready");
    expect(topics(w.examId).map((x) => x.document_id)).toEqual([l1.doc, l1.doc, l2.doc, l2.doc, l3.doc, l3.doc]);
    checkMap(w.examId);
  });

  it("BUG: after one lecture's map fails, the remaining lectures are still sent to the AI (paid for, then thrown away)", async () => {
    const w = exam();
    for (let i = 1; i <= 8; i++) lecture(w.examId, `L${i}.pdf`, 3);
    delayFor = () => 15;
    reply = (c, call) => {
      if (call === 1) throw new Error("rate limit");
      return chunked(3)(c);
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("error");
    await new Promise((r) => setTimeout(r, 200)); // let the other workers drain
    // Three calls were already in flight when the first failed; nothing new should start after that.
    expect(calls).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("C. Rebuild keeps what it should", () => {
  async function mapped(sizeL1 = 6, sizeL2 = 6) {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", sizeL1);
    const l2 = lecture(w.examId, "L2.pdf", sizeL2);
    reply = chunked(3);
    await buildTopicMap(w.examId);
    return { ...w, l1, l2 };
  }

  it("a section with the same slides keeps its id, lesson, quiz, answers and study tick through a Rebuild; positions stay 0..n-1", async () => {
    const w = await mapped();
    const before = topics(w.examId);
    const sess = Number(db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, 3)").run(w.examId).lastInsertRowid);
    for (const x of before) {
      db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = ?, checks_version = 2 WHERE id = ?").run(JSON.stringify([{ question: "q" }]), x.id);
      db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'q', 1, 0, 1)").run(sess, x.id);
      db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, x.id);
    }
    await buildTopicMap(w.examId, "full");
    const now = topics(w.examId);
    expect(now.map((x) => x.id)).toEqual(before.map((x) => x.id));
    for (const x of now) {
      expect(x.lesson_json).toBe("L");
      expect(x.checks_json).toBe(JSON.stringify([{ question: "q" }]));
      expect(x.checks_version).toBe(2);
    }
    expect(db.prepare("SELECT COUNT(*) n FROM session_checks WHERE check_index IS NOT NULL").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT COUNT(*) n FROM topic_study").get()).toEqual({ n: 4 });
    checkMap(w.examId);
  });

  it("after a lecture is removed, Rebuild still matches the remaining sections by slides, not by position", async () => {
    const w = await mapped();
    const before = topics(w.examId);
    for (const x of before) db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(`L${x.id}`, x.id);
    await removeDocument(w.l1.doc);
    await buildTopicMap(w.examId, "full");
    const now = topics(w.examId);
    expect(now.map((x) => x.id)).toEqual(before.slice(2).map((x) => x.id));
    expect(now.map((x) => x.lesson_json)).toEqual(before.slice(2).map((x) => `L${x.id}`));
    expect(now.map((x) => x.position)).toEqual([0, 1]);
  });

  it("a section split in two keeps its id on one half only; the other half is new; no id is used twice", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    reply = () => ({ topics: [t("Whole", l1.pages)] });
    await buildTopicMap(w.examId);
    const [old] = topics(w.examId);
    db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[1]', checks_version = 2 WHERE id = ?").run(old.id);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, old.id);
    reply = chunked(3);
    await buildTopicMap(w.examId, "full");
    const now = topics(w.examId);
    expect(now).toHaveLength(2);
    expect(now.filter((x) => x.id === old.id)).toHaveLength(1);
    expect(new Set(now.map((x) => x.id)).size).toBe(2);
    const kept = now.find((x) => x.id === old.id)!;
    // The kept half has different slides from before: its lesson and quiz are rewritten, its study tick stays.
    expect(kept.lesson_json).toBeNull();
    expect(kept.checks_json).toBeNull();
    expect(db.prepare("SELECT 1 x FROM topic_study WHERE topic_id = ?").get(old.id)).toEqual({ x: 1 });
    checkMap(w.examId);
  });

  it("NOTE: a kept section whose slides changed loses its quiz (plan §1 says 'quiz kept'; code and old behaviour rewrite it) — answers detach, not delete", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    reply = (c) => ({ topics: [t("A", idsIn(c).slice(0, 4)), t("B", idsIn(c).slice(4))] });
    await buildTopicMap(w.examId);
    const [a] = topics(w.examId);
    const sess = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId).lastInsertRowid);
    db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[1]', checks_version = 2 WHERE id = ?").run(a.id);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'q', 1, 0, 1)").run(sess, a.id);
    reply = (c) => ({ topics: [t("A", idsIn(c).slice(0, 3)), t("B", idsIn(c).slice(3))] });
    await buildTopicMap(w.examId, "full");
    expect(topics(w.examId)[0].id).toBe(a.id);
    expect(topics(w.examId)[0].checks_json).toBeNull();
    expect(db.prepare("SELECT check_index FROM session_checks WHERE topic_id = ?").get(a.id)).toEqual({ check_index: null });
    void l1;
  });

  it("practice questions follow their slide to the new section; answered questions keep their practice history and stay out of 'unused'", async () => {
    const w = await mapped();
    const before = topics(w.examId); // L1: 1-3, 4-6   L2: 1-3, 4-6
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)");
    const qa = Number(ins.run(w.examId, before[0].id, w.l1.pages[2]).lastInsertRowid); // answered, slide 3 of L1
    const qb = Number(ins.run(w.examId, before[0].id, w.l1.pages[1]).lastInsertRowid); // unanswered, slide 2
    const att = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(w.examId).lastInsertRowid);
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct) VALUES (?, ?, 0, 1, 0)").run(att, qa);
    // Rebuild: L1 now 1-2 / 3-6.
    reply = (c) => (idsIn(c).includes(w.l1.pages[0]) ? { topics: [t("A", idsIn(c).slice(0, 2)), t("B", idsIn(c).slice(2))] } : chunked(3)(c));
    await buildTopicMap(w.examId, "full");
    const holder = (p: number) => topics(w.examId).find((x) => pagesOf(x).includes(p))!.id;
    const topicOf = (q: number) => (db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id;
    expect(topicOf(qa)).toBe(holder(w.l1.pages[2]));
    expect(topicOf(qb)).toBe(holder(w.l1.pages[1]));
    expect(db.prepare("SELECT chosen_index FROM attempt_questions WHERE question_id = ?").get(qa)).toEqual({ chosen_index: 1 });
    // The practice writer's "unused" rule (practice.ts unusedQuestions), applied to every topic of the exam.
    const unused = db
      .prepare(
        `SELECT q.id FROM questions q WHERE q.exam_id = ? AND q.flagged = 0 AND q.case_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id WHERE aq.question_id = q.id
           AND (aq.chosen_index IS NOT NULL OR (a.status IN ('generating','ready') AND a.started_at > datetime('now','-1 day'))))`,
      )
      .all(w.examId) as { id: number }[];
    expect(unused.map((r) => r.id)).toEqual([qb]);
  });

  it("a question with no section (topic deleted, slide placed by the new map) is refiled; a question about a slide in no section stays unfiled", async () => {
    const w = await mapped();
    const before = topics(w.examId);
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)");
    const q = Number(ins.run(w.examId, before[3].id, w.l2.pages[4]).lastInsertRowid);
    const orphan = Number(ins.run(w.examId, before[3].id, null).lastInsertRowid);
    // Rebuild into a totally different split so before[3] vanishes.
    reply = (c) => ({ topics: [t("A", idsIn(c).slice(0, 1)), t("B", idsIn(c).slice(1, 5)), t("C", idsIn(c).slice(5))] });
    await buildTopicMap(w.examId, "full");
    const holder = topics(w.examId).find((x) => pagesOf(x).includes(w.l2.pages[4]))!.id;
    expect((db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id).toBe(holder);
    // No source slide, topic gone: nothing to follow. (pre-existing; recorded so a change is noticed)
    expect((db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(orphan) as { topic_id: number | null }).topic_id).toBeNull();
  });

  it("the study session's position is clamped when the map shrinks; another exam's session is untouched", async () => {
    const w = await mapped();
    const other = exam();
    lecture(other.examId, "O.pdf", 9);
    await buildTopicMap(other.examId);
    const s1 = Number(db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, 3)").run(w.examId).lastInsertRowid);
    const s2 = Number(db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, 2)").run(other.examId).lastInsertRowid);
    reply = (c) => ({ topics: [t("All", idsIn(c))] }); // 2 sections in total now
    await buildTopicMap(w.examId, "full");
    expect(topics(w.examId)).toHaveLength(2);
    expect((db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(s1) as { p: number }).p).toBe(1);
    expect((db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(s2) as { p: number }).p).toBe(2);
  });

  it("topics of another exam are never touched by a build", async () => {
    const a = await mapped();
    const b = await mapped();
    const snap = JSON.stringify(topics(b.examId));
    await buildTopicMap(a.examId, "full");
    expect(JSON.stringify(topics(b.examId))).toBe(snap);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D. removing a lecture", () => {
  it("removing the middle of three lectures: no dangling sections, positions contiguous, other sections keep their ids, lectures renumber, a new upload appends", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    const l2 = lecture(w.examId, "L2.pdf", 4);
    const l3 = lecture(w.examId, "L3.pdf", 4);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    for (const x of before) {
      db.prepare("UPDATE topics SET lesson_json = 'L' WHERE id = ?").run(x.id);
      db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, x.id);
    }
    db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, 5)").run(w.examId);
    await removeDocument(l2.doc);
    const now = topics(w.examId);
    expect(now.map((x) => x.id)).toEqual([before[0].id, before[1].id, before[4].id, before[5].id]);
    expect(now.map((x) => x.position)).toEqual([0, 1, 2, 3]);
    expect(now.map((x) => x.lesson_json)).toEqual(["L", "L", "L", "L"]);
    expect(db.prepare("SELECT COUNT(*) n FROM topic_study").get()).toEqual({ n: 4 });
    expect((db.prepare("SELECT current_position p FROM study_sessions WHERE exam_id = ?").get(w.examId) as { p: number }).p).toBe(3);
    expect(db.prepare("SELECT COUNT(*) n FROM topics WHERE document_id IS NOT NULL AND document_id NOT IN (SELECT id FROM documents)").get()).toEqual({ n: 0 });
    const docs = db.prepare("SELECT id, filename FROM documents WHERE exam_id = ? ORDER BY id").all(w.examId) as { id: number; filename: string }[];
    expect(sectionPlaces(now, docs).get(now[2].id)).toMatchObject({ lectureNo: 2, lecture: "L3", section: 1, sections: 2 });
    const l4 = lecture(w.examId, "L4.pdf", 4);
    await buildTopicMap(w.examId);
    const after = topics(w.examId);
    expect(after.slice(0, 4).map((x) => x.id)).toEqual(now.map((x) => x.id));
    expect(after.slice(4).every((x) => x.document_id === l4.doc)).toBe(true);
    checkMap(w.examId);
    void l1;
    void l3;
  });

  it("removing the last lecture empties the map and sets the exam back to 'none'; a new upload then builds from scratch", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    await buildTopicMap(w.examId);
    await removeDocument(l1.doc);
    expect(topics(w.examId)).toHaveLength(0);
    expect(status(w.examId)).toBe("none");
    lecture(w.examId, "L2.pdf", 4);
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("ready");
    checkMap(w.examId);
  });

  it("foreign keys are on, so deleting a lecture can never leave a section pointing at it", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 2);
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id) VALUES (?, 0, 't', 's', '[]', ?)").run(w.examId, l.doc);
    db.prepare("DELETE FROM documents WHERE id = ?").run(l.doc);
    expect(topics(w.examId)).toHaveLength(0);
  });

  it("an old-style section that spans the removed lecture keeps its other slides, loses lesson and quiz, and stays old-style", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    const l2 = lecture(w.examId, "L2.pdf", 4);
    const ins = db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, lesson_json, checks_json, checks_version) VALUES (?, ?, ?, 's', ?, 'L', '[1]', 2)");
    ins.run(w.examId, 0, "Mixed", JSON.stringify([l1.pages[3], ...l2.pages]));
    ins.run(w.examId, 1, "Only L2", JSON.stringify(l2.pages));
    await removeDocument(l2.doc);
    const now = topics(w.examId);
    expect(now).toHaveLength(1);
    expect(now[0].title).toBe("Mixed");
    expect(pagesOf(now[0])).toEqual([l1.pages[3]]);
    expect(now[0].document_id).toBeNull();
    expect(now[0].lesson_json).toBeNull();
    expect(now[0].checks_json).toBeNull();
    expect(now[0].position).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("E. startup upgrade", () => {
  function oldExam(userId?: number, date: string | null = null) {
    const w = userId ? { userId, examId: Number(db.prepare("INSERT INTO exams (user_id, name, exam_date) VALUES (?, 'E', ?)").run(userId, date).lastInsertRowid) } : exam(date);
    const l1 = lecture(w.examId, "L1.pdf", 4);
    const l2 = lecture(w.examId, "L2.pdf", 4);
    const ins = db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, lesson_json, checks_json, checks_version) VALUES (?, ?, ?, 's', ?, 'L', '[1]', 2)");
    const a = Number(ins.run(w.examId, 0, "A", JSON.stringify(l1.pages.slice(0, 3))).lastInsertRowid);
    const b = Number(ins.run(w.examId, 1, "B", JSON.stringify([l1.pages[3], ...l2.pages])).lastInsertRowid);
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    return { ...w, l1, l2, a, b };
  }

  it("an exam with a mix of old-style and lecture sections is upgraded to all-lecture", async () => {
    const w = oldExam();
    const l3 = lecture(w.examId, "L3.pdf", 3);
    await buildTopicMap(w.examId); // auto: appends L3 with a lecture id next to the old-style topics
    expect(topics(w.examId).map((x) => x.document_id)).toEqual([null, null, l3.doc]);
    prompts.length = 0;
    expect(await rebuildLectureMaps()).toBe(1);
    expect(topics(w.examId).every((x) => x.document_id != null)).toBe(true);
    checkMap(w.examId);
  });

  it("an exam with old-style topics but no lectures at all, or only lectures that failed, is skipped and not recorded", async () => {
    const noDocs = exam();
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Old', 's', '[]')").run(noDocs.examId);
    const failed = exam();
    lecture(failed.examId, "Bad.pdf", 3, { status: "error" });
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Old', 's', '[]')").run(failed.examId);
    expect(await rebuildLectureMaps()).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(getMeta(lectureMapsKey(noDocs.examId))).toBeNull();
    expect(getMeta(lectureMapsKey(failed.examId))).toBeNull();
  });

  it("if any one lecture of an exam fails, nothing of that exam changes (ids, positions, slides, lesson), status is ready and the exam is marked failed", async () => {
    const w = oldExam();
    const before = JSON.stringify(topics(w.examId));
    reply = (c) => {
      if (idsIn(c).includes(w.l2.pages[0])) throw new Error("boom");
      return chunked(2)(c);
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await rebuildLectureMaps()).toBe(0);
    err.mockRestore();
    expect(JSON.stringify(topics(w.examId))).toBe(before);
    expect(status(w.examId)).toBe("ready");
    expect(topicError(w.examId)).toBeNull();
    expect(getMeta(lectureMapsKey(w.examId))).toBe("failed:1");
  });

  it("an empty answer for one lecture is treated the same: old map kept, marked failed, others continue", async () => {
    const bad = oldExam();
    const good = oldExam();
    reply = (c) => (idsIn(c).includes(bad.l2.pages[0]) ? { topics: [] } : chunked(2)(c));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await rebuildLectureMaps()).toBe(1);
    err.mockRestore();
    expect(topics(bad.examId).map((x) => x.id)).toEqual([bad.a, bad.b]);
    expect(getMeta(lectureMapsKey(bad.examId))).toBe("failed:1");
    expect(topics(good.examId).every((x) => x.document_id != null)).toBe(true);
  });

  it("a student with no API key: the exam keeps its old map as 'ready' (no red error), is marked failed, and other students' exams still run", async () => {
    const poor = oldExam();
    const rich = oldExam();
    noKeyUsers.add(poor.userId);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await rebuildLectureMaps()).toBe(1);
    err.mockRestore();
    expect(status(poor.examId)).toBe("ready");
    expect(topics(poor.examId).every((x) => x.document_id == null)).toBe(true);
    expect(getMeta(lectureMapsKey(poor.examId))).toBe("failed:1");
    expect(topics(rich.examId).every((x) => x.document_id != null)).toBe(true);
  });

  it("after a failed upgrade, the Rebuild button still works and ends lecture-based", async () => {
    const w = oldExam();
    reply = () => {
      throw new Error("boom");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await rebuildLectureMaps();
    err.mockRestore();
    reply = chunked(2);
    await buildTopicMap(w.examId, "full");
    expect(status(w.examId)).toBe("ready");
    expect(topics(w.examId).every((x) => x.document_id != null)).toBe(true);
  });

  it("plan: future 'learn' tasks are re-made for the new sections (none points at a vanished topic); topic_study rows of vanished topics are gone, kept ones stay; another student's plan is not rebuilt", async () => {
    const date = addDays(todayIn("America/New_York"), 20);
    const w = oldExam(undefined, date);
    plannerSettings(w.userId);
    const bystander = makeUser();
    plannerSettings(bystander);
    db.prepare("INSERT INTO plan_tasks (user_id, date, kind, topic_ids, minutes, title) VALUES (?, ?, 'review', '[]', 10, 'sentinel')").run(bystander, addDays(todayIn("America/New_York"), 3));
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, w.a);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, w.b);
    // A stale future task for the old topic B (rebuildPlan deletes todo tasks from today on).
    db.prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, topic_ids, minutes, title) VALUES (?, ?, ?, 'learn', ?, 20, 'Study: B')").run(
      w.userId,
      addDays(todayIn("America/New_York"), 2),
      w.examId,
      JSON.stringify([w.b]),
    );
    // L1 as one section (A's 3 slides are 3 of 4 → A kept); L2 as 1-2 | 3-4 (B's 5 slides overlap nothing by half → B vanishes).
    reply = (c) => (idsIn(c).includes(w.l1.pages[0]) ? { topics: [t("L1 all", idsIn(c))] } : chunked(2)(c));
    await rebuildLectureMaps();
    const ids = new Set(topics(w.examId).map((x) => x.id));
    expect(ids.has(w.a)).toBe(true);
    // B is gone as a section (SQLite may hand its id to a new section: the sections are told apart by their slides, not their id).
    expect(topics(w.examId).filter((x) => pagesOf(x).includes(w.l1.pages[3]) && pagesOf(x).length > 4)).toHaveLength(0);
    const todo = db.prepare("SELECT topic_ids FROM plan_tasks WHERE user_id = ? AND status = 'todo'").all(w.userId) as { topic_ids: string }[];
    for (const r of todo) for (const id of JSON.parse(r.topic_ids) as number[]) expect(ids.has(id)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM topic_study WHERE topic_id = ?").get(w.b)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM topic_study WHERE topic_id = ?").get(w.a)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM plan_tasks WHERE title = 'sentinel'").get()).toEqual({ n: 1 });
  });

  it("BUG: a manual Rebuild that finishes while the upgrade is working on an earlier exam gets re-mapped again when the upgrade reaches it", async () => {
    const first = oldExam();
    const second = oldExam();
    let done = false;
    hook = async (c) => {
      if (done || !idsIn(c).some((id) => [...first.l1.pages, ...first.l2.pages].includes(id))) return;
      done = true;
      // Meanwhile the student on exam 2 taps "Rebuild" (the page offers it: "Tap Rebuild to split them by lecture").
      const saved = hook;
      hook = null;
      await buildTopicMap(second.examId, "full");
      hook = saved;
    };
    await rebuildLectureMaps();
    const forSecond = prompts.filter((p) => idsIn(p).some((id) => [...second.l1.pages, ...second.l2.pages].includes(id)));
    // Two lectures → two AI calls for the manual Rebuild. The upgrade must notice the exam is already lecture-based.
    expect(forSecond).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("F. class sharing", () => {
  function share(ownerId: number, examId: number) {
    const classId = createClass(ownerId, "C");
    const code = (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(classId) as { invite_code: string }).invite_code;
    const mate = makeUser();
    joinClass(mate, code);
    expect(shareExam(ownerId, classId, examId)).toBeNull();
    const sharedId = (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(examId) as { id: number }).id;
    return { mate, copyId: (addSharedExam(mate, sharedId) as { examId: number }).examId };
  }

  it("copied sections point at the COPIED lectures (never at the source's), with the same order and slide counts", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    const l2 = lecture(w.examId, "L2.pdf", 6);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    const { copyId } = share(w.userId, w.examId);
    const copyDocs = (db.prepare("SELECT id FROM documents WHERE exam_id = ? ORDER BY id").all(copyId) as { id: number }[]).map((d) => d.id);
    expect(copyDocs).toHaveLength(2);
    expect(copyDocs).not.toContain(l1.doc);
    expect(copyDocs).not.toContain(l2.doc);
    const copied = topics(copyId);
    const src = topics(w.examId);
    expect(copied.map((x) => x.document_id)).toEqual([copyDocs[0], copyDocs[0], copyDocs[1], copyDocs[1], copyDocs[1]]);
    expect(copied.map((x) => pagesOf(x).length)).toEqual(src.map((x) => pagesOf(x).length));
    expect(copied.map((x) => x.position)).toEqual(src.map((x) => x.position));
    checkMap(copyId);
    // The source is unchanged.
    expect(topics(w.examId).map((x) => x.document_id)).toEqual([l1.doc, l1.doc, l2.doc, l2.doc, l2.doc]);
  });

  it("copying an exam that still has old-style sections keeps them old-style (the copy's startup upgrade will handle them)", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 3);
    db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Old', 's', ?)").run(w.examId, JSON.stringify(l1.pages));
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    const { copyId } = share(w.userId, w.examId);
    expect(topics(copyId).map((x) => x.document_id)).toEqual([null]);
    expect(pagesOf(topics(copyId)[0])).toHaveLength(3);
  });

  it("BUG: copying an exam where one lecture failed to read (status 'error', but mapped from its good slides) makes empty sections with no lecture", async () => {
    const w = exam();
    lecture(w.examId, "L1.pdf", 4);
    lecture(w.examId, "L2.pdf", 4, { status: "error", pending: [4] });
    reply = chunked(2);
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("ready");
    const { copyId } = share(w.userId, w.examId);
    for (const x of topics(copyId)) {
      expect(pagesOf(x).length).toBeGreaterThan(0);
      expect(x.document_id).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("G. helpers and numbers", () => {
  it("groupByLecture: a section whose lecture row is missing is shown as 'Lecture' without a number, not dropped", () => {
    const g = groupByLecture([{ id: 1, position: 0, document_id: 77 }], [{ id: 5, filename: "A.pdf" }]);
    expect(g).toEqual([{ docId: 77, no: null, name: "Lecture", sections: [{ id: 1, position: 0, document_id: 77 }] }]);
  });

  it("groupByLecture/sectionPlaces: a lecture's sections that are not neighbours in position still form one group in position order; lectureName is case-insensitive", () => {
    const docs = [{ id: 1, filename: "x.PDF" }, { id: 2, filename: "y.pdf" }];
    const s = (id: number, position: number, document_id: number | null) => ({ id, position, document_id });
    const gs = groupByLecture([s(1, 0, 1), s(2, 1, 2), s(3, 2, 1)], docs);
    expect(gs.map((x) => [x.name, x.sections.map((z) => z.id)])).toEqual([["x", [1, 3]], ["y", [2]]]);
    expect(sectionPlaces([s(1, 0, null), s(2, 1, null)], docs).get(2)).toMatchObject({ lectureId: null, lectureNo: null, section: 2, sections: 2 });
  });

  it("lectureProgressMany: no sections → zero lectures; several exams in one call; duplicate and empty id lists are fine; another student's ticks don't count", async () => {
    const w = exam();
    const w2 = exam();
    lecture(w.examId, "L1.pdf", 4);
    lecture(w.examId, "L2.pdf", 4);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    for (const x of topics(w.examId)) db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, x.id);
    const m = lectureProgressMany(w.userId, [w.examId, w.examId, w2.examId]);
    expect(m.get(w.examId)).toEqual({ lectures: 2, done: 2 });
    expect(m.get(w2.examId)).toEqual({ lectures: 0, done: 0 });
    expect(lectureProgressMany(w.userId, []).size).toBe(0);
    expect(lectureProgressMany(makeUser(), [w.examId]).get(w.examId)).toEqual({ lectures: 2, done: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H. random answers keep every invariant", () => {
  /** Small deterministic generator, so a failure names its seed. */
  function prng(seed: number) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }

  it("150 random exams: partial/duplicated/invented/shuffled AI answers, then an upload, a retried slide, a Rebuild and a lecture removal", async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rnd = prng(seed * 2654435761);
      const pick = (n: number) => Math.floor(rnd() * n);
      const w = exam();
      const lectures: ReturnType<typeof lecture>[] = [];
      const addLecture = () => {
        const n = 1 + pick(12);
        const filler = Array.from({ length: n }, (_, i) => i + 1).filter(() => rnd() < 0.2);
        lectures.push(lecture(w.examId, `L${lectures.length + 1}.pdf`, n, { filler }));
      };
      for (let k = 1 + pick(4); k > 0; k--) addLecture();
      const allIds = () => lectures.flatMap((l) => l.pages);
      reply = (c) => {
        const mine = idsIn(c);
        const sections = 1 + pick(5);
        const out: AiTopic[] = Array.from({ length: sections }, (_, i) => t(`S${i}`, []));
        for (const id of mine) {
          const r = rnd();
          if (r < 0.15) continue; // omitted
          out[pick(sections)].page_ids.push(id);
          if (r > 0.85) out[pick(sections)].page_ids.push(id); // duplicated
        }
        for (let k = pick(3); k > 0; k--) out[pick(sections)].page_ids.push(rnd() < 0.5 ? 900000 + pick(99) : allIds()[pick(allIds().length)]); // invented / any lecture
        for (const s of out) s.page_ids.sort(() => rnd() - 0.5);
        out.sort(() => rnd() - 0.5);
        return { topics: out };
      };
      const label = `seed ${seed}`;
      await buildTopicMap(w.examId);
      if (status(w.examId) === "error") {
        // Only possible when every lecture is title/agenda or every answer was unusable: nothing may have been stored.
        expect(topics(w.examId), label).toHaveLength(0);
        continue;
      }
      try {
        expect(sorted([...checkMap(w.examId)]), label).toEqual(sorted(contentSlides(w.examId)));
        // an upload
        addLecture();
        await buildTopicMap(w.examId);
        if (status(w.examId) === "ready") expect(sorted([...checkMap(w.examId)]), label).toEqual(sorted(contentSlides(w.examId)));
        // Rebuild
        const before = JSON.stringify(topics(w.examId));
        await buildTopicMap(w.examId, "full");
        if (status(w.examId) === "ready") expect(sorted([...checkMap(w.examId)]), label).toEqual(sorted(contentSlides(w.examId)));
        else expect(JSON.stringify(topics(w.examId)), label).toBe(before);
        // remove a lecture
        const victim = lectures[pick(lectures.length)];
        await removeDocument(victim.doc);
        const seen = checkMap(w.examId);
        for (const id of victim.pages) expect(seen.has(id), label).toBe(false);
      } catch (e) {
        throw new Error(`${label}: ${(e as Error).message}`);
      }
    }
  }, 120_000);
});

void setMeta;
