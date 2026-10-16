import { beforeEach, describe, expect, it, vi } from "vitest";

type AiTopic = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[]; after_topic?: number };
let reply: (content: string) => { topics: AiTopic[] } = () => ({ topics: [] });
let delay = 0;
let calls = 0;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls++;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return reply(opts.content);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, type Topic } from "@/lib/db";
import { buildTopicMap } from "@/lib/topics";
import { removeDocument } from "@/lib/processing";
import { makeUser } from "./helpers";

const notes = (title: string, filler = false) =>
  JSON.stringify({ title, summary: "s", image_description: null, key_facts: ["f"], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: ["c"], is_filler: filler });
function lecture(examId: number, name: string, n: number, filler: number[] = []) {
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, 'done', ?)").run(examId, name, n).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(doc, i + 1, notes(`${name} s${i + 1}`, filler.includes(i + 1))).lastInsertRowid),
  );
  return { doc, pages };
}
const t = (title: string, page_ids: number[], extra: Partial<AiTopic> = {}): AiTopic => ({ title, summary: "s", page_ids, emphasized: false, concepts: [title + " c"], ...extra });
const topics = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
const pagesOf = (x: Topic) => JSON.parse(x.page_ids) as number[];
const st = (examId: number) => db.prepare("SELECT topic_status s, topic_error e FROM exams WHERE id = ?").get(examId) as { s: string; e: string | null };
function exam() {
  const userId = makeUser();
  return { userId, examId: Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid) };
}
beforeEach(() => {
  calls = 0;
  delay = 0;
});

describe("topic map: hostile AI answers", () => {
  it("ids from another exam and from already-mapped slides are ignored; unmapped slides still land somewhere", async () => {
    const other = exam();
    const foreign = lecture(other.examId, "X.pdf", 3);
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    reply = () => ({ topics: [t("A", l1.pages.slice(0, 2)), t("B", l1.pages.slice(2))] });
    await buildTopicMap(w.examId);
    const before = topics(w.examId).map((x) => x.id);
    const l2 = lecture(w.examId, "L2.pdf", 3);
    reply = () => ({ topics: [t("New", [...foreign.pages, ...l1.pages, l2.pages[0]], { after_topic: 1 })] });
    await buildTopicMap(w.examId);
    const all = topics(w.examId);
    expect(all.slice().map((x) => x.id).filter((id) => before.includes(id))).toEqual(before);
    const flat = all.flatMap(pagesOf);
    expect(flat.sort()).toEqual([...l1.pages, ...l2.pages].sort());
    expect(flat.some((p) => foreign.pages.includes(p))).toBe(false);
    // old topics unchanged
    expect(pagesOf(all.find((x) => x.id === before[0])!)).toEqual(l1.pages.slice(0, 2));
  });

  it("auto: AI returns only foreign ids -> one topic per new lecture, nothing lost", async () => {
    const other = exam();
    const foreign = lecture(other.examId, "X.pdf", 2);
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 3);
    reply = () => ({ topics: [t("A", l1.pages)] });
    await buildTopicMap(w.examId);
    const l2 = lecture(w.examId, "L2.pdf", 3);
    reply = () => ({ topics: [t("junk", foreign.pages)] });
    await buildTopicMap(w.examId);
    expect(st(w.examId).s).toBe("ready");
    expect(topics(w.examId).flatMap(pagesOf).sort()).toEqual([...l1.pages, ...l2.pages].sort());
    expect(topics(w.examId)).toHaveLength(2);
  });

  it("auto: empty topic list from AI -> fallback topic per lecture", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 3);
    reply = () => ({ topics: [t("A", l1.pages)] });
    await buildTopicMap(w.examId);
    const l2 = lecture(w.examId, "L2.pdf", 2);
    reply = () => ({ topics: [] });
    await buildTopicMap(w.examId);
    expect(topics(w.examId).flatMap(pagesOf).sort()).toEqual([...l1.pages, ...l2.pages].sort());
  });

  it("full: empty answer leaves the old map untouched and shows an error", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 4);
    reply = () => ({ topics: [t("A", l1.pages)] });
    await buildTopicMap(w.examId);
    reply = () => ({ topics: [] });
    await buildTopicMap(w.examId, "full");
    expect(st(w.examId).s).toBe("error");
    expect(topics(w.examId)).toHaveLength(1);
  });

  it("every slide in one topic works; a filler-only new lecture makes no AI call and no topic", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 5);
    reply = () => ({ topics: [t("All", l1.pages)] });
    await buildTopicMap(w.examId);
    const c = calls;
    lecture(w.examId, "Intro.pdf", 2, [1, 2]);
    await buildTopicMap(w.examId);
    expect(calls).toBe(c);
    expect(st(w.examId).s).toBe("ready");
    expect(topics(w.examId)).toHaveLength(1);
  });

  it("a lecture with only filler on a brand new exam gives a clear error, not a crash", async () => {
    const w = exam();
    lecture(w.examId, "Intro.pdf", 2, [1, 2]);
    reply = () => ({ topics: [] });
    await buildTopicMap(w.examId);
    expect(st(w.examId).s).toBe("error");
  });
});

