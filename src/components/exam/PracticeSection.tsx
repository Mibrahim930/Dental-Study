import Link from "next/link";
import { sinceText } from "@/lib/format";
import { PracticeForm } from "@/components/PracticeForm";
import { Icon, ICONS, MasteryChip } from "@/components/ui";
import type { ExamPageData } from "@/lib/examPage";

/** Practice exams: the one she stepped away from, the form for a new one, and past attempts. */
export function PracticeSection({ data, focusWeak }: { data: ExamPageData; focusWeak: boolean }) {
  const { exam, topics, practiceTopics, docs, openAttempt, attempts } = data;
  const id = exam.id;
  return (
    <section className="card flex flex-col gap-4">
      <h2 className="section-title">Practice exam</h2>
      {openAttempt && <OpenAttempt data={data} openAttempt={openAttempt} />}
      {topics.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">Available once your lectures are split into sections.</p>
      ) : (
        <PracticeForm
          examId={id}
          topics={practiceTopics}
          lectures={docs.map((d) => ({ id: d.id, name: d.filename.replace(/\.pdf$/i, "") }))}
          focusWeak={focusWeak}
        />
      )}
      {attempts.length > 0 && <PastAttempts data={data} />}
    </section>
  );
}

/** A practice exam in progress: Continue, or see the score once its time is up. */
function OpenAttempt({ data, openAttempt }: { data: ExamPageData; openAttempt: NonNullable<ExamPageData["openAttempt"]> }) {
  const { openExpired } = data;
  return (
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
  );
}

/** The last few practice exams, with their scores. */
function PastAttempts({ data }: { data: ExamPageData }) {
  const { attempts, tz } = data;
  return (
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
