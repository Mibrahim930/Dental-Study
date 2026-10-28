import Link from "next/link";
import { notFound } from "next/navigation";
import { db, getExam, type DocumentRow, type Topic } from "@/lib/db";
import { topicConceptsForExam } from "@/lib/memory";
import { daysUntil, formatDate, pct, sinceText, timeIsUp } from "@/lib/format";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Uploader } from "@/components/Uploader";
import { PracticeForm } from "@/components/PracticeForm";
import { ActionButton } from "@/components/ActionButton";
import { RemoveLectureButton } from "@/components/RemoveLectureButton";
import { LectureReviewCard } from "@/components/LectureReviewCard";
import { QuizMe } from "@/components/QuizMe";
import { setArchived, updateExam } from "@/app/actions";
import { requireUser } from "@/lib/user";
import { plannerSettings, todayIn } from "@/lib/planner";
import { pendingCountsByTopic } from "@/lib/practicePlan";
import { KIND_LABEL, KIND_STYLE } from "@/lib/calendar";
import { examProgress } from "@/lib/readiness";
import { DoubleRing, Icon, ICONS, MasteryChip } from "@/components/ui";
import { groupByLecture, lectureName, sectionPlaces } from "@/lib/lectures";

export const dynamic = "force-dynamic";

type DocWithProgress = DocumentRow & { done: number; failed: number; batch_id: string | null };

