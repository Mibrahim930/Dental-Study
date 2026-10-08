import Link from "next/link";
import { db, type Exam } from "@/lib/db";
import { countDue } from "@/lib/practice";
import { weakConcepts } from "@/lib/memory";
import { daysUntil, formatDate, pct } from "@/lib/format";
import { createExam } from "./actions";
import { requireUser } from "@/lib/user";
import { addDays, ensurePlanFresh, plannerSettings, tasksOn, todayIn, type PlanWarning } from "@/lib/planner";
import { KIND_LABEL, KIND_STYLE } from "@/lib/calendar";
import { TaskList } from "@/components/TaskList";

export const dynamic = "force-dynamic";

type ExamWithCounts = Exam & { docs: number; pages: number; done_pages: number };

export default async function Home() {
  const user = await requireUser();
  const exams = db
    .prepare(
      `SELECT e.*, COUNT(DISTINCT d.id) docs, COUNT(p.id) pages, SUM(p.status = 'done') done_pages
       FROM exams e LEFT JOIN documents d ON d.exam_id = e.id LEFT JOIN pages p ON p.document_id = d.id
       WHERE e.user_id = ?
       GROUP BY e.id ORDER BY COALESCE(e.exam_date, '9999') ASC, e.id DESC`,
    )
    .all(user.id) as ExamWithCounts[];
  const isPast = (e: Exam) => e.status === "archived" || (daysUntil(e.exam_date) ?? 0) < 0;
  const upcoming = exams.filter((e) => !isPast(e));
  const past = exams.filter(isPast);
  ensurePlanFresh(user.id);
  const settings = plannerSettings(user.id);
  const today = todayIn(settings.timezone);
  const todayTasks = tasksOn(user.id, today, today);
  const week = tasksOn(user.id, addDays(today, 1), addDays(today, 6));
  const warnings = JSON.parse(settings.warnings) as PlanWarning[];
  const due = countDue(user.id);
  const weak = weakConcepts(user.id, 6);

  const doneToday = todayTasks.filter((t) => t.status === "done").length;
  const minutesToday = todayTasks.reduce((s, t) => s + t.minutes, 0);
  const next = upcoming.find((e) => e.exam_date);
  const nextDays = next ? daysUntil(next.exam_date) : null;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm text-muted-foreground">{longDate(today)}</p>
        <h1 className="page-title">{greeting(settings.timezone)}</h1>
      </header>

      {exams.length === 0 ? (
        <Welcome />
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Stat
            href="/review"
            label="Daily review"
            value={due === 0 ? "All caught up" : `${due} due`}
            hint={due === 0 ? "Nothing to review right now" : "Questions you missed, spaced out"}
            highlight={due > 0}
          />
          <Stat
            href={next ? `/exams/${next.id}` : "/calendar"}
            label="Next exam"
            value={next ? (nextDays === 0 ? "Today" : `${nextDays} day${nextDays === 1 ? "" : "s"}`) : "None set"}
            hint={next ? next.name : "Add a date to an exam to plan for it"}
          />
          <Stat
            href="/calendar"
            label="Today's plan"
            value={todayTasks.length ? `${doneToday}/${todayTasks.length} done` : "Free day"}
            hint={todayTasks.length ? `${minutesToday} min planned` : "Nothing scheduled today"}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <section className="min-w-0 space-y-4">
          {upcoming.length > 0 && (
            <div className="card space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="section-title">Today&apos;s plan</h2>
                {todayTasks.length > 0 && (
                  <span className="text-sm text-muted-foreground">
                    {doneToday}/{todayTasks.length} done · {minutesToday} min
                  </span>
                )}
              </div>
              {todayTasks.length > 0 && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(doneToday / todayTasks.length) * 100}%` }} />
                </div>
              )}
              <TaskList tasks={todayTasks} empty="Nothing planned today. Enjoy the break, or get ahead from the calendar." />
              {warnings.map((w) => (
                <p key={w.examId} className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
                  ⚠ Not enough study time before {w.examName} (about {Math.ceil(w.minutesShort / 60)}h short).{" "}
                  <Link href="/calendar" className="font-medium underline">Adjust your plan</Link>
                </p>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm text-muted-foreground">
                <span>Next 6 days: {Math.round(week.reduce((s, t) => s + t.minutes, 0) / 6) / 10} hours planned</span>
                <Link href="/calendar" className="font-medium text-primary hover:underline">Open calendar →</Link>
              </div>
            </div>
          )}

          <h2 className="section-title pt-2">Your exams</h2>
          {upcoming.length === 0 && exams.length > 0 && (
            <div className="card text-sm text-muted-foreground">No upcoming exams. Create one to start uploading lectures.</div>
          )}
          {upcoming.map((e) => (
            <ExamCard key={e.id} exam={e} />
          ))}
          {past.length > 0 && (
            <details className="group pt-2">
              <summary className="cursor-pointer list-none text-sm font-medium text-muted-foreground hover:text-foreground">
                <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
                Past exams ({past.length})
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">Their lectures, scores and review cards stay in memory and feed into new exams.</p>
              <div className="mt-3 space-y-4">
                {past.map((e) => (
                  <ExamCard key={e.id} exam={e} />
                ))}
              </div>
            </details>
          )}
        </section>

        <aside className="space-y-4">
          <form action={createExam} className="card space-y-3">
            <h2 className="section-title">New exam</h2>
            <div>
              <label className="label" htmlFor="name">Exam name</label>
              <input id="name" name="name" className="input" placeholder="Endo Block Exam" required />
            </div>
            <div>
              <label className="label" htmlFor="course">Course (optional)</label>
              <input id="course" name="course" className="input" placeholder="Endodontics D2" />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
              <div>
                <label className="label" htmlFor="exam_date">Exam date</label>
                <input id="exam_date" name="exam_date" type="date" className="input" />
              </div>
              <div>
                <label className="label" htmlFor="kind">Type</label>
                <select id="kind" name="kind" className="input" defaultValue="block">
                  <option value="block">Block exam</option>
                  <option value="quiz">Quiz</option>
                  <option value="practical">Practical</option>
                  <option value="board">Board exam (e.g. INBDE)</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
            <button className="btn-primary w-full">Create exam</button>
          </form>

          {weak.length > 0 && (
            <div className="card">
              <h2 className="section-title mb-3">Weakest concepts</h2>
              <ul className="space-y-2.5 text-sm">
                {weak.map((c) => (
                  <li key={c.id}>
                    <div className="flex justify-between gap-2">
                      <span className="min-w-0 truncate">{c.name}</span>
                      <span className="shrink-0 font-medium text-danger">{pct(c.mastery)}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className="h-full rounded-full bg-danger" style={{ width: `${Math.max(4, (c.mastery ?? 0) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function greeting(timezone: string): string {
  let hour = new Date().getHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  } catch {}
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function longDate(ymd: string): string {
  return new Date(ymd + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function Stat({ href, label, value, hint, highlight }: { href: string; label: string; value: string; hint: string; highlight?: boolean }) {
  return (
    <Link href={href} className={`card block min-w-0 p-3 sm:p-4 ${highlight ? "border-primary/40 bg-primary-soft" : ""}`}>
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:text-xs">{label}</div>
      <div className={`mt-1 text-base leading-tight font-semibold tracking-tight sm:text-2xl ${highlight ? "text-primary" : ""}`}>{value}</div>
      <div className="mt-0.5 hidden truncate text-sm text-muted-foreground sm:block">{hint}</div>
    </Link>
  );
}

function Welcome() {
  const steps = [
    ["Create an exam", "Give it a name and a date using the New exam form."],
    ["Upload lecture PDFs", "AI reads every slide, including X-rays and handwriting."],
    ["Study and practise", "Guided lessons, a tutor chat, practice exams and daily review."],
  ];
  return (
    <div className="card border-primary/30 bg-primary-soft">
      <h2 className="section-title">Welcome to Lolo&apos;s Study Buddy</h2>
      <p className="mt-1 text-sm text-muted-foreground">Three steps to get going:</p>
      <ol className="mt-4 grid gap-4 sm:grid-cols-3">
        {steps.map(([title, text], i) => (
          <li key={title} className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              {i + 1}
            </span>
            <div>
              <div className="font-medium">{title}</div>
              <div className="text-sm text-muted-foreground">{text}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ExamCard({ exam }: { exam: ExamWithCounts }) {
  const days = daysUntil(exam.exam_date);
  const processing = exam.pages > 0 && exam.done_pages < exam.pages;
  return (
    <Link href={`/exams/${exam.id}`} className="card block">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${KIND_STYLE[exam.kind]}`} aria-hidden />
            <span className="truncate text-lg font-semibold tracking-tight">{exam.name}</span>
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            {KIND_LABEL[exam.kind]} · {exam.course ? `${exam.course} · ` : ""}
            {formatDate(exam.exam_date)}
          </div>
        </div>
        {days != null && days >= 0 && (
          <span className={`badge ${days <= 7 ? "bg-warning-soft text-warning" : "bg-primary-soft text-primary"}`}>
            {days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"} left`}
          </span>
        )}
      </div>
      <div className="mt-3 text-sm text-muted-foreground">
        {exam.docs} lecture{exam.docs === 1 ? "" : "s"} · {exam.pages} slides
      </div>
      {processing && (
        <div className="mt-2">
          <div className="flex justify-between text-xs text-warning">
            <span>Reading slides…</span>
            <span>
              {exam.done_pages}/{exam.pages}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-warning" style={{ width: `${(exam.done_pages / exam.pages) * 100}%` }} />
          </div>
        </div>
      )}
    </Link>
  );
}
