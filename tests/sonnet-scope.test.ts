import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { allocate, scopeTopicIds } from "@/lib/practicePlan";
import type { Topic } from "@/lib/db";
import { makeExam, makeUser } from "./helpers";

describe("scope selection", () => {
  it("lectures: empty or foreign document ids select nothing (the route then answers 400)", () => {
    const u = makeUser();
    const a = makeExam(u, null, [3]);
    const b = makeExam(u, null, [3]);
    const docB = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'b.pdf')").run(b.examId).lastInsertRowid);
    expect(scopeTopicIds(a.examId, { kind: "lectures", documentIds: [] })).toEqual([]);
    expect(scopeTopicIds(a.examId, { kind: "lectures", documentIds: [docB] })).toEqual([]);
    expect(scopeTopicIds(a.examId, { kind: "lectures", documentIds: [999999] })).toEqual([]);
  });

  it("topics: ids from another exam are dropped", () => {
    const u = makeUser();
    const a = makeExam(u, null, [3]);
    const b = makeExam(u, null, [3]);
    expect(scopeTopicIds(a.examId, { kind: "topics", topicIds: [b.topicIds[0], a.topicIds[0]] })).toEqual([a.topicIds[0]]);
    expect(scopeTopicIds(a.examId, { kind: "topics", topicIds: [b.topicIds[0]] })).toEqual([]);
  });

  it("allocate always hands out exactly the requested total, for small sizes and extreme weights", () => {
    const u = makeUser();
    const { examId, topicIds } = makeExam(u, null, [1, 20, 3, 7]);
    const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
    const manyMisses = new Map([[topicIds[0], Array(50).fill({ concept: null, source_page_id: null, stem: "s", why: "missed" })]]);
    for (const total of [1, 2, 3, 5, 7, 10, 37]) {
      for (const focus of [null, new Map(), manyMisses]) {
        const out = allocate(topics, total, focus);
        expect(out.reduce((s, x) => s + x.count, 0)).toBe(total);
        expect(out.every((x) => x.count > 0)).toBe(true);
      }
    }
    expect(allocate(topics, 0, null)).toEqual([]);
    expect(allocate([], 5, null)).toEqual([]);
  });
});
