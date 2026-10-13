import Link from "next/link";
import type { PlanWarning } from "@/lib/planner";

const hours = (min: number) => (min >= 90 ? `${Math.round(min / 30) / 2} hours` : `${min} minutes`);

/** A calm note when not everything fits before an exam: what the plan covers, and one small way to cover the rest. */
export function PlanWarnings({ warnings }: { warnings: PlanWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <>
      {warnings.map((w) => {
        const hasStarred = (w.starredTotal ?? 0) > 0;
        const starredIn = hasStarred && w.starredLeft === 0;
        return (
          <section key={w.examId} className="tile cb-butter flex flex-col gap-2 rounded-[24px]">
            <div className="text-[17px] font-extrabold">Tight on time for {w.examName}, and that&apos;s okay.</div>
            <p className="text-[15px] leading-relaxed font-medium">
              {starredIn
                ? "Your plan covers the ★ topics your professor stressed first, so the most important material is in. "
                : hasStarred
                  ? "Your plan puts the ★ topics your professor stressed first. "
                  : "Your plan fits in as much as your study time allows. "}
              {w.topicsLeft
                ? `${w.topicsLeft} ${w.topicsLeft === 1 ? "topic" : "topics"} didn't fit${w.perDay ? `; about ${w.perDay} extra minutes a day would cover ${w.topicsLeft === 1 ? "it" : "them"}` : ""}.`
                : `About ${hours(w.minutesShort)} of practice didn't fit.`}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Link href="/calendar#planner" className="btn-primary btn-sm">Add study time</Link>
              {starredIn && <span className="text-[13px] font-semibold opacity-80">Even without it, you&apos;ll go in knowing the big things.</span>}
            </div>
          </section>
        );
      })}
    </>
  );
}
