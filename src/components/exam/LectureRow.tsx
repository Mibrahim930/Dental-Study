import { RemoveLectureButton } from "@/components/RemoveLectureButton";
import { LectureReviewCard } from "@/components/LectureReviewCard";
import { ActionButton } from "@/components/ActionButton";
import { Icon, ICONS, MasteryChip } from "@/components/ui";
import { friendlyError } from "@/components/friendlyError";
import { lectureName } from "@/lib/lectures";
import type { DocWithProgress, ExamPageData } from "@/lib/examPage";
import { average, SectionRow } from "./SectionRow";

/** One lecture on the exam page: reading progress until it's read, then its sections (opens on the one she's on). */
export function LectureRow({ data, doc: d, no }: { data: ExamPageData; doc: DocWithProgress; no: number }) {
  const { exam, groupOf, oldStyle, processing, topics, missingSlides, studiedIds, conceptsByTopic, started, lastPosition, mapRow } = data;
  const group = groupOf.get(d.id);
  const name = lectureName(d.filename);
  const reading = d.status === "processing" || d.status === "pending";
  const status = <LectureStatus doc={d} />;
  const remove = <RemoveLectureButton docId={d.id} name={name} reading={reading} />;
  if (!group) {
    return (
      <div className="flex flex-col gap-2 rounded-[22px] bg-muted p-4">
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
                : processing
                  ? "No sections yet. It's split into sections once every lecture is read."
                  : topics.length === 0
                    ? "No sections yet. Tap “Split into sections” above."
                    : missingSlides > 0
                      ? "No sections yet. Tap “Add them” above."
                      : "No sections yet."}
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
    <details className="group rounded-[22px] bg-muted" open={here}>
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
}

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
        <span className="min-w-0 break-words">{friendlyError(doc.error, "Some slides couldn't be read. Tap Retry to try them again.")}</span>
        <ActionButton url={`/api/documents/${doc.id}/retry`} label="Retry" className="btn-secondary btn-sm shrink-0 bg-card" />
      </div>
    );
  }
  return null;
}
