import Link from "next/link";
import { notFound } from "next/navigation";
import { db, getExam, type DocumentRow, type Topic } from "@/lib/db";
import { topicConcepts } from "@/lib/memory";
import { daysUntil, formatDate, pct } from "@/lib/format";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Uploader } from "@/components/Uploader";
import { PracticeForm } from "@/components/PracticeForm";
import { ActionButton } from "@/components/ActionButton";
import { setArchived, updateExam } from "@/app/actions";
import { requireUser } from "@/lib/user";
import { pendingCounts } from "@/lib/practicePlan";
import { KIND_LABEL, KIND_STYLE } from "@/lib/calendar";
import { examProgress } from "@/lib/readiness";
import { DoubleRing, Icon, ICONS, MasteryChip } from "@/components/ui";

export const dynamic = "force-dynamic";

type DocWithProgress = DocumentRow & { done: number; failed: number };

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
      `SELECT a.*, COUNT(aq.question_id) n FROM attempts a LEFT JOIN attempt_questions aq ON aq.attempt_id = a.id
       WHERE a.exam_id = ? GROUP BY a.id ORDER BY a.id DESC LIMIT 8`,
    )
    .all(id) as { id: number; mode: string; status: string; score: number | null; started_at: string; n: number }[];

  // For the practice form: which lecture(s) each topic comes from, and what would come back in the next exam.
  const pageDoc = new Map(
    (db.prepare("SELECT p.id, p.document_id FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ?").all(id) as {
      id: number;
      document_id: number;
    }[]).map((p) => [p.id, p.document_id]),
  );
  const practiceTopics = topics.map((t) => ({
    id: t.id,
    title: `${t.position + 1}. ${t.title}`,
    lectureIds: [...new Set((JSON.parse(t.page_ids) as number[]).map((p) => pageDoc.get(p)).filter((d): d is number => d != null))],
    ...pendingCounts(id, [t.id]),
  }));

  const processing = docs.some((d) => d.status === "processing") || exam.topic_status === "building";
  const lastPosition = sessions[0]?.current_position ?? 0;
  const started = sessions.length > 0;
  const days = daysUntil(exam.exam_date);
  const totalPages = docs.reduce((a, d) => a + d.page_count, 0);
  const progress = examProgress(user.id, id);
  const current = topics[lastPosition];
  const notes = sessions.filter((s) => s.summary);

  return (
    <div className="flex flex-col gap-2.5 sm:gap-4">
      <AutoRefresh active={processing} />
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
              innerColor="var(--card)"
              track="rgb(0 0 0 / 0.12)"
              label={`Mastery ${progress.mastery == null ? "not tested yet" : `${Math.round(progress.mastery * 100)} percent`}, ${Math.round(progress.studied * 100)} percent of topics studied`}
            />
            <div className="flex flex-col gap-2 text-[13px] font-bold">
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-[4px] bg-current" aria-hidden /> Mastery {progress.mastery == null ? "–" : pct(progress.mastery)}
              </span>
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-[4px] bg-card" aria-hidden /> {Math.round(progress.studied * topics.length)}/{topics.length} topics studied
              </span>
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
                    {started ? `Topic ${lastPosition + 1} of ${topics.length}` : `${topics.length} topics`}
                  </div>
                  <h2 className="mt-1 text-[26px] leading-tight font-extrabold tracking-[-0.03em]">
                    {started && current ? current.title : "Guided study with lessons, slides, quizzes and a tutor"}
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/exams/${id}/study`} className="btn-hero btn-lg flex-1 sm:flex-none">
                    {started ? "Continue" : "Start studying"} <Icon d={ICONS.arrowRight} />
                  </Link>
                  {started && (
                    <Link href={`/exams/${id}/study?restart=1`} className="btn btn-lg bg-white/10 text-hero-foreground hover:bg-white/20">
                      Start over
                    </Link>
                  )}
                </div>
                {notes.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <div className="text-[13px] font-bold text-hero-muted">Session notes</div>
                    {notes.map((s) => (
                      <p key={s.id} className="rounded-[18px] bg-white/10 p-3.5 text-[15px] leading-relaxed">
                        <span className="font-bold text-mint">{s.ended_at?.slice(5, 10).replace("-", "/")} </span>
                        {s.summary}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Topic map */}
          <section className="card">
            <div className="flex items-center justify-between gap-2 pb-3">
              <h2 className="section-title">Topic map</h2>
              {exam.topic_status !== "building" && docs.length > 0 && !processing && (
                <ActionButton url={`/api/exams/${id}/topics`} label={topics.length ? "Rebuild" : "Build topic map"} className="btn-secondary btn-sm" />
              )}
            </div>
            {exam.topic_status === "building" && (
              <p className="mb-3 rounded-2xl bg-butter px-4 py-3 text-sm font-semibold text-on-butter">Organizing your slides into topics… this takes a minute or two.</p>
            )}
            {exam.topic_status === "error" && (
              <p className="mb-3 rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">Topic map failed: {exam.topic_error}</p>
            )}
            <ol className="grid gap-2.5 sm:grid-cols-2">
              {topics.map((t) => {
                const concepts = topicConcepts(t.id, id);
                const isCurrent = started && t.position === lastPosition;
                return (
                  <li key={t.id}>
                    <Link
                      href={`/exams/${id}/study?topic=${t.position}`}
                      className={`flex h-full flex-col gap-2 rounded-[22px] p-4 transition-colors ${
                        isCurrent ? "bg-hero text-hero-foreground" : "bg-muted hover:bg-muted-strong"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-sm font-extrabold ${
                            isCurrent ? "bg-mint text-on-mint" : "bg-card"
                          }`}
                        >
                          {t.position + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="leading-snug font-bold">
                            {t.title}
                            {t.emphasized ? <span className={isCurrent ? "text-butter" : "text-warning"} title="Emphasized in lecture"> ★</span> : null}
                          </div>
                          <div className={`text-[13px] font-medium ${isCurrent ? "text-hero-muted" : "text-muted-foreground"}`}>
                            {JSON.parse(t.page_ids).length} slides{isCurrent ? " · you're here" : ""}
                          </div>
                        </div>
                      </div>
                      {concepts.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {concepts.map((c) => (
                            <span
                              key={c.id}
                              className="inline-flex items-center gap-1.5 rounded-[10px] bg-card py-0.5 pr-2 pl-0.5 text-[12px] font-semibold text-foreground"
                              title={c.earlier_exams.length ? `Also in: ${c.earlier_exams.join(", ")}` : "New for this exam"}
                            >
                              <MasteryChip value={c.mastery} className="px-1.5 py-0 text-[11px]" />
                              {c.name}
                              {c.earlier_exams.length > 0 && " ↺"}
                            </span>
                          ))}
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ol>
            {topics.length > 0 && (
              <p className="mt-3 text-[13px] text-muted-foreground">
                Chips show mastery: mint ≥80%, butter ≥60%, coral below, “New” untested. ★ emphasized by your professor. ↺ covered in an earlier exam.
              </p>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-2.5 sm:gap-4">
          {/* Practice */}
          <section className="card flex flex-col gap-4">
            <h2 className="section-title">Practice exam</h2>
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
                      {a.started_at.slice(5, 10).replace("-", "/")} · {a.n} questions · {a.mode === "timed" ? "Timed" : "Tutor"}
                    </span>
                    {a.status === "finished" ? (
                      <MasteryChip value={a.score} />
                    ) : (
                      <span className="chip bg-muted text-muted-foreground">{a.status === "error" ? "Failed" : "In progress"}</span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Lectures */}
          <section className="card flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 className="section-title">Lectures</h2>
              {totalPages > 0 && <span className="eyebrow">{totalPages} slides</span>}
            </div>
            <Uploader examId={id} />
            {docs.map((d) => {
              const done = d.done ?? 0;
              return (
                <div key={d.id} className="flex flex-col gap-2 rounded-[20px] bg-muted p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 text-[15px] leading-snug font-semibold break-words">{d.filename}</span>
                    {d.status === "done" ? (
                      <span className="chip cb-mint shrink-0">{d.page_count} slides</span>
                    ) : d.status === "error" ? (
                      <span className="chip cb-coral shrink-0">Failed</span>
                    ) : (
                      <span className="chip cb-butter shrink-0">{d.status === "pending" ? "Waiting" : "Reading"}</span>
                    )}
                  </div>
                  {d.status === "processing" && d.page_count > 0 && (
                    <div className="flex items-center gap-2.5">
                      <div className="bar flex-1 bg-card">
                        <span className="bg-hero" style={{ width: `${(done / d.page_count) * 100}%` }} />
                      </div>
                      <span className="text-xs font-bold text-muted-foreground">
                        {done}/{d.page_count}
                      </span>
                    </div>
                  )}
                  {d.status === "error" && (
                    <div className="flex items-center justify-between gap-2 text-sm text-danger">
                      <span className="min-w-0 break-words">{d.error}</span>
                      <ActionButton url={`/api/documents/${d.id}/retry`} label="Retry" className="btn-secondary btn-sm shrink-0 bg-card" />
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </div>
  );
}
