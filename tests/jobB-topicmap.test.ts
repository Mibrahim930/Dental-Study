import { beforeEach, describe, expect, it, vi } from "vitest";

type AiTopic = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[]; after_topic?: number };
let topicMapReply: (content: string) => { topics: AiTopic[] } = () => ({ topics: [] });
const prompts: string[] = [];
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    if (opts.purpose !== "topic map") throw new Error("unexpected " + opts.purpose);
    prompts.push(opts.content);
    return topicMapReply(opts.content);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, type Topic } from "@/lib/db";
import { buildTopicMap } from "@/lib/topics";
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

/** A lecture of `n` slides; `filler` lists 1-based slide numbers that are title/agenda slides. */
function lecture(examId: number, name: string, n: number, filler: number[] = []): number[] {
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, 'done', ?)").run(examId, name, n).lastInsertRowid);
  return Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)")
        .run(doc, i + 1, notes(`${name} s${i + 1}`, filler.includes(i + 1))).lastInsertRowid,
    ),
  );
}
const t = (title: string, page_ids: number[], extra: Partial<AiTopic> = {}): AiTopic => ({ title, summary: "s", page_ids, emphasized: false, concepts: [title + " concept"], ...extra });
const topics = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
const pagesOf = (x: Topic) => JSON.parse(x.page_ids) as number[];
const status = (examId: number) => db.prepare("SELECT topic_status, topic_error FROM exams WHERE id = ?").get(examId) as { topic_status: string; topic_error: string | null };

function exam() {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  return { userId, examId };
}

beforeEach(() => {
  prompts.length = 0;
});

describe("first map: every content slide ends up in exactly one topic", () => {
  it("AI omits 3 slides and lists 1 twice; filler slides stay out", async () => {
    const { examId } = exam();
    const p = lecture(examId, "L1.pdf", 12, [1]); // slide 1 is a title slide
    // Omits p[4], p[8], p[11]; lists p[6] in two topics.
    topicMapReply = () => ({ topics: [t("A", [p[1], p[2], p[3], p[5], p[6]]), t("B", [p[6], p[7], p[9], p[10]])] });
    await buildTopicMap(examId);
    expect(status(examId).topic_status).toBe("ready");
    const all = topics(examId).flatMap(pagesOf);
    expect([...all].sort((a, b) => a - b)).toEqual(p.slice(1));
    expect(new Set(all).size).toBe(all.length);
    expect(prompts[0]).not.toContain(`[P${p[0]}]`); // the title slide isn't sent
  });
});

describe("new lecture added to an existing map", () => {
  async function studied() {
    const w = exam();
    const p1 = lecture(w.examId, "L1.pdf", 6);
    topicMapReply = () => ({ topics: [t("A", p1.slice(0, 3)), t("B", p1.slice(3))] });
    await buildTopicMap(w.examId);
    const [a, b] = topics(w.examId);
    // The student has studied topic A, answered its quiz and practised it.
    db.prepare("UPDATE topics SET lesson_json = '{\"explanation\":\"x\"}', checks_json = '[]', checks_version = 2 WHERE id = ?").run(a.id);
    const session = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(w.examId).lastInsertRowid);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'q', 1, 0, 1)").run(session, a.id);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, a.id);
    const question = Number(
      db
        .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)")
        .run(w.examId, a.id, p1[0]).lastInsertRowid,
    );
    return { ...w, p1, a, b, session, question };
  }

  it("keeps old topic ids, lessons, quiz answers, study progress and questions; only new slides form new topics", async () => {
    const w = await studied();
    const p2 = lecture(w.examId, "L2.pdf", 4);
    topicMapReply = () => ({ topics: [t("C", p2.slice(0, 2), { after_topic: 1 }), t("D", p2.slice(2), { after_topic: 2 })] });
    await buildTopicMap(w.examId);
    expect(status(w.examId).topic_status).toBe("ready");
    const now = topics(w.examId);
    expect(now.map((x) => x.title)).toEqual(["A", "C", "B", "D"]);
    expect(now.map((x) => x.position)).toEqual([0, 1, 2, 3]);
    const a = now.find((x) => x.id === w.a.id)!;
    expect(pagesOf(a)).toEqual(pagesOf(w.a));
    expect(a.lesson_json).not.toBeNull();
    expect(a.checks_version).toBe(2);
    expect(now.find((x) => x.id === w.b.id)).toBeDefined();
    expect(db.prepare("SELECT check_index FROM session_checks WHERE session_id = ?").get(w.session)).toEqual({ check_index: 0 });
    expect(db.prepare("SELECT 1 x FROM topic_study WHERE topic_id = ?").get(w.a.id)).toEqual({ x: 1 });
    expect(db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(w.question)).toEqual({ topic_id: w.a.id });
    // The AI was told about existing topics and given only the new slides.
    expect(prompts[1]).toContain("1. A");
    for (const id of w.p1) expect(prompts[1]).not.toContain(`[P${id}]`);
  });

  it("the AI tries to grab an old slide or skips new ones: old topics still untouched, all new slides placed", async () => {
    const w = await studied();
    const p2 = lecture(w.examId, "L2.pdf", 4);
    topicMapReply = () => ({ topics: [t("C", [w.p1[0], p2[0]], { after_topic: 5 })] });
    await buildTopicMap(w.examId);
    const now = topics(w.examId);
    expect(pagesOf(now.find((x) => x.id === w.a.id)!)).toEqual(pagesOf(w.a));
    const c = now.find((x) => x.title === "C")!;
    expect(pagesOf(c).sort((x, y) => x - y)).toEqual(p2);
    expect(now.at(-1)!.title).toBe("C");
  });

  it("the AI returns nothing usable: one topic per new lecture, at the end", async () => {
    const w = await studied();
    const p2 = lecture(w.examId, "Lect 5.pdf", 3);
    topicMapReply = () => ({ topics: [] });
    await buildTopicMap(w.examId);
    const now = topics(w.examId);
    expect(now).toHaveLength(3);
    expect(now[2].title).toBe("Lect 5");
    expect(pagesOf(now[2])).toEqual(p2);
  });

  it("nothing new (e.g. a re-run after a failed slide): no AI call, nothing changes", async () => {
    const w = await studied();
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(1);
    expect(topics(w.examId).map((x) => x.id)).toEqual([w.a.id, w.b.id]);
  });

  it("an AI failure leaves the old map in place and shows the error", async () => {
    const w = await studied();
    lecture(w.examId, "L2.pdf", 2);
    topicMapReply = () => {
      throw new Error("AI down");
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toMatchObject({ topic_status: "error" });
    expect(topics(w.examId).map((x) => x.id)).toEqual([w.a.id, w.b.id]);
  });
});

