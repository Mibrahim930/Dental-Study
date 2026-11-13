// What the AI did lately, for the Admin page's "AI activity" card: per purpose, how many calls, how many failed and
// why, and what they cost; and for lessons, how many were written, needed a fix-up, or had a failed call. Read from
// ai_usage (lib/ai.ts logs every call there, failed ones too) in two queries for the whole site.
import { db } from "./db";

export type PurposeActivity = {
  purpose: string;
  /** The purpose in plain words ("Reading slides"). */
  label: string;
  calls: number;
  failed: number;
  /** The error text the failed calls gave most often (null when none failed or none said why). */
  topError: string | null;
  totalCost: number;
  avgCost: number;
  outputTokens: number;
};

export type LessonActivity = {
  /** Lessons written: distinct topics with a "lesson" call (calls without a ref count one each). */
  written: number;
  /** Of those, how many needed a "lesson repair" call. */
  repaired: number;
  /** How many had a failed "lesson" call. */
  failed: number;
};

export type AiActivity = { days: number; purposes: PurposeActivity[]; lessons: LessonActivity | null };

const LABELS: Record<string, string> = {
  "read slides": "Reading slides",
  "read slides (batch)": "Reading slides (batch)",
  "topic map": "Splitting into sections",
  lesson: "Lessons",
  "lesson repair": "Lesson fix-up",
  "section quiz": "Section quizzes",
  "section quiz check": "Checking quiz questions",
  "practice questions": "Practice questions",
  "case sets": "Case sets",
  "quiz me": "Quiz me",
  "exam schedule import": "Reading exam schedules",
};

/** A purpose in plain words; one without a friendly name is shown as it is logged. */
export const purposeLabel = (purpose: string) => LABELS[purpose] ?? purpose;

/** The last `days` days of AI calls, busiest purpose first. Purposes with no calls in that time are left out. */
export function aiActivity(days = 7): AiActivity {
  const since = `-${Math.max(1, Math.floor(days))} days`;
  const rows = db
    .prepare(
      `WITH recent AS (SELECT * FROM ai_usage WHERE created_at >= datetime('now', ?)),
       errors AS (
         SELECT purpose, error, ROW_NUMBER() OVER (PARTITION BY purpose ORDER BY COUNT(*) DESC, MAX(id) DESC) rk
         FROM recent WHERE ok = 0 AND error IS NOT NULL GROUP BY purpose, error
       )
       SELECT r.purpose, COUNT(*) calls, SUM(r.ok = 0) failed, COALESCE(SUM(r.cost_usd), 0) total_cost, COALESCE(AVG(r.cost_usd), 0) avg_cost,
              COALESCE(SUM(r.output_tokens), 0) output_tokens, (SELECT e.error FROM errors e WHERE e.purpose = r.purpose AND e.rk = 1) top_error
       FROM recent r GROUP BY r.purpose ORDER BY calls DESC, r.purpose`,
    )
    .all(since) as { purpose: string; calls: number; failed: number; total_cost: number; avg_cost: number; output_tokens: number; top_error: string | null }[];
  const l = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN purpose = 'lesson' THEN ref END) + COALESCE(SUM(purpose = 'lesson' AND ref IS NULL), 0) written,
              COUNT(DISTINCT CASE WHEN purpose = 'lesson repair' THEN ref END) + COALESCE(SUM(purpose = 'lesson repair' AND ref IS NULL), 0) repaired,
              COUNT(DISTINCT CASE WHEN purpose = 'lesson' AND ok = 0 THEN ref END) + COALESCE(SUM(purpose = 'lesson' AND ok = 0 AND ref IS NULL), 0) failed
       FROM ai_usage WHERE created_at >= datetime('now', ?) AND purpose IN ('lesson', 'lesson repair')`,
    )
    .get(since) as LessonActivity;
  return {
    days,
    purposes: rows.map((r) => ({
      purpose: r.purpose,
      label: purposeLabel(r.purpose),
      calls: r.calls,
      failed: r.failed ?? 0,
      topError: r.top_error,
      totalCost: r.total_cost,
      avgCost: r.avg_cost,
      outputTokens: r.output_tokens,
    })),
    lessons: l.written || l.repaired || l.failed ? { written: l.written, repaired: l.repaired, failed: l.failed } : null,
  };
}
