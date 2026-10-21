// Perf fix #5: the exam page's per-topic lookups are batched; the batched helpers must give exactly what the old
// per-topic calls gave, on data with the awkward cases (earlier exams, removed topics, flagged and foreign questions).
import { describe, expect, it } from "vitest";
import { db, type Topic } from "@/lib/db";
import { mastery, topicConcepts, topicConceptsForExam, type ConceptRow } from "@/lib/memory";
import { pendingCounts, pendingCountsByTopic } from "@/lib/practicePlan";
import { examProgress } from "@/lib/readiness";
import { makeUser } from "./helpers";

/** examProgress as it was before batching (one concepts query per topic), kept here as the reference. */
function examProgressOld(userId: number, examId: number) {
  const topics = db.prepare("SELECT id FROM topics WHERE exam_id = ?").all(examId) as Pick<Topic, "id">[];
  if (topics.length === 0) return { mastery: null, studied: 0, readiness: 0, topics: 0 };
  const studied = new Set(
    (db.prepare("SELECT topic_id FROM topic_study WHERE user_id = ? AND topic_id IN (SELECT id FROM topics WHERE exam_id = ?)").all(userId, examId) as { topic_id: number }[]).map(
      (r) => r.topic_id,
    ),
  );
  const conceptsOf = db.prepare("SELECT c.attempts, c.correct FROM concepts c JOIN topic_concepts tc ON tc.concept_id = c.id WHERE tc.topic_id = ?");
  const all: number[] = [];
  let readiness = 0;
  for (const t of topics) {
    const ms = (conceptsOf.all(t.id) as ConceptRow[]).map(mastery).filter((m): m is number => m != null);
    all.push(...ms);
    const topicMastery = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
    if (studied.has(t.id) || topicMastery != null) readiness += topicMastery ?? 0.5;
  }
  return { mastery: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null, studied: studied.size / topics.length, readiness: readiness / topics.length, topics: topics.length };
}

let rnd = 12345;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);

function exam(userId: number, name: string, createdAt: string, topics: number) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, created_at) VALUES (?, ?, ?)").run(userId, name, createdAt).lastInsertRowid);
  const topicIds = Array.from({ length: topics }, (_, i) =>
    Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', '[]')").run(examId, i, `${name} topic ${i + 1}`).lastInsertRowid),
  );
  return { examId, topicIds };
}

/** A student with an older exam, the exam under test (20 topics), a later exam, concepts shared between them, and answers. */
function seed() {
  const userId = makeUser();
  const old = exam(userId, "Older exam", "2026-01-01 10:00:00", 4);
  const sameName = exam(userId, "Older exam", "2026-02-01 10:00:00", 2); // same name as another earlier exam: listed once
  const main = exam(userId, "Main exam", "2026-03-01 10:00:00", 20);
  const later = exam(userId, "Later exam", "2026-09-01 10:00:00", 3); // created after: never listed as earlier
  const concepts = Array.from({ length: 30 }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO concepts (user_id, name, attempts, correct) VALUES (?, ?, ?, ?)")
        .run(userId, `${String.fromCharCode(97 + (i % 26))}${i % 3 === 0 ? "Zeta" : "alpha"} ${i}`, i % 4 === 0 ? 0 : 3 + (i % 5), i % 4 === 0 ? 0 : i % 3).lastInsertRowid,
    ),
  );
  const link = (topicId: number, conceptId: number) => db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)").run(topicId, conceptId);
  main.topicIds.forEach((t, i) => {
    if (i === 7) return; // a topic without concepts
    for (let k = 0; k < 1 + (i % 4); k++) link(t, concepts[(i * 3 + k * 7) % concepts.length]);
  });
  concepts.slice(0, 12).forEach((c, i) => link(old.topicIds[i % 4], c));
  concepts.slice(5, 9).forEach((c, i) => link(sameName.topicIds[i % 2], c));
  concepts.slice(0, 20).forEach((c, i) => link(later.topicIds[i % 3], c));
  db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?), (?, ?), (?, ?)").run(userId, main.topicIds[0], userId, main.topicIds[3], userId, main.topicIds[7]);

  // Practice answers: several attempts so later answers replace earlier ones; removed-topic, flagged and foreign questions.
  const q = (examId: number, topicId: number | null, flagged = 0) =>
    Number(
      db
        .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, flagged) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)")
        .run(examId, topicId, flagged).lastInsertRowid,
    );
  const questions = [
    ...main.topicIds.flatMap((t) => Array.from({ length: 5 }, () => q(main.examId, t))),
    q(main.examId, null),
    q(main.examId, null),
    q(main.examId, main.topicIds[2], 1),
    q(old.examId, old.topicIds[0]), // foreign question that once landed in this exam's practice
  ];
  const confidences = ["guess", "unsure", "sure", null];
  for (let a = 0; a < 6; a++) {
    const attemptId = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'finished')").run(main.examId).lastInsertRowid);
    questions.forEach((qid, pos) => {
      if (rand() < 0.35) return;
      const skipped = rand() < 0.1;
      db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position, chosen_index, correct, confidence) VALUES (?, ?, ?, ?, ?, ?)").run(
        attemptId,
        qid,
        pos,
        skipped ? null : 0,
        skipped ? null : rand() < 0.5 ? 1 : 0,
        confidences[Math.floor(rand() * 4)],
      );
    });
  }
  return { userId, main };
}

