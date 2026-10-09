import Link from "next/link";
import { db, type Exam } from "@/lib/db";
import { countDue } from "@/lib/practice";
import { weakConcepts } from "@/lib/memory";
import { daysUntil, formatDate } from "@/lib/format";
import { createExam } from "./actions";
import { requireUser } from "@/lib/user";
import { ensurePlanFresh, plannerSettings, tasksOn, todayIn, type PlanWarning } from "@/lib/planner";
import { KIND_LABEL, KIND_STYLE } from "@/lib/calendar";
import { examProgress, firstName } from "@/lib/readiness";
import { StartTaskButton, TaskList, type TaskItem } from "@/components/TaskList";
import { DoubleRing, Icon, ICONS, MasteryChip, RingLegend, Strip } from "@/components/ui";

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
  const todayTasks = tasksOn(user.id, today, today) as TaskItem[];
  const warnings = JSON.parse(settings.warnings) as PlanWarning[];
  const due = countDue(user.id);
  const weak = weakConcepts(user.id, 6);

  const doneToday = todayTasks.filter((t) => t.status === "done").length;
  const minutesLeft = todayTasks.filter((t) => t.status === "todo").reduce((s, t) => s + t.minutes, 0);
  const nextTask = todayTasks.find((t) => t.status === "todo");
  const next = upcoming.find((e) => e.exam_date);
  const nextDays = next ? daysUntil(next.exam_date) : null;
  const progress = next ? examProgress(user.id, next.id) : null;
  const name = firstName(user.email);
  const hello = `${greeting(settings.timezone)}${name ? ` ${name}` : ""},`;

  return (
    <div className="flex flex-col gap-2.5 sm:gap-4">
      {exams.length === 0 ? (
        <Welcome hello={hello} />
      ) : (
        <div className="grid gap-2.5 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* Hero: the one next thing to do. */}
          <section className="card-hero flex flex-col gap-5">
            <h1 className="text-[38px] leading-[0.98] font-extrabold tracking-[-0.035em] sm:text-[54px]">
              {hello}
              <br />
              <span className="text-hero-accent">{heroLine(todayTasks, nextTask)}</span>
            </h1>
            {next && progress && (
              <div className="flex items-center gap-[18px]">
                <DoubleRing
                  outer={progress.readiness}
                  inner={todayTasks.length ? doneToday / todayTasks.length : null}
                  center={`${Math.round(progress.readiness * 100)}%`}
                  label={`${next.name} readiness ${Math.round(progress.readiness * 100)} percent${todayTasks.length ? `, today's plan ${doneToday} of ${todayTasks.length} done` : ""}`}
                />
                <RingLegend
                  items={[
                    { color: "var(--hero-accent)", label: `${next.name} readiness`, value: `${Math.round(progress.readiness * 100)}% ready` },
                    ...(todayTasks.length ? [{ color: "var(--hero-accent-2)", label: "Today's plan", value: `${doneToday} of ${todayTasks.length} done` }] : []),
                  ]}
                />
              </div>
            )}
            {nextTask ? (
              <StartTaskButton taskId={nextTask.id} label={`Continue · ${taskShort(nextTask)}`} />
            ) : (
              <Link href="/calendar" className="btn-hero btn-lg w-full text-[17px]">
                Open the calendar <Icon d={ICONS.arrowRight} />
              </Link>
            )}
          </section>

          {/* Three tiles: reviews, next exam, today's plan. Stacked beside the hero on desktop. */}
          <div className="grid grid-cols-3 gap-2.5 lg:grid-cols-1 lg:gap-4">
            <Link href="/review" className="tile cb-butter flex h-28 flex-col justify-between px-3.5 py-4 lg:h-auto lg:flex-1 lg:p-5">
              <span className="text-[13px] font-bold">Reviews due</span>
              <span className="big-number">{due}</span>
            </Link>
            {next ? (
              <Link href={`/exams/${next.id}`} className={`tile ${KIND_STYLE[next.kind]} flex h-28 flex-col justify-between px-3.5 py-4 lg:h-auto lg:flex-1 lg:p-5`}>
                <span className="truncate text-[13px] font-bold">{next.name}</span>
                <span className="big-number">
                  {nextDays}
                  <span className="text-lg tracking-normal"> {nextDays === 1 ? "day" : "days"}</span>
                </span>
              </Link>
            ) : (
              <Link href="/calendar" className="tile cb-stone flex h-28 flex-col justify-between px-3.5 py-4 lg:h-auto lg:flex-1 lg:p-5">
                <span className="text-[13px] font-bold">Next exam</span>
                <span className="text-lg font-extrabold">Add a date</span>
              </Link>
            )}
            <Link href="/calendar" className="tile cb-lilac flex h-28 flex-col justify-between px-3.5 py-4 lg:h-auto lg:flex-1 lg:p-5">
              <span className="text-[13px] font-bold">Today&apos;s plan</span>
              <span className="big-number">
                {doneToday}
                <span className="text-[22px] opacity-60">/{todayTasks.length}</span>
              </span>
            </Link>
          </div>
        </div>
      )}

      <div className="grid gap-2.5 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          {upcoming.length > 0 && (
            <>
              {todayTasks.length > 0 && doneToday === todayTasks.length && (
                <section className="tile cb-butter flex flex-wrap items-center justify-between gap-3 rounded-[28px]">
                  <div>
                    <div className="text-[22px] font-extrabold tracking-tight">That&apos;s the whole plan.</div>
                    <div className="text-[15px] font-medium">Everything for today is done. Rest, or get ahead.</div>
                  </div>
                  <Link href="/calendar" className="btn-primary btn-sm">Get ahead</Link>
                </section>
              )}
              <section className="card pb-3">
                <div className="flex items-center justify-between gap-2 px-1 pb-2.5">
                  <h2 className="section-title">Today</h2>
                  {minutesLeft > 0 && <span className="chip bg-muted text-foreground">{formatMinutes(minutesLeft)} left</span>}
                </div>
                <Strip total={todayTasks.length} filled={doneToday} className="px-1 pb-2" />
                <TaskList tasks={todayTasks} empty="Nothing planned today. Enjoy the break, or get ahead from the calendar." />
                {warnings.map((w) => (
                  <p key={w.examId} className="mt-2 rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
                    Not enough study time before {w.examName} (about {Math.ceil(w.minutesShort / 60)} h short).{" "}
                    <Link href="/calendar" className="underline">Adjust your plan</Link>
                  </p>
                ))}
              </section>
            </>
          )}

          <div className="flex items-center justify-between px-1.5 pt-3">
            <h2 className="section-title">Exams</h2>
            <a href="#new-exam" className="btn-primary btn-sm lg:hidden">
              <Icon d={ICONS.plus} size={16} /> New exam
            </a>
          </div>
          {upcoming.length === 0 && exams.length > 0 && (
            <div className="card text-[15px] text-muted-foreground">No upcoming exams. Create one to start uploading lectures.</div>
          )}
          {upcoming.map((e) => (
            <ExamBlock key={e.id} exam={e} />
          ))}
          {past.length > 0 && (
            <details className="group">
              <summary className="flex h-[52px] cursor-pointer list-none items-center justify-center rounded-[22px] border-2 border-dashed border-muted-strong text-[15px] font-bold text-muted-foreground hover:text-foreground">
                Past exams · {past.length}
              </summary>
              <p className="px-2 pt-3 text-sm text-muted-foreground">Their lectures, scores and review cards stay in memory and feed into new exams.</p>
              <div className="mt-2.5 flex flex-col gap-2.5 opacity-80">
                {past.map((e) => (
                  <ExamBlock key={e.id} exam={e} />
                ))}
              </div>
            </details>
          )}
        </div>

        <aside className="flex flex-col gap-2.5 sm:gap-4">
          <form action={createExam} id="new-exam" className="card flex scroll-mt-4 flex-col gap-3">
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
            <button className="btn-primary btn-lg w-full">Create exam</button>
          </form>

          {weak.length > 0 && (
            <section className="card flex flex-col gap-3.5">
              <h2 className="text-[22px] font-extrabold tracking-[-0.02em]">Your tricky ones</h2>
              {weak.map((c) => (
                <div key={c.id} className="flex items-center gap-3">
                  <MasteryChip value={c.mastery} className="h-[34px] min-w-[58px] justify-center rounded-xl text-[15px]" />
                  <span className="text-[15px] leading-snug font-medium">{c.name}</span>
                </div>
              ))}
            </section>
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
  return hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
}

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** Short name for a plan task, e.g. "Study: Periapical lesions" → "Periapical lesions". */
function taskShort(t: TaskItem): string {
  if (t.kind === "learn") return t.title.replace(/^Study:\s*/i, "");
  if (t.kind === "review") return "Daily review";
  if (t.kind === "upload") return "Upload lectures";
  if (t.kind === "final_practice") return "Final practice exam";
  if (t.kind === "weak_review") return "Weak spots";
  return "Practice quiz";
}

function heroLine(tasks: TaskItem[], next: TaskItem | undefined): string {
  if (tasks.length === 0) return "nothing planned today.";
  if (!next) return "that's the whole plan.";
  if (next.kind === "learn") return `let's study ${taskShort(next)}.`;
  if (next.kind === "review") return "let's clear your reviews.";
  if (next.kind === "upload") return "let's add your lectures.";
  return "time for some practice.";
}

function Welcome({ hello }: { hello: string }) {
  const steps = [
    ["Create an exam", "Give it a name and a date with the New exam form."],
    ["Upload lecture PDFs", "AI reads every slide, including X-rays and handwriting."],
    ["Study and practise", "Guided lessons, a tutor chat, practice exams and daily review."],
  ];
  return (
    <section className="card-hero flex flex-col gap-5">
      <h1 className="text-[38px] leading-[0.98] font-extrabold tracking-[-0.035em] sm:text-[54px]">
        {hello}
        <br />
        <span className="text-hero-accent">welcome to your study buddy.</span>
      </h1>
      <ol className="grid gap-2.5 sm:grid-cols-3">
        {steps.map(([title, text], i) => (
          <li key={title} className={`flex gap-3 rounded-[22px] p-4 ${i === 0 ? "bg-mint text-on-mint" : "bg-white/10"}`}>
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-sm font-extrabold ${i === 0 ? "bg-hero text-hero-foreground" : "bg-white/15"}`}>
              {i + 1}
            </span>
            <div>
              <div className="font-bold">{title}</div>
              <div className={`text-sm ${i === 0 ? "" : "text-hero-muted"}`}>{text}</div>
            </div>
          </li>
        ))}
      </ol>
      <a href="#new-exam" className="btn-hero btn-lg w-full text-[17px]">
        Create my first exam <Icon d={ICONS.arrowRight} />
      </a>
    </section>
  );
}

function ExamBlock({ exam }: { exam: ExamWithCounts }) {
  const days = daysUntil(exam.exam_date);
  const processing = exam.pages > 0 && exam.done_pages < exam.pages;
  return (
    <Link href={`/exams/${exam.id}`} className={`flex flex-col gap-3.5 rounded-[28px] px-[22px] py-5 transition-transform active:scale-[.99] ${KIND_STYLE[exam.kind]}`}>
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[13px] font-bold opacity-75">
            {KIND_LABEL[exam.kind]}
            {exam.course ? ` · ${exam.course}` : ""}
          </span>
          <span className="text-[22px] leading-[1.05] font-extrabold tracking-[-0.02em]">{exam.name}</span>
          <span className="text-[13px] font-semibold opacity-75">
            {formatDate(exam.exam_date)} · {exam.docs} lecture{exam.docs === 1 ? "" : "s"} · {exam.pages} slides
          </span>
        </div>
        {days != null && days >= 0 && (
          <div className="flex shrink-0 flex-col items-end leading-[0.9]">
            <span className="text-[48px] font-extrabold tracking-[-0.05em]">{days}</span>
            <span className="text-xs font-bold">{days === 0 ? "today!" : days === 1 ? "day left" : "days left"}</span>
          </div>
        )}
      </div>
      {processing && (
        <div className="flex items-center gap-2.5">
          <div className="h-2 flex-1 rounded-full bg-black/10">
            <div className="h-full rounded-full bg-current" style={{ width: `${(exam.done_pages / exam.pages) * 100}%` }} />
          </div>
          <span className="text-xs font-bold">
            Reading slides {exam.done_pages}/{exam.pages}
          </span>
        </div>
      )}
    </Link>
  );
}
