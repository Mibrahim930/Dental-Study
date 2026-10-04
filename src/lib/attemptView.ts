import { db } from "./db";
import { parseNotes } from "./processing";

type Row = {
  question_id: number;
  position: number;
  chosen_index: number | null;
  correct: number | null;
  type: "recall" | "case" | "image";
  patient_box: string | null;
  stem: string;
  options: string;
  correct_index: number;
  explanation: string;
  image_page_id: number | null;
  source_page_id: number | null;
  flagged: number;
  case_id: number | null;
  scenario: string | null;
  topic_title: string | null;
  concept_name: string | null;
  source_filename: string | null;
  source_page_number: number | null;
};

/** The attempt as the student may see it: answers are only revealed when allowed. */
export function attemptView(attemptId: number) {
  const attempt = db.prepare("SELECT a.*, e.name AS exam_name FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.id = ?").get(attemptId) as
    | {
        id: number;
        exam_id: number;
        exam_name: string;
        mode: "tutor" | "timed";
        status: string;
        error: string | null;
        time_limit_sec: number | null;
        score: number | null;
        started_at: string;
      }
    | undefined;
  if (!attempt) return null;
  const finished = attempt.status === "finished";
  const rows = db
    .prepare(
      `SELECT aq.question_id, aq.position, aq.chosen_index, aq.correct, q.*, t.title AS topic_title, c.name AS concept_name,
              d.filename AS source_filename, sp.page_number AS source_page_number
       , cs.scenario
       FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
       LEFT JOIN cases cs ON cs.id = q.case_id
       LEFT JOIN topics t ON t.id = q.topic_id LEFT JOIN concepts c ON c.id = q.concept_id
       LEFT JOIN pages sp ON sp.id = q.source_page_id LEFT JOIN documents d ON d.id = sp.document_id
       WHERE aq.attempt_id = ? ORDER BY aq.position`,
    )
    .all(attemptId) as Row[];

  const imagePage = db.prepare("SELECT notes_json, aspect FROM pages WHERE id = ?");
  // Number the cases in the order they appear, and each question within its case.
  const caseNumber = new Map<number, number>();
  const caseSize = new Map<number, number>();
  for (const r of rows) {
    if (r.case_id == null) continue;
    if (!caseNumber.has(r.case_id)) caseNumber.set(r.case_id, caseNumber.size + 1);
    caseSize.set(r.case_id, (caseSize.get(r.case_id) ?? 0) + 1);
  }
  const seenInCase = new Map<number, number>();
  const questions = rows.map((r) => {
    const reveal = finished || (attempt.mode === "tutor" && r.chosen_index != null);
    let image: { page_id: number; aspect: number; crop: unknown } | null = null;
    if (r.image_page_id) {
      const p = imagePage.get(r.image_page_id) as { notes_json: string | null; aspect: number } | undefined;
      if (p) image = { page_id: r.image_page_id, aspect: p.aspect, crop: parseNotes(p)?.case_image_box ?? null };
    }
    const caseInfo =
      r.case_id != null
        ? (() => {
            const n = (seenInCase.get(r.case_id) ?? 0) + 1;
            seenInCase.set(r.case_id, n);
            return { number: caseNumber.get(r.case_id)!, index: n, size: caseSize.get(r.case_id)!, scenario: r.scenario ?? "" };
          })()
        : null;
    return {
      id: r.question_id,
      position: r.position,
      caseInfo,
      type: r.type,
      patient_box: r.patient_box ? (JSON.parse(r.patient_box) as Record<string, string>) : null,
      stem: r.stem,
      options: JSON.parse(r.options) as string[],
      image,
      chosen_index: r.chosen_index,
      flagged: !!r.flagged,
      topic: r.topic_title,
      concept: r.concept_name,
      ...(reveal
        ? {
            correct_index: r.correct_index,
            correct: r.correct === 1,
            explanation: r.explanation,
            source: r.source_page_id
              ? { page_id: r.source_page_id, filename: r.source_filename, page_number: r.source_page_number }
              : null,
          }
        : {}),
    };
  });
  return { attempt, questions };
}

export type AttemptView = NonNullable<ReturnType<typeof attemptView>>;