/** Counts statement executions (get/all/run/iterate) while fn runs. */
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

describe("exam page: batched lookups match the per-topic ones", () => {
  it("pendingCountsByTopic equals pendingCounts(exam, [topic]) for every topic", () => {
    const { main } = seed();
    const batched = pendingCountsByTopic(main.examId);
    let nonZero = 0;
    for (const t of main.topicIds) {
      const one = pendingCounts(main.examId, [t]);
      if (one.missed || one.unsure) nonZero++;
      expect(batched.get(t) ?? { missed: 0, unsure: 0 }).toEqual(one);
    }
    expect(nonZero).toBeGreaterThan(10); // the data really exercises the counts
    // Questions whose topic was removed never count towards a topic.
    expect([...batched.keys()].every((k) => main.topicIds.includes(k))).toBe(true);
  });

  it("topicConceptsForExam equals topicConcepts(topic, exam) for every topic, order and earlier exams included", () => {
    const { main } = seed();
    const batched = topicConceptsForExam(main.examId);
    let withEarlier = 0;
    for (const t of main.topicIds) {
      const one = topicConcepts(t, main.examId);
      expect(batched.get(t) ?? []).toEqual(one);
      withEarlier += one.filter((c) => c.earlier_exams.length > 0).length;
    }
    expect(withEarlier).toBeGreaterThan(0);
    expect(batched.has(main.topicIds[7])).toBe(false);
    // The same-named earlier exam is listed once; the later exam never.
    const names = [...batched.values()].flat().flatMap((c) => c.earlier_exams);
    expect(names).toContain("Older exam");
    expect(names).not.toContain("Later exam");
    for (const c of [...batched.values()].flat()) expect(new Set(c.earlier_exams).size).toBe(c.earlier_exams.length);
  });

  it("examProgress (now batched) gives the same numbers as before", () => {
    const { userId, main } = seed();
    const now = examProgress(userId, main.examId);
    const before = examProgressOld(userId, main.examId);
    expect(now.topics).toBe(before.topics);
    expect(now.studied).toBe(before.studied);
    expect(now.readiness).toBeCloseTo(before.readiness, 12);
    expect(now.mastery).toBeCloseTo(before.mastery!, 12);
  });

  it("the batched lookups take a handful of queries instead of hundreds", () => {
    const { userId, main } = seed();
    const old = countQueries(() => {
      for (const t of main.topicIds) {
        pendingCounts(main.examId, [t]);
        topicConcepts(t, main.examId);
      }
      examProgressOld(userId, main.examId);
    });
    const now = countQueries(() => {
      pendingCountsByTopic(main.examId);
      topicConceptsForExam(main.examId);
      examProgress(userId, main.examId);
    });
    expect(now.queries).toBeLessThanOrEqual(6);
    expect(old.queries).toBeGreaterThan(60);
    console.log(`exam page lookups for 20 topics: ${old.queries} queries before, ${now.queries} after`);
  });
});
