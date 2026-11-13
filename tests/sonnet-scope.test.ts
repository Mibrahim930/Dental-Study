import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { scopeTopicIds } from "@/lib/practicePlan";
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

});
