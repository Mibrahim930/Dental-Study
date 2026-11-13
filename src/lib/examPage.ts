// Everything the exam page (app/exams/[id]/page.tsx) shows, loaded in one place. The page refreshes every few seconds
// while lectures are being read, so this stays cheap: no per-slide JSON parsing (see examSlideKinds).
import { db, examSlideKinds, getExam, type DocumentRow, type Topic } from "./db";
import { topicConceptsForExam } from "./memory";
import { daysUntil, timeIsUp } from "./format";
import { plannerSettings, todayIn } from "./planner";
import { pendingCountsByTopic } from "./practicePlan";
import { examProgress } from "./readiness";
import { groupByLecture, sectionPlaces } from "./lectures";
import { examCoverage } from "./examPlan";

export type DocWithProgress = DocumentRow & { done: number; failed: number; batch_id: string | null };

export type ExamPageData = NonNullable<ReturnType<typeof loadExamPage>>;

/** The exam page's data for this student, or null when the exam isn't hers (or doesn't exist). */
export function loadExamPage(userId: number, examId: number) {
  const id = examId;
  const exam = getExam(id, userId);
  if (!exam) return null;

  const docs = db
    .prepare(
      `SELECT d.*, SUM(p.status = 'done') done, SUM(p.status = 'error') failed
       FROM documents d LEFT JOIN pages p ON p.document_id = d.id WHERE d.exam_id = ? GROUP BY d.id ORDER BY d.id`,
    )
    .all(id) as DocWithProgress[];
  const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(id) as Topic[];
  const sessions = db
    .prepare("SELECT * FROM study_sessions WHERE exam_id = ? ORDER BY id DESC LIMIT 5")
    .all(id) as { id: number; current_position: number; summary: string | null; started_at: string; ended_at: string | null }[];
  const attempts = db
    .prepare(
      `SELECT a.*, COUNT(aq.question_id) n, COALESCE(SUM(aq.chosen_index IS NOT NULL), 0) answered, COALESCE(SUM(aq.correct = 1), 0) n_right
       FROM attempts a LEFT JOIN attempt_questions aq ON aq.attempt_id = a.id AND aq.reported = 0
       WHERE a.exam_id = ? GROUP BY a.id ORDER BY a.id DESC LIMIT 8`,
    )
    .all(id) as { id: number; mode: string; status: string; score: number | null; started_at: string; time_limit_sec: number | null; n: number; answered: number; n_right: number }[];
  // A practice exam she stepped away from: offered first, so she continues it instead of starting another by mistake.
  // Looked up on its own (not within the 8 listed), so it never disappears here while Home still shows it.
  const openAttempt = db
    .prepare(
      `SELECT a.id, a.mode, a.started_at, a.time_limit_sec, COUNT(aq.question_id) n, COALESCE(SUM(aq.chosen_index IS NOT NULL), 0) answered
       FROM attempts a JOIN attempt_questions aq ON aq.attempt_id = a.id AND aq.reported = 0
       WHERE a.exam_id = ? AND a.status = 'ready' GROUP BY a.id HAVING answered < n ORDER BY a.id DESC LIMIT 1`,
    )
    .get(id) as { id: number; mode: string; started_at: string; time_limit_sec: number | null; n: number; answered: number } | undefined;
  const openExpired = openAttempt ? timeIsUp(openAttempt) : false;

  // For the practice form: which lecture(s) each topic comes from, and what would come back in the next exam.
  const pageDoc = new Map(
    (db.prepare("SELECT p.id, p.document_id FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ?").all(id) as {
      id: number;
      document_id: number;
    }[]).map((p) => [p.id, p.document_id]),
  );
  // Pending counts and concept chips for all topics at once (one pass each, not one query per topic).
  const pending = pendingCountsByTopic(id);
  const conceptsByTopic = topicConceptsForExam(id);
  // Sections grouped under their lectures (old-style topics, not tied to one lecture, form one group of their own).
  const groups = groupByLecture(topics, docs);
  const groupOf = new Map(groups.filter((g) => g.docId != null).map((g) => [g.docId!, g]));
  const oldStyle = groups.find((g) => g.docId == null);
  const places = sectionPlaces(topics, docs);
  const studiedIds = new Set(
    (db
      .prepare("SELECT ts.topic_id FROM topic_study ts JOIN topics t ON t.id = ts.topic_id WHERE ts.user_id = ? AND t.exam_id = ?")
      .all(userId, id) as { topic_id: number }[]).map((r) => r.topic_id),
  );
  const practiceTopics = groups.flatMap((g) =>
    g.sections.map((t, i) => ({
      id: t.id,
      title: `${i + 1}. ${t.title}`,
      group: g.no != null ? `Lecture ${g.no} · ${g.name}` : g.name,
      lectureIds: [...new Set((JSON.parse(t.page_ids) as number[]).map((p) => pageDoc.get(p)).filter((d): d is number => d != null))],
      ...(pending.get(t.id) ?? { missed: 0, unsure: 0 }),
    })),
  );
  const lecturesWithSections = groups.filter((g) => g.docId != null);
  const lecturesDone = lecturesWithSections.filter((g) => g.sections.every((t) => studiedIds.has(t.id))).length;

  // Is every slide in the study plan? Title/agenda slides are left out on purpose; anything else missing shows here.
  // Same rule as the topic map: slides without (readable) notes aren't counted (nothing to study from them yet).
  const inTopics = new Set(topics.flatMap((t) => JSON.parse(t.page_ids) as number[]));
  let fillerSlides = 0;
  let contentSlides = 0;
  let missingSlides = 0;
  for (const p of examSlideKinds(id)) {
    if (p.is_filler) fillerSlides++;
    else {
      contentSlides++;
      if (!inTopics.has(p.id)) missingSlides++;
    }
  }

  const reading = docs.filter((d) => d.status === "processing");
  const processing = reading.length > 0 || exam.topic_status === "building";
  // A Batch API read can run for up to an hour and its results are collected once a minute, so while that is the only
  // thing going on the page checks every 20 s. Slide rendering, direct reading and topic-map building move faster: 4 s.
  const refreshMs = exam.topic_status !== "building" && reading.length > 0 && reading.every((d) => d.batch_id) ? 20000 : 4000;
  const lastPosition = sessions[0]?.current_position ?? 0;
  const started = sessions.length > 0;
  const tz = plannerSettings(userId).timezone;
  const days = daysUntil(exam.exam_date, todayIn(tz));
  const totalPages = docs.reduce((a, d) => a + d.page_count, 0);
  const progress = examProgress(userId, id);
  const current = topics[lastPosition];
  const currentPlace = current ? places.get(current.id) : undefined;
  const notes = sessions.filter((s) => s.summary);
  // The one-time upgrade (or "Re-split every lecture") is turning an old-style map into lecture maps.
  const reorganising = exam.topic_status === "building" && topics.some((t) => t.document_id == null);
  const mapRow = { examId: id, conceptsByTopic, studiedIds, current: started ? lastPosition : null };
  // The practice card: how many of the facts in this exam's lectures she has been tested on (a few ms; null without sections).
  const coverage = topics.length > 0 ? examCoverage(id, { kind: "all" }) : null;

  return {
    exam,
    docs,
    topics,
    attempts,
    openAttempt,
    openExpired,
    conceptsByTopic,
    groups,
    groupOf,
    oldStyle,
    studiedIds,
    practiceTopics,
    lecturesWithSections,
    lecturesDone,
    fillerSlides,
    contentSlides,
    missingSlides,
    processing,
    refreshMs,
    lastPosition,
    started,
    tz,
    days,
    totalPages,
    progress,
    current,
    currentPlace,
    notes,
    reorganising,
    mapRow,
    coverage,
  };
}
