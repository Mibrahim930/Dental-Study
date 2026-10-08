import Link from "next/link";
import { notFound } from "next/navigation";
import { db, getExam, type DocumentRow, type Topic } from "@/lib/db";
import { topicConcepts } from "@/lib/memory";
import { daysUntil, formatDate, masteryColor, pct } from "@/lib/format";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Uploader } from "@/components/Uploader";
import { PracticeForm } from "@/components/PracticeForm";
import { ActionButton } from "@/components/ActionButton";
import { setArchived, updateExam } from "@/app/actions";
import { requireUser } from "@/lib/user";
import { pendingCounts } from "@/lib/practicePlan";

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
  const openSession = sessions.find((s) => !s.ended_at);
  const lastPosition = sessions[0]?.current_position ?? 0;
  const days = daysUntil(exam.exam_date);
  const totalPages = docs.reduce((a, d) => a + d.page_count, 0);

  return (
    <div className="space-y-6">
      <AutoRefresh active={processing} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-muted-foreground hover:underline">← All exams</Link>
          <h1 className="page-title">{exam.name}</h1>
          <p className="text-muted-foreground">
            {exam.course ? `${exam.course} · ` : ""}
            {formatDate(exam.exam_date)}
            {days != null && days >= 0 && ` · ${days} day${days === 1 ? "" : "s"} left`}
            {exam.status === "archived" && " · Archived"}
          </p>
        </div>
        <details className="relative">
          <summary className="btn-ghost cursor-pointer list-none">Edit exam</summary>
          <div className="card absolute right-0 z-10 mt-2 w-72 space-y-3">
            <form action={updateExam.bind(null, id)} className="space-y-2">
              <input name="name" defaultValue={exam.name} className="input" required />
              <input name="course" defaultValue={exam.course ?? ""} placeholder="Course" className="input" />
              <input name="exam_date" type="date" defaultValue={exam.exam_date ?? ""} className="input" />
              <select name="kind" defaultValue={exam.kind} className="input">
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {/* Study */}
          <section className="card">
            <h2 className="section-title">Study</h2>
            {topics.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Upload this exam&apos;s lectures. Once they&apos;re processed, a topic map is built and you can start studying.
              </p>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  Guided walkthrough of {topics.length} topics, with slide images, quick checks and a tutor you can ask anything.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={`/exams/${id}/study`} className="btn-primary">
                    {openSession || sessions.length ? `Continue at topic ${lastPosition + 1}` : "Start studying"}
                  </Link>
                  {sessions.length > 0 && (
                    <Link href={`/exams/${id}/study?restart=1`} className="btn-secondary">Start from topic 1</Link>
                  )}
                </div>
                {sessions.some((s) => s.summary) && (
                  <div className="mt-4 space-y-2">
                    <h3 className="text-sm font-medium text-foreground">Session notes</h3>
                    {sessions
                      .filter((s) => s.summary)
                      .map((s) => (
                        <p key={s.id} className="rounded-lg bg-muted p-3 text-sm text-foreground">
                          <span className="text-muted-foreground">{s.ended_at?.slice(0, 10)}: </span>
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
            <div className="flex items-center justify-between gap-2">
              <h2 className="section-title">Topic map</h2>
              {exam.topic_status !== "building" && docs.length > 0 && !processing && (
                <ActionButton url={`/api/exams/${id}/topics`} label={topics.length ? "Rebuild" : "Build topic map"} className="btn-ghost" />
              )}
            </div>
            {exam.topic_status === "building" && (
              <p className="mt-2 text-sm text-warning">Organizing your slides into topics… this takes a minute or two.</p>
            )}
            {exam.topic_status === "error" && <p className="mt-2 text-sm text-danger">Topic map failed: {exam.topic_error}</p>}
            <ol className="mt-3 space-y-3">
              {topics.map((t) => {
                const concepts = topicConcepts(t.id, id);
                return (
                  <li key={t.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={`/exams/${id}/study?topic=${t.position}`} className="font-medium hover:underline">
                        {t.position + 1}. {t.title}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {JSON.parse(t.page_ids).length} slides
                        {t.emphasized ? <span className="ml-2 text-warning">★ emphasized</span> : null}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{t.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {concepts.map((c) => (
                        <span
                          key={c.id}
                          className={`badge ${masteryColor(c.mastery)}`}
                          title={c.earlier_exams.length ? `Also in: ${c.earlier_exams.join(", ")}` : "New for this exam"}
                        >
                          {c.name}
                          {c.mastery != null && ` · ${pct(c.mastery)}`}
                          {c.earlier_exams.length > 0 && " ↺"}
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
            {topics.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Concept colors show mastery (green ≥80%, amber ≥60%, red below, grey untested). ↺ = covered in an earlier exam.
              </p>
            )}
          </section>
        </div>

        <div className="space-y-6">
          {/* Materials */}
          <section className="card space-y-3">
            <h2 className="section-title">Lectures</h2>
            <Uploader examId={id} />
            {docs.length > 0 && (
              <ul className="divide-y divide-border text-sm">
                {docs.map((d) => (
                  <li key={d.id} className="py-2">
                    <div className="font-medium">{d.filename}</div>
                    <div className="text-muted-foreground">
                      {d.status === "done" && `${d.page_count} slides ✓`}
                      {d.status === "processing" && `Reading slides ${d.done ?? 0}/${d.page_count}…`}
                      {d.status === "pending" && "Waiting…"}
                      {d.status === "error" && (
                        <span className="text-danger">
                          {d.error} <ActionButton url={`/api/documents/${d.id}/retry`} label="Retry" className="btn-ghost px-2 py-0" />
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {totalPages > 0 && <p className="text-xs text-muted-foreground">{totalPages} slides total</p>}
          </section>

          {/* Practice */}
          <section className="card space-y-3">
            <h2 className="section-title">Practice exam</h2>
            {topics.length === 0 ? (
              <p className="text-sm text-muted-foreground">Available once the topic map is ready.</p>
            ) : (
              <PracticeForm
                examId={id}
                topics={practiceTopics}
                lectures={docs.map((d) => ({ id: d.id, name: d.filename.replace(/\.pdf$/i, "") }))}
                focusWeak={!!user.focus_weak}
              />
            )}
            {attempts.length > 0 && (
              <ul className="divide-y divide-border border-t border-border pt-2 text-sm">
                {attempts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2">
                    <Link href={`/attempts/${a.id}`} className="hover:underline">
                      {a.started_at.slice(0, 10)} · {a.n} Qs · {a.mode}
                    </Link>
                    <span className="text-muted-foreground">
                      {a.status === "finished" ? pct(a.score) : a.status === "error" ? "failed" : "in progress"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