describe("topic map: progress follows a rebuild", () => {
  function studied() {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 6);
    return { ...w, l1 };
  }
  it("split: the bigger/first half keeps the topic id and its answers (detached, not deleted); the other half is new", async () => {
    const w = studied();
    reply = () => ({ topics: [t("Whole", w.l1.pages)] });
    await buildTopicMap(w.examId);
    const [old] = topics(w.examId);
    const session = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId).lastInsertRowid);
    db.prepare("UPDATE topics SET checks_json='[]', checks_version=2, lesson_json='{}' WHERE id=?").run(old.id);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'q', 1, 0, 0)").run(session, old.id);
    reply = () => ({ topics: [t("First half", w.l1.pages.slice(0, 3)), t("Second half", w.l1.pages.slice(3))] });
    await buildTopicMap(w.examId, "full");
    const now = topics(w.examId);
    expect(now).toHaveLength(2);
    expect(now.map((x) => x.id)).toContain(old.id);
    const kept = now.find((x) => x.id === old.id)!;
    expect(kept.checks_json).toBeNull();
    expect(db.prepare("SELECT check_index FROM session_checks WHERE topic_id = ?").all(old.id)).toEqual([{ check_index: null }]);
  });

  it("merge of two small topics into one: one old id survives, the other is deleted without orphaning questions", async () => {
    const w = studied();
    reply = () => ({ topics: [t("A", w.l1.pages.slice(0, 3)), t("B", w.l1.pages.slice(3))] });
    await buildTopicMap(w.examId);
    const [a, b] = topics(w.examId);
    const q = Number(db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)").run(w.examId, b.id, w.l1.pages[4]).lastInsertRowid);
    reply = () => ({ topics: [t("AB", w.l1.pages)] });
    await buildTopicMap(w.examId, "full");
    const now = topics(w.examId);
    expect(now).toHaveLength(1);
    expect([a.id, b.id]).toContain(now[0].id);
    expect((db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id).toBe(now[0].id);
  });

  it("question whose slide moves to another topic follows it", async () => {
    const w = studied();
    reply = () => ({ topics: [t("A", w.l1.pages.slice(0, 3)), t("B", w.l1.pages.slice(3))] });
    await buildTopicMap(w.examId);
    const [a, b] = topics(w.examId);
    const q = Number(db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)").run(w.examId, a.id, w.l1.pages[2]).lastInsertRowid);
    reply = () => ({ topics: [t("A", w.l1.pages.slice(0, 2)), t("B", w.l1.pages.slice(2))] });
    await buildTopicMap(w.examId, "full");
    expect((db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id).toBe(b.id);
  });

  it("lecture removed, then a new one added (auto): old topics shrink, the new slides form a new topic, nothing dangling", async () => {
    const w = exam();
    const l1 = lecture(w.examId, "L1.pdf", 3);
    const l2 = lecture(w.examId, "L2.pdf", 3);
    reply = () => ({ topics: [t("A", l1.pages), t("B", l2.pages)] });
    await buildTopicMap(w.examId);
    await removeDocument(l2.doc);
    const l3 = lecture(w.examId, "L3.pdf", 2);
    reply = () => ({ topics: [t("C", l3.pages)] });
    await buildTopicMap(w.examId);
    const now = topics(w.examId);
    const live = new Set((db.prepare("SELECT p.id FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.exam_id=?").all(w.examId) as { id: number }[]).map((r) => r.id));
    for (const x of now) for (const p of pagesOf(x)) expect(live.has(p), `page ${p} in "${x.title}"`).toBe(true);
    expect(now.flatMap(pagesOf).sort()).toEqual([...l1.pages, ...l3.pages].sort());
    expect(now.every((x) => pagesOf(x).length > 0)).toBe(true);
    const pos = now.map((x) => x.position);
    expect(new Set(pos).size).toBe(pos.length);
    expect(Math.min(...pos)).toBeGreaterThanOrEqual(0);
  });

  it("concurrent calls share one run; a Rebuild asked during an automatic run still happens afterwards", async () => {
    const w = studied();
    reply = () => ({ topics: [t("A", w.l1.pages)] });
    delay = 30;
    const p1 = buildTopicMap(w.examId);
    const p2 = buildTopicMap(w.examId);
    const p3 = buildTopicMap(w.examId, "full");
    await Promise.all([p1, p2, p3]);
    expect(st(w.examId).s).toBe("ready");
    expect(topics(w.examId)).toHaveLength(1);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("positions stay unique and gap-free after several rebuilds with a changing number of topics", async () => {
    const w = studied();
    for (const split of [[6], [3, 3], [2, 2, 2], [6], [1, 5]]) {
      let at = 0;
      reply = () => ({ topics: split.map((n, i) => t(`T${i}`, w.l1.pages.slice(at, (at += n)))) });
      await buildTopicMap(w.examId, "full");
      expect(st(w.examId).s, st(w.examId).e ?? "").toBe("ready");
      expect(topics(w.examId).map((x) => x.position)).toEqual(split.map((_, i) => i));
    }
  });
});