export default async function ExamPage(props: PageProps<"/exams/[id]">) {
  const user = await requireUser();
  const id = Number((await props.params).id);
  const exam = getExam(id, user.id);
  if (!exam) notFound();

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
      .all(user.id, id) as { topic_id: number }[]).map((r) => r.topic_id),
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
  const inTopics = new Set(topics.flatMap((t) => JSON.parse(t.page_ids) as number[]));
  const slideRows = db
    .prepare("SELECT p.id, p.notes_json FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ? AND p.status = 'done'")
    .all(id) as { id: number; notes_json: string | null }[];
  let fillerSlides = 0;
  let contentSlides = 0;
  let missingSlides = 0;
  for (const p of slideRows) {
    // Same rule as the topic map: slides without notes aren't mapped (nothing to study from them yet).
    let filler: boolean;
    try {
      if (!p.notes_json) continue;
      filler = !!(JSON.parse(p.notes_json) as { is_filler?: boolean }).is_filler;
    } catch {
      continue;
    }
    if (filler) fillerSlides++;
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
  const tz = plannerSettings(user.id).timezone;
  const days = daysUntil(exam.exam_date, todayIn(tz));
  const totalPages = docs.reduce((a, d) => a + d.page_count, 0);
  const progress = examProgress(user.id, id);
  const current = topics[lastPosition];
  const currentPlace = current ? places.get(current.id) : undefined;
  const notes = sessions.filter((s) => s.summary);
  // The one-time upgrade (or a Rebuild) is turning an old-style map into lecture maps.
  const reorganising = exam.topic_status === "building" && topics.some((t) => t.document_id == null);
  const mapRow = { examId: id, conceptsByTopic, studiedIds, current: started ? lastPosition : null };

  return (
    <div className="flex flex-col gap-2.5 sm:gap-4">
      <AutoRefresh active={processing} ms={refreshMs} />
      {/* The panel the lecture review opens in (no text-selection pill here: nothing on this page to be quizzed on). */}
      <QuizMe examId={exam.id} selection={false} />
      <div className="flex items-center justify-between gap-3 px-1">
        <Link href="/" className="flex items-center gap-1.5 text-[15px] font-bold text-muted-foreground hover:text-foreground">
          <Icon d={ICONS.arrowLeft} size={18} /> All exams
        </Link>
        <details className="relative">
          <summary className="btn-secondary btn-sm cursor-pointer list-none">Edit exam</summary>
          <div className="card absolute right-0 z-20 mt-2 w-80 space-y-3 shadow-[0_12px_36px_rgba(22,22,22,.16)]">
            <form action={updateExam.bind(null, id)} className="space-y-2.5">
              <input name="name" defaultValue={exam.name} className="input" aria-label="Exam name" required />
              <input name="course" defaultValue={exam.course ?? ""} placeholder="Course" aria-label="Course" className="input" />
              <input name="exam_date" type="date" defaultValue={exam.exam_date ?? ""} aria-label="Exam date" className="input" />
              <select name="kind" defaultValue={exam.kind} aria-label="Exam type" className="input">
                <option value="block">Block exam</option>
                <option value="quiz">Quiz</option>
                <option value="practical">Practical</option>
                <option value="board">Board exam (e.g. INBDE)</option>
                <option value="other">Other</option>
              </select>
              <button className="btn-primary w-full">Save</button>
            </form>
            <form action={setArchived.bind(null, id, exam.status !== "archived")}>
              <button className="btn-secondary w-full">{exam.status === "archived" ? "Unarchive" : "Archive exam"}</button>
            </form>
          </div>
        </details>
      </div>

      {/* Hero in the exam's type colour, with mastery (outer) and topics studied (inner). */}
      <section className={`flex flex-col gap-5 rounded-[32px] p-6 sm:flex-row sm:items-center sm:justify-between sm:rounded-[36px] sm:p-8 ${KIND_STYLE[exam.kind]}`}>
        <div className="min-w-0">
          <div className="text-[13px] font-bold opacity-75">
            {KIND_LABEL[exam.kind]}
            {exam.course ? ` · ${exam.course}` : ""}
            {exam.status === "archived" && " · Archived"}
          </div>
          <h1 className="mt-1 text-[34px] leading-[1.02] font-extrabold tracking-[-0.035em] sm:text-[48px]">{exam.name}</h1>
          <div className="mt-2 text-[15px] font-semibold opacity-80">
            {formatDate(exam.exam_date)}
            {days != null && days >= 0 && ` · ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} left`}`}
          </div>
        </div>
        {topics.length > 0 && (
          <div className="flex items-center gap-4">
            <DoubleRing
              size={112}
              outer={progress.mastery ?? 0}
              inner={progress.studied}
              center={progress.mastery == null ? "New" : `${Math.round(progress.mastery * 100)}%`}
              outerColor="currentColor"
              innerColor="color-mix(in srgb, currentColor 40%, transparent)"
              track="rgb(0 0 0 / 0.12)"
              label={`Mastery ${progress.mastery == null ? "not tested yet" : `${Math.round(progress.mastery * 100)} percent`}, ${Math.round(progress.studied * 100)} percent of sections studied`}
            />
            <div className="flex flex-col gap-2 text-[13px] font-bold">
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-[4px] bg-current" aria-hidden /> Mastery {progress.mastery == null ? "–" : pct(progress.mastery)}
              </span>
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-[4px] bg-current opacity-40" aria-hidden /> {Math.round(progress.studied * topics.length)}/{topics.length}{" "}
                {lecturesWithSections.length ? "sections" : "topics"} studied
              </span>
              {lecturesWithSections.length > 0 && (
                <span className="flex items-center gap-2 pl-5">
                  {lecturesDone} of {lecturesWithSections.length} lecture{lecturesWithSections.length === 1 ? "" : "s"} done
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-2.5 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          {/* Teal study card */}
          <section className="card-hero flex flex-col gap-4">
            {topics.length === 0 ? (
              <>
                <h2 className="section-title">Study</h2>
                <p className="text-[15px] text-hero-muted">
                  Upload this exam&apos;s lectures. Once they&apos;re read, a topic map is built and you can start studying.
                </p>
              </>
            ) : (
              <>
                <div>
                  <div className="text-[13px] font-bold text-hero-muted">
                    {started
                      ? currentPlace?.lectureNo != null
                        ? `Lecture ${currentPlace.lectureNo} · Section ${currentPlace.section} of ${currentPlace.sections}`
                        : `Topic ${lastPosition + 1} of ${topics.length}`
                      : lecturesWithSections.length
                        ? `${lecturesWithSections.length} lecture${lecturesWithSections.length === 1 ? "" : "s"} · ${topics.length} sections`
                        : `${topics.length} topics`}
                  </div>
                  <h2 className="mt-1 text-[26px] leading-tight font-extrabold tracking-[-0.03em]">
                    {started && current ? current.title : "Guided study with lessons, slides and quizzes"}
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/exams/${id}/study`} className="btn-hero btn-lg flex-1 sm:flex-none">
                    {started ? "Continue" : "Start studying"} <Icon d={ICONS.arrowRight} />
                  </Link>
                  {started && (
                    <Link href={`/exams/${id}/study?restart=1`} className="btn-secondary btn-lg bg-white/10 text-hero-foreground hover:bg-white/20">
                      Start over
                    </Link>
                  )}
                </div>
                {notes.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <div className="text-[13px] font-bold text-hero-muted">Session notes</div>
                    {notes.map((s) => (
                      <p key={s.id} className="rounded-[18px] bg-white/10 p-3.5 text-[15px] leading-relaxed">
                        <span className="font-bold text-hero-accent">{s.ended_at?.slice(5, 10).replace("-", "/")} </span>
                        {s.summary}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Lectures: upload, then each lecture's sections (its topic map), with progress. */}
          <section className="card flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="section-title">Lectures</h2>
              <div className="flex items-center gap-2">
                {totalPages > 0 && <span className="eyebrow">{totalPages} slides</span>}
                {exam.topic_status !== "building" && docs.length > 0 && !processing && (
                  <ActionButton url={`/api/exams/${id}/topics`} label={topics.length ? "Rebuild" : "Build topic map"} className="btn-secondary btn-sm" />
                )}
              </div>
            </div>
            {exam.topic_status === "building" && (
              <p className="rounded-2xl bg-butter px-4 py-3 text-sm font-semibold text-on-butter">
                {reorganising
                  ? "Reorganising your topics by lecture… this takes a minute or two. You can keep studying meanwhile."
                  : "Splitting your lectures into sections… this takes a minute or two."}
              </p>
            )}
            {exam.topic_status === "error" && (
              <p className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">Topic map failed: {exam.topic_error}</p>
            )}
            {topics.length > 0 && exam.topic_status !== "building" && contentSlides > 0 && (
              <p className={`text-[13px] font-semibold ${missingSlides ? "rounded-2xl bg-butter px-4 py-3 text-on-butter" : "text-muted-foreground"}`}>
                {missingSlides
                  ? `${missingSlides} of ${contentSlides} slides aren't in a section yet. Tap Rebuild to add them.`
                  : `All ${contentSlides} slides are in your study plan.`}
                {fillerSlides > 0 && ` ${fillerSlides} title or agenda slide${fillerSlides === 1 ? " was" : "s were"} left out.`}
              </p>
            )}
            <Uploader examId={id} />
            {docs.map((d, i) => {
              const group = groupOf.get(d.id);
              const no = i + 1;
              const name = lectureName(d.filename);
              const reading = d.status === "processing" || d.status === "pending";
              const status = <LectureStatus doc={d} />;
              const remove = <RemoveLectureButton docId={d.id} name={name} reading={reading} />;
              if (!group) {
                return (
                  <div key={d.id} className="flex flex-col gap-2 rounded-[22px] bg-muted p-4">
                    <LectureHead no={no} name={name}>
                      {d.status === "done" ? (
                        <span className="chip cb-mint shrink-0">{d.page_count} slides</span>
                      ) : d.status === "error" ? (
                        <span className="chip cb-coral shrink-0">Failed</span>
                      ) : (
                        <span className="chip cb-butter shrink-0">{d.status === "pending" ? "Waiting" : "Reading"}</span>
                      )}
                    </LectureHead>
                    {d.status === "done" && (
                      <p className="text-[13px] font-medium text-muted-foreground">
                        {exam.topic_status === "building"
                          ? "Being split into sections…"
                          : oldStyle
                            ? "In the topic list below until it's split into sections."
                            : "No sections yet. Tap Rebuild to split it into sections."}
                      </p>
                    )}
                    {status}
                    <div className="-mt-1 flex justify-end">{remove}</div>
                  </div>
                );
              }
              const sections = group.sections;
              const doneCount = sections.filter((t) => studiedIds.has(t.id)).length;
              const stars = sections.filter((t) => t.emphasized).length;
              const slides = sections.reduce((n, t) => n + (JSON.parse(t.page_ids) as number[]).length, 0);
              const mastery = average(sections.flatMap((t) => (conceptsByTopic.get(t.id) ?? []).map((c) => c.mastery)));
              const here = started && sections.some((t) => t.position === lastPosition);
              return (
                <details key={d.id} className="group rounded-[22px] bg-muted" open={here}>
                  <summary className="flex cursor-pointer list-none flex-col gap-2.5 rounded-[22px] p-4 hover:bg-muted-strong [&::-webkit-details-marker]:hidden">
                    <LectureHead no={no} name={name}>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <MasteryChip value={mastery} />
                        <Icon d={ICONS.chevronDown} size={18} className="text-muted-foreground transition-transform group-open:rotate-180" />
                      </span>
                    </LectureHead>
                    <div className="text-[13px] font-semibold text-muted-foreground">
                      {doneCount} of {sections.length} section{sections.length === 1 ? "" : "s"} done · {slides} slides
                      {stars > 0 && <span className="text-warning"> · ★ {stars}</span>}
                      {d.status === "error" && <span className="text-danger"> · some slides failed</span>}
                    </div>
                    <div className="bar bg-card" role="progressbar" aria-label={`${name}: ${doneCount} of ${sections.length} sections done`} aria-valuemin={0} aria-valuemax={sections.length} aria-valuenow={doneCount}>
                      <span className="bg-hero" style={{ width: `${(doneCount / sections.length) * 100}%` }} />
                    </div>
                  </summary>
                  <div className="flex flex-col gap-2 px-2.5 pb-3">
                    {status}
                    <ol className="flex flex-col gap-2">
                      {sections.map((t, k) => (
                        <SectionRow key={t.id} topic={t} n={k + 1} {...mapRow} />
                      ))}
                    </ol>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {/* Missed questions from this lecture's quizzes, as one review quiz (opens in the Quiz me panel). */}
                      <LectureReviewCard examId={exam.id} documentId={d.id} lecture={name} compact />
                      {remove}
                    </div>
                  </div>
                </details>
              );
            })}
            {oldStyle && (
              <details className="group rounded-[22px] bg-muted" open={!groups.some((g) => g.docId != null)}>
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-[22px] p-4 hover:bg-muted-strong [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0">
                    <div className="leading-snug font-bold">Topics from all lectures</div>
                    <div className="text-[13px] font-medium text-muted-foreground">
                      {oldStyle.sections.length} topics, made before topics were grouped by lecture.
                      {exam.topic_status === "building" ? "" : " Tap Rebuild to split them by lecture."}
                    </div>
                  </div>
                  <Icon d={ICONS.chevronDown} size={18} className="mt-1 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <ol className="flex flex-col gap-2 px-2.5 pb-3">
                  {oldStyle.sections.map((t) => (
                    <SectionRow key={t.id} topic={t} n={t.position + 1} {...mapRow} />
                  ))}
                </ol>
              </details>
            )}
            {topics.length > 0 && (
              <p className="text-[13px] text-muted-foreground">
                Chips show mastery: mint ≥80%, butter ≥60%, coral below, “New” untested. ★ you emphasized in your notes. ↺ covered in an earlier exam. ✓ studied.
              </p>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-2.5 sm:gap-4">
          {/* Practice */}
          <section className="card flex flex-col gap-4">
            <h2 className="section-title">Practice exam</h2>
            {openAttempt && (
              <Link href={`/attempts/${openAttempt.id}`} className="tile cb-butter flex items-center justify-between gap-3 rounded-[22px]">
                <div className="min-w-0">
                  <div className="text-[13px] font-bold opacity-75">{openAttempt.mode === "timed" ? "Timed" : "Learn"} practice exam in progress</div>
                  <div className="text-[17px] leading-tight font-extrabold">
                    {openExpired ? "Time is up — see your score" : `Continue · ${openAttempt.answered} of ${openAttempt.n} answered`}
                  </div>
                  <div className="text-[13px] font-medium opacity-80">Started {sinceText(openAttempt.started_at)}. Your answers so far are saved.</div>
                </div>
                <Icon d={ICONS.arrowRight} />
              </Link>
            )}
            {topics.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">Available once the topic map is ready.</p>
            ) : (
              <PracticeForm
                examId={id}
                topics={practiceTopics}
                lectures={docs.map((d) => ({ id: d.id, name: d.filename.replace(/\.pdf$/i, "") }))}
                focusWeak={!!user.focus_weak}
              />
            )}
            {attempts.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border pt-3">
                <div className="eyebrow pb-1">Past attempts</div>
                {attempts.map((a) => (
                  <Link key={a.id} href={`/attempts/${a.id}`} className="flex items-center justify-between gap-2 rounded-2xl px-2 py-2.5 hover:bg-muted">
                    <span className="text-[15px] font-semibold">
                      {localDay(a.started_at, tz)} · {a.n} questions · {a.mode === "timed" ? "Timed" : "Learn"}
                    </span>
                    {a.status === "finished" ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <MasteryChip value={a.score} />
                        <span className="text-[13px] font-bold text-muted-foreground">
                          {a.n_right}/{a.n}
                        </span>
                      </span>
                    ) : (
                      <span className="chip bg-muted text-muted-foreground">{a.status === "error" ? "Failed" : "In progress"}</span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const average = (xs: (number | null)[]): number | null => {
  const ms = xs.filter((m): m is number => m != null);
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
};

/** A lecture row's head: its number, "Lecture N", its name, and whatever sits on the right. */
function LectureHead({ no, name, children }: { no: number; name: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-card text-sm font-extrabold">{no}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold text-muted-foreground">Lecture {no}</div>
        <div className="leading-snug font-bold break-words">{name}</div>
      </div>
      {children}
    </div>
  );
}

/** Reading progress, or the error with Retry, for a lecture that isn't fully read. */
function LectureStatus({ doc }: { doc: DocWithProgress }) {
  const done = doc.done ?? 0;
  if (doc.status === "processing" && doc.page_count > 0) {
    return (
      <div className="flex items-center gap-2.5">
        <div className="bar flex-1 bg-card">
          <span className="bg-hero" style={{ width: `${(done / doc.page_count) * 100}%` }} />
        </div>
        <span className="text-xs font-bold text-muted-foreground">
          {done}/{doc.page_count}
        </span>
      </div>
    );
  }
  if (doc.status === "error") {
    return (
      <div className="flex items-center justify-between gap-2 text-sm text-danger">
        <span className="min-w-0 break-words">{doc.error}</span>
        <ActionButton url={`/api/documents/${doc.id}/retry`} label="Retry" className="btn-secondary btn-sm shrink-0 bg-card" />
      </div>
    );
  }
  return null;
}

/** One section of a lecture: number (✓ once studied), title, slides, mastery, concept chips; the whole row opens it. */
function SectionRow({
  topic: t,
  n,
  examId,
  conceptsByTopic,
  studiedIds,
  current,
}: {
  topic: Topic;
  n: number;
  examId: number;
  conceptsByTopic: ReturnType<typeof topicConceptsForExam>;
  studiedIds: Set<number>;
  current: number | null;
}) {
  const concepts = conceptsByTopic.get(t.id) ?? [];
  const isCurrent = t.position === current;
  const studied = studiedIds.has(t.id);
  const mastery = average(concepts.map((c) => c.mastery));
  return (
    <li>
      <Link
        href={`/exams/${examId}/study?topic=${t.position}`}
        className={`flex flex-col gap-2 rounded-[18px] p-3.5 transition-colors ${isCurrent ? "bg-hero text-hero-foreground" : "bg-card hover:bg-muted-strong"}`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[13px] font-extrabold ${
              studied ? "bg-mint text-on-mint" : isCurrent ? "bg-white/15" : "bg-muted"
            }`}
          >
            {studied ? (
              <>
                <Icon d={ICONS.check} size={15} />
                <span className="sr-only">Section {n}, studied:</span>
              </>
            ) : (
              n
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="leading-snug font-bold break-words">
              {t.title}
              {t.emphasized ? <span className={isCurrent ? "text-hero-accent-2" : "text-warning"} title="You emphasized this"> ★</span> : null}
            </div>
            <div className={`text-[13px] font-medium ${isCurrent ? "text-hero-muted" : "text-muted-foreground"}`}>
              {(JSON.parse(t.page_ids) as number[]).length} slides{isCurrent ? " · you're here" : ""}
            </div>
          </div>
          <MasteryChip value={mastery} className="shrink-0" />
        </div>
        {concepts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {concepts.map((c) => (
              <span
                key={c.id}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-[10px] py-0.5 pr-2 pl-0.5 text-[12px] font-semibold ${isCurrent ? "bg-white/10" : "bg-muted text-foreground"}`}
                title={c.earlier_exams.length ? `Also in: ${c.earlier_exams.join(", ")}` : "New for this exam"}
              >
                <MasteryChip value={c.mastery} className="px-1.5 py-0 text-[11px]" />
                <span className="min-w-0 break-words">{c.name}</span>
                {c.earlier_exams.length > 0 && " ↺"}
              </span>
            ))}
          </div>
        )}
        <span className={`flex items-center gap-1 self-end text-[13px] font-extrabold ${isCurrent ? "text-hero-accent" : "text-primary"}`}>
          Study this <Icon d={ICONS.arrowRight} size={15} />
        </span>
      </Link>
    </li>
  );
}

/** A stored UTC timestamp ("2026-10-09 02:30:00") as the student's local month/day. */
function localDay(utc: string, timeZone: string): string {
  const d = new Date(utc.replace(" ", "T") + "Z");
  try {
    return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone });
  } catch {
    return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
  }
}
