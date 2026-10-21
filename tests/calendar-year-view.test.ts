// Calendar release, job 7: where she stands — readiness for every upcoming exam in a few queries, tones and crunch warnings.
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { examProgress, examProgressMany } from "@/lib/readiness";
import { countdown, crunchMessage, findCrunches, readinessTone } from "@/lib/calendar";
import { makeExam, makeUser } from "./helpers";

function countQueries<T>(fn: () => T): { result: T; queries: number } {
  const prepare = db.prepare.bind(db);
  let queries = 0;
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = prepare(sql);
    for (const m of ["get", "all", "run", "iterate"] as const) {
      const orig = (stmt[m] as (...a: unknown[]) => unknown).bind(stmt);
      (stmt as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        queries++;
        return orig(...a);
      };
    }
    return stmt;
  };
  try {
    return { result: fn(), queries };
  } finally {
    (db as { prepare: unknown }).prepare = prepare;
  }
}

function world() {
  const u = makeUser();
  const a = makeExam(u, "2026-11-04", [5, 5, 5, 5], "Endo Block");
  const b = makeExam(u, "2026-11-06", [5, 5], "Perio Quiz");
  const c = makeExam(u, "2026-12-01", [], "OSCE");
  const concept = (name: string, attempts: number, correct: number) =>
    Number(db.prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, ?, ?, ?)").run(u, name, attempts, correct).lastInsertRowid);
  const link = (t: number, cpt: number) => db.prepare("INSERT INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(t, cpt);
  link(a.topicIds[0], concept(`c1-${u}`, 10, 9));
  link(a.topicIds[1], concept(`c2-${u}`, 10, 3));
  link(b.topicIds[0], concept(`c3-${u}`, 4, 4));
  db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?), (?, ?)").run(u, a.topicIds[2], u, b.topicIds[1]);
  return { u, a, b, c };
}

describe("readiness for many exams at once", () => {
  it("matches examProgress exam by exam, including an exam with no topics", () => {
    const { u, a, b, c } = world();
    const many = examProgressMany(u, [a.examId, b.examId, c.examId]);
    for (const id of [a.examId, b.examId, c.examId]) expect(many.get(id)).toEqual(examProgress(u, id));
    expect(many.get(c.examId)).toEqual({ mastery: null, studied: 0, readiness: 0, topics: 0 });
    expect(many.get(a.examId)!.studied).toBe(0.25);
  });

  it("takes three queries however many exams there are (and none for an empty list)", () => {
    const { u, a, b, c } = world();
    expect(countQueries(() => examProgressMany(u, [a.examId, b.examId, c.examId])).queries).toBe(3);
    expect(countQueries(() => examProgressMany(u, [])).queries).toBe(0);
  });

  it("doesn't count another student's studying", () => {
    const { a } = world();
    const other = makeUser();
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(other, a.topicIds[3]);
    expect(examProgressMany(other, [a.examId]).get(a.examId)!.studied).toBe(0.25);
  });
});

describe("readiness dot colours", () => {
  it("use MasteryChip's thresholds, and grey until something is studied or tested", () => {
    const p = (readiness: number, studied = 0.5, mastery: number | null = 0.5, topics = 4) => ({ readiness, studied, mastery, topics });
    expect(readinessTone(p(0.8))).toBe("mint");
    expect(readinessTone(p(0.79))).toBe("butter");
    expect(readinessTone(p(0.6))).toBe("butter");
    expect(readinessTone(p(0.59))).toBe("coral");
    expect(readinessTone(p(0, 0, null))).toBe("muted");
    expect(readinessTone(p(0, 0, null, 0))).toBe("muted");
    expect(readinessTone(null)).toBe("muted");
  });
});

describe("crunch warnings", () => {
  const ex = (id: number, name: string, exam_date: string | null) => ({ id, name, exam_date });
  it("flags neighbouring upcoming exams 0–3 days apart, in date order", () => {
    const list = [ex(1, "Endo Block", "2026-11-04"), ex(2, "Perio Quiz", "2026-11-06"), ex(3, "OSCE", "2026-11-20"), ex(4, "Radiology", "2026-11-23"), ex(5, "Past", "2026-10-01"), ex(6, "Undated", null)];
    const found = findCrunches(list, "2026-10-21");
    expect(found.map((c) => [c.a.name, c.b.name, c.days])).toEqual([
      ["Endo Block", "Perio Quiz", 2],
      ["OSCE", "Radiology", 3],
    ]);
    expect(crunchMessage(found[0])).toBe("Endo Block and Perio Quiz are 2 days apart — your plan starts both early.");
    expect(crunchMessage({ a: { name: "A" }, b: { name: "B" }, days: 1 })).toBe("A and B are 1 day apart — your plan starts both early.");
    expect(crunchMessage({ a: { name: "A" }, b: { name: "B" }, days: 0 })).toBe("A and B are on the same day — your plan starts both early.");
    expect(findCrunches([ex(1, "A", "2026-11-04"), ex(2, "B", "2026-11-08")], "2026-10-21")).toEqual([]);
  });

  it("countdown words", () => {
    expect(countdown(0)).toBe("today");
    expect(countdown(1)).toBe("tomorrow");
    expect(countdown(9)).toBe("in 9 days");
  });
});
