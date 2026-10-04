import { db } from "@/lib/db";

let n = 0;
export function makeUser(): number {
  n++;
  return Number(db.prepare("INSERT INTO users (email, password_hash) VALUES (?, 'x')").run(`user${n}-${Date.now()}@test.dev`).lastInsertRowid);
}

export function makeExam(userId: number, date: string | null, topicSlides: number[] = [], name = "Exam"): { examId: number; topicIds: number[] } {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, exam_date) VALUES (?, ?, ?)").run(userId, name, date).lastInsertRowid);
  const topicIds = topicSlides.map((slides, i) =>
    Number(
      db
        .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)")
        .run(examId, i, `Topic ${i + 1}`, JSON.stringify(Array.from({ length: slides }, (_, k) => 100000 + i * 100 + k))).lastInsertRowid,
    ),
  );
  return { examId, topicIds };
}
