import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ownsAttempt, ownsCard, ownsDocument, ownsExam, ownsPage, ownsQuestion, ownsSession } from "@/lib/owner";
import { addReviewCard, countDue, dueCards, reviewCard } from "@/lib/practice";
import { searchLibrary, weakConcepts, upsertConcept } from "@/lib/memory";
import { makeUser } from "./helpers";

function world(userId: number) {
  const exam = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'L')").run(exam).lastInsertRowid);
  const page = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status) VALUES (?, 1, 'x', 'done')").run(doc).lastInsertRowid);
  db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, 'Avulsion', 'replant avulsed tooth within sixty minutes')").run(page);
  const session = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(exam).lastInsertRowid);
  const attempt = Number(db.prepare("INSERT INTO attempts (exam_id, mode) VALUES (?, 'tutor')").run(exam).lastInsertRowid);
  const question = Number(
    db.prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation) VALUES (?, 'recall', 's', '[]', 0, 'e')").run(exam).lastInsertRowid,
  );
  addReviewCard(question);
  const card = (db.prepare("SELECT id FROM review_cards WHERE question_id = ?").get(question) as { id: number }).id;
  return { exam, doc, page, session, attempt, question, card };
}

describe("data isolation between users", () => {
  it("every ownership check rejects another user's ids", () => {
    const a = makeUser();
    const b = makeUser();
    const wa = world(a);
    const checks = [
      [ownsExam, wa.exam],
      [ownsDocument, wa.doc],
      [ownsPage, wa.page],
      [ownsSession, wa.session],
      [ownsAttempt, wa.attempt],
      [ownsQuestion, wa.question],
      [ownsCard, wa.card],
    ] as const;
    for (const [check, id] of checks) {
      expect(check(a, id)).toBe(true);
      expect(check(b, id)).toBe(false);
    }
  });

  it("search, review queue and weak concepts only return the user's own data", () => {
    const a = makeUser();
    const b = makeUser();
    world(a);
    expect(searchLibrary(a, "avulsed tooth replant").length).toBeGreaterThan(0);
    expect(searchLibrary(b, "avulsed tooth replant")).toEqual([]);
    db.prepare("UPDATE review_cards SET due = '2000-01-01T00:00:00.000Z'").run();
    expect(countDue(a)).toBeGreaterThan(0);
    expect(countDue(b)).toBe(0);
    expect(dueCards(b, 50)).toEqual([]);
    const c = upsertConcept(a, "Avulsion");
    db.prepare("UPDATE concepts SET attempts = 4, correct = 0 WHERE id = ?").run(c);
    expect(weakConcepts(a).map((x) => x.name)).toContain("Avulsion");
    expect(weakConcepts(b)).toEqual([]);
  });
});

describe("spaced review", () => {
  it("a missed question comes back soon; answering it well pushes it further out", () => {
    const u = makeUser();
    const { card } = world(u);
    db.prepare("UPDATE review_cards SET due = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), card);
    reviewCard(card, true, "good");
    const first = new Date((db.prepare("SELECT due FROM review_cards WHERE id = ?").get(card) as { due: string }).due).getTime();
    expect(first).toBeGreaterThan(Date.now());
    db.prepare("UPDATE review_cards SET due = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), card);
    reviewCard(card, false, "good");
    const afterMiss = new Date((db.prepare("SELECT due FROM review_cards WHERE id = ?").get(card) as { due: string }).due).getTime();
    expect(afterMiss - Date.now()).toBeLessThan(first - Date.now() + 1000);
  });
});
