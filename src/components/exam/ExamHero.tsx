import { formatDate, pct } from "@/lib/format";
import { KIND_LABEL, KIND_STYLE } from "@/lib/calendar";
import { DoubleRing } from "@/components/ui";
import type { ExamPageData } from "@/lib/examPage";

/** The exam's name, type and date, with mastery and sections studied. */
export function ExamHero({ data }: { data: ExamPageData }) {
  const { exam, topics, days, progress, lecturesWithSections, lecturesDone } = data;
  return (
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
  );
}