describe("Rebuild (full re-map)", () => {
  it("keeps topics that mostly match (same id); a changed one gets a fresh lesson and quiz but keeps answers as history", async () => {
    const { examId, userId } = exam();
    const p = lecture(examId, "L1.pdf", 9);
    topicMapReply = () => ({ topics: [t("A", p.slice(0, 3)), t("B", p.slice(3, 6)), t("C", p.slice(6))] });
    await buildTopicMap(examId);
    const [a, b, c] = topics(examId);
    for (const x of [a, b, c]) db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[]', checks_version = 2 WHERE id = ?").run(x.id);
    const session = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
    db.prepare("INSERT INTO session_checks (session_id, topic_id, question, correct, check_index, chosen) VALUES (?, ?, 'q', 1, 2, 1)").run(session, b.id);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(userId, b.id);
    // A question from slide p[5] (topic B), and one whose topic was wiped by an old rebuild (topic_id NULL).
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)");
    const qMoves = Number(ins.run(examId, b.id, p[5]).lastInsertRowid);
    const qOrphan = Number(ins.run(examId, null, p[0]).lastInsertRowid);

    // Same A; B loses p[5] to C; C reordered first.
    topicMapReply = () => ({ topics: [t("C2", [p[5], ...p.slice(6)]), t("A", p.slice(0, 3)), t("B2", p.slice(3, 5))] });
    await buildTopicMap(examId, "full");
    const now = topics(examId);
    expect(now.map((x) => x.id)).toEqual([c.id, a.id, b.id]);
    const A = now[1];
    expect(A.title).toBe("A");
    expect(A.lesson_json).toBe("L");
    expect(A.checks_version).toBe(2);
    const B = now[2];
    expect(B.title).toBe("B2");
    expect(B.lesson_json).toBeNull();
    expect(B.checks_json).toBeNull();
    expect(db.prepare("SELECT check_index FROM session_checks WHERE session_id = ?").get(session)).toEqual({ check_index: null });
    expect(db.prepare("SELECT 1 x FROM topic_study WHERE topic_id = ?").get(b.id)).toEqual({ x: 1 });
    expect(db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(qMoves)).toEqual({ topic_id: c.id });
    expect(db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(qOrphan)).toEqual({ topic_id: a.id });
  });

  it("a topic that no longer exists is removed; its questions follow their slides", async () => {
    const { examId } = exam();
    const p = lecture(examId, "L1.pdf", 6);
    topicMapReply = () => ({ topics: [t("A", p.slice(0, 2)), t("B", p.slice(2, 4)), t("C", p.slice(4))] });
    await buildTopicMap(examId);
    const [, b] = topics(examId);
    const q = Number(
      db
        .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)")
        .run(examId, b.id, p[2]).lastInsertRowid,
    );
    topicMapReply = () => ({ topics: [t("AB", p.slice(0, 4)), t("C", p.slice(4))] });
    await buildTopicMap(examId, "full");
    const now = topics(examId);
    expect(now).toHaveLength(2);
    expect(now.some((x) => x.id === b.id)).toBe(false);
    expect((db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id).toBe(now[0].id);
  });
});
