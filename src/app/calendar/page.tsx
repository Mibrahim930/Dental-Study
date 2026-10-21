import Link from "next/link";
import { PlanWarnings } from "@/components/PlanWarnings";
import { headers } from "next/headers";
import { db, type Exam } from "@/lib/db";
import { requireUser } from "@/lib/user";
import { ensurePlanFresh, icsToken, plannerSettings, tasksOn, todayIn, type PlanWarning } from "@/lib/planner";
import { examsByDate, formatDay, KIND_LABEL, KIND_STYLE, MONTHS, monthWeeks, WEEKDAYS, ymd } from "@/lib/calendar";
import { TaskList } from "@/components/TaskList";
import { CalendarForms, DeleteBusyButton } from "@/components/CalendarForms";
import { CalendarSyncLink, PlannerSettingsForm } from "@/components/PlannerSettingsForm";
import { UndatedExams } from "@/components/UndatedExams";
import { Icon, ICONS } from "@/components/ui";

export const dynamic = "force-dynamic";

type Busy = { id: number; start_date: string; end_date: string; label: string };

export default async function CalendarPage(props: PageProps<"/calendar">) {
  const user = await requireUser();
  ensurePlanFresh(user.id);
  const settings = plannerSettings(user.id);
  const today = todayIn(settings.timezone);
  const q = await props.searchParams;

  // ?month=YYYY-MM shows a month; otherwise ?year=YYYY shows the whole year.
  const monthParam = typeof q.month === "string" && /^\d{4}-\d{2}$/.test(q.month) ? q.month : null;
  const year = monthParam ? Number(monthParam.slice(0, 4)) : typeof q.year === "string" ? Number(q.year) || Number(today.slice(0, 4)) : Number(today.slice(0, 4));
  const month = monthParam ? Number(monthParam.slice(5, 7)) - 1 : null;
  const selected = typeof q.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : month != null ? (today.startsWith(monthParam!) ? today : ymd(year, month, 1)) : today;

  const added = typeof q.added === "string" ? Math.min(99, Math.max(0, Math.floor(Number(q.added)) || 0)) : 0;

  const from = month != null ? ymd(year, month, 1) : `${year}-01-01`;
  const to = month != null ? ymd(year, month, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) : `${year}-12-31`;
  // Archived exams are finished with: like the planner, the calendar leaves them out.
  const exams = db.prepare("SELECT * FROM exams WHERE user_id = ? AND exam_date IS NOT NULL AND status = 'active' ORDER BY exam_date, id").all(user.id) as Exam[];
  const undated = db.prepare("SELECT * FROM exams WHERE user_id = ? AND exam_date IS NULL AND status = 'active' ORDER BY id").all(user.id) as Exam[];
  const busy = db.prepare("SELECT * FROM busy_days WHERE user_id = ? ORDER BY start_date").all(user.id) as Busy[];
  const tasks = tasksOn(user.id, from < today ? from : today, to);
  const dayTasks = tasksOn(user.id, selected, selected);
  const warnings = JSON.parse(settings.warnings) as PlanWarning[];

  const byDate = examsByDate(exams);
  const examsOn = (d: string) => byDate.get(d) ?? [];
  const busyOn = (d: string) => busy.filter((b) => d >= b.start_date && d <= b.end_date);
  const minutesOn = (d: string) => tasks.filter((t) => t.date === d).reduce((s, t) => s + t.minutes, 0);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const icsUrl = `${h.get("x-forwarded-proto") === "https" || !host.startsWith("localhost") ? "https" : "http"}://${host}/api/ics/${icsToken(user.id)}.ics`;

  const prev = month != null ? `?month=${month === 0 ? `${year - 1}-12` : `${year}-${String(month).padStart(2, "0")}`}` : `?year=${year - 1}`;
  const next = month != null ? `?month=${month === 11 ? `${year + 1}-01` : `${year}-${String(month + 2).padStart(2, "0")}`}` : `?year=${year + 1}`;
  const dayHref = (d: string) => `?month=${d.slice(0, 7)}&day=${d}`;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
      <section className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link href={prev} className="btn-ghost px-2" aria-label="Previous">←</Link>
            <h1 className="page-title">{month != null ? `${MONTHS[month]} ${year}` : year}</h1>
            <Link href={next} className="btn-ghost px-2" aria-label="Next">→</Link>
          </div>
          <div className="flex rounded-lg bg-muted p-1 text-sm">
            <Link href={`?year=${year}`} className={`rounded-md px-3 py-1 ${month == null ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}>Year</Link>
            <Link href={`?month=${month != null ? monthParam : today.slice(0, 7)}`} className={`rounded-md px-3 py-1 ${month != null ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}>Month</Link>
          </div>
        </div>

        {added > 0 && (
          <section role="status" className="tile cb-mint flex flex-col gap-1 rounded-[24px]">
            <div className="text-[17px] font-extrabold">
              Added {added} {added === 1 ? "exam" : "exams"}.
            </div>
            <p className="text-[15px] font-medium">Each exam gets its own space for lectures; upload them whenever you&apos;re ready.</p>
          </section>
        )}

        <div className="flex flex-wrap gap-2">
          <Link href="/calendar/add" className="btn-primary btn-sm">
            <Icon d={ICONS.plus} size={16} /> Add exams
          </Link>
          <Link href="/calendar/import" className="btn-secondary btn-sm">
            Paste or snap your schedule
          </Link>
        </div>

        <UndatedExams exams={undated.map((e) => ({ id: e.id, name: e.name, kindLabel: KIND_LABEL[e.kind], course: e.course }))} today={today} />

        {month == null ? (
          <div className="grid grid-cols-2 gap-2 sm:gap-4 xl:grid-cols-3">
            {MONTHS.map((name, m) => (
              <div key={name} className={`card p-2.5 sm:p-3.5 ${year === Number(today.slice(0, 4)) && m < Number(today.slice(5, 7)) - 1 ? "opacity-55" : ""}`}>
                <Link href={`?month=${year}-${String(m + 1).padStart(2, "0")}`} className="mb-2 block text-[15px] font-extrabold hover:underline">{name}</Link>
                <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-subtle">
                  {WEEKDAYS.map((w) => <div key={w}>{w[0]}</div>)}
                </div>
                {monthWeeks(year, m).map((week, i) => (
                  <div key={i} className="grid grid-cols-7 gap-0.5">
                    {week.map((d, j) => {
                      if (!d) return <div key={j} />;
                      const dayExams = examsOn(d);
                      const ex = dayExams[0];
                      const isBusy = busyOn(d).length > 0;
                      const study = minutesOn(d);
                      return (
                        <Link
                          key={j}
                          href={dayHref(d)}
                          title={[...dayExams.map((e) => e.name), ...busyOn(d).map((b) => b.label), study ? `${Math.round(study / 6) / 10}h study` : ""].filter(Boolean).join(" · ")}
                          aria-label={dayExams.length > 1 ? `${d}: ${dayExams.length} exams` : undefined}
                          className={`relative flex aspect-square items-center justify-center rounded-lg text-[11px] font-semibold ${
                            ex ? `${KIND_STYLE[ex.kind]} font-extrabold` : isBusy ? "bg-stone text-on-stone" : d < today ? "text-subtle hover:bg-muted" : "hover:bg-muted"
                          } ${d === today || d === selected ? "ring-2 ring-foreground" : ""}`}
                        >
                          {Number(d.slice(8))}
                          {study > 0 && !ex && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-hero" aria-hidden />}
                          {dayExams.length > 1 && <MoreExams n={dayExams.length - 1} />}
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="card p-3 sm:p-5">
            <div className="grid grid-cols-7 gap-1.5 pb-1.5 text-center text-[12px] font-bold text-muted-foreground">
              {WEEKDAYS.map((w) => <div key={w}>{w}</div>)}
            </div>
            {monthWeeks(year, month).map((week, i) => (
              <div key={i} className="grid grid-cols-7 gap-1.5 pb-1.5">
                {week.map((d, j) => {
                  if (!d) return <div key={j} />;
                  const study = minutesOn(d);
                  const isBusy = busyOn(d);
                  const ex = examsOn(d)[0];
                  return (
                    <Link
                      key={j}
                      href={dayHref(d)}
                      title={[...examsOn(d).map((e) => e.name), ...isBusy.map((b) => b.label), study ? `${Math.round(study / 6) / 10} h study` : ""].filter(Boolean).join(" · ")}
                      className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-[14px] p-1 text-[15px] font-bold sm:min-h-24 sm:items-start sm:justify-start sm:p-2 ${
                        ex ? KIND_STYLE[ex.kind] : isBusy.length ? "bg-stone text-on-stone" : d < today ? "bg-muted/50 text-subtle hover:bg-muted" : "bg-muted hover:bg-muted-strong"
                      } ${d === today || d === selected ? "ring-2 ring-foreground" : ""}`}
                    >
                      {Number(d.slice(8))}
                      {examsOn(d).length > 1 && <MoreExams n={examsOn(d).length - 1} className="sm:hidden" />}
                      <span className="hidden w-full flex-col gap-0.5 sm:flex">
                        {examsOn(d).map((e) => (
                          <span key={e.id} className="truncate text-[11px] font-extrabold">{e.name}</span>
                        ))}
                        {isBusy.map((b) => (
                          <span key={b.id} className="truncate text-[11px] font-semibold">{b.label}</span>
                        ))}
                        {study > 0 && <span className={`text-[11px] font-bold ${ex ? "opacity-80" : "text-primary"}`}>{Math.round(study / 6) / 10} h study</span>}
                      </span>
                      {study > 0 && !ex && <span className="h-1.5 w-1.5 rounded-full bg-hero sm:hidden" aria-hidden />}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
            <span key={k} className="flex items-center gap-1"><span className={`h-3 w-3 rounded ${KIND_STYLE[k]}`} />{KIND_LABEL[k]}</span>
          ))}
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-stone" />Busy</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-hero" />Study planned</span>
        </div>
      </section>

      <aside className="space-y-4">
        <section className="card space-y-3">
          <h2 className="section-title">{formatDay(selected)}</h2>
          {examsOn(selected).map((e) => (
            <Link key={e.id} href={`/exams/${e.id}`} className={`block rounded-[20px] px-4 py-3 text-[15px] font-extrabold ${KIND_STYLE[e.kind]}`}>
              {KIND_LABEL[e.kind]}: {e.name} →
            </Link>
          ))}
          {busyOn(selected).map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-[20px] bg-stone px-4 py-3 text-[15px] font-semibold text-on-stone">
              <span>{b.label}{b.start_date !== b.end_date ? ` (${b.start_date.slice(5)} to ${b.end_date.slice(5)})` : ""}</span>
              <DeleteBusyButton id={b.id} />
            </div>
          ))}
          <TaskList tasks={dayTasks} empty={selected < today ? "No study tasks this day." : "No study planned this day."} />
          <CalendarForms date={selected >= today ? selected : today} />
        </section>

        <PlanWarnings warnings={warnings} />

        <section id="planner" className="card scroll-mt-4 space-y-3">
          <h2 className="section-title">Study planner</h2>
          <p className="text-sm text-muted-foreground">
            Your plan spreads each exam&apos;s topics, practice quizzes and review across the days before it, works around busy days, and
            updates automatically when things change.
          </p>
          <PlannerSettingsForm weekdayMinutes={JSON.parse(settings.weekday_minutes)} reviewMinutes={settings.review_minutes} />
        </section>

        <section className="card space-y-2">
          <h2 className="font-semibold tracking-tight">Sync to your phone&apos;s calendar</h2>
          <p className="text-sm text-muted-foreground">
            Add this link as a subscribed calendar. In Google Calendar: Other calendars → + → From URL. On iPhone: Settings → Calendar →
            Accounts → Add Subscribed Calendar. Your exams and daily study plan will show up and stay updated.
          </p>
          <CalendarSyncLink url={icsUrl} />
        </section>
      </aside>
    </div>
  );
}

/** "+1" in the corner of a day with more than one exam (the cell's colour is the first exam's). */
function MoreExams({ n, className = "" }: { n: number; className?: string }) {
  return (
    <span
      className={`absolute top-0 right-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 text-[8px] leading-none font-extrabold text-background ${className}`}
      aria-hidden
    >
      +{n}
    </span>
  );
}
