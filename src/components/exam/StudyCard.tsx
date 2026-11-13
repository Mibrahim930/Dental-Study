import Link from "next/link";
import { Icon, ICONS } from "@/components/ui";
import type { ExamPageData } from "@/lib/examPage";

/** Where she left off, Continue / Start over, and her session notes. */
export function StudyCard({ data }: { data: ExamPageData }) {
  const { exam, topics, started, currentPlace, lastPosition, lecturesWithSections, current, notes } = data;
  const id = exam.id;
  return (
    <section className="card-hero flex flex-col gap-4">
      {topics.length === 0 ? (
        <>
          <h2 className="section-title">Study</h2>
          <p className="text-[15px] text-hero-muted">
            Upload this exam&apos;s lectures. Once they&apos;re read, they&apos;re split into sections and you can start studying.
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
  );
}
