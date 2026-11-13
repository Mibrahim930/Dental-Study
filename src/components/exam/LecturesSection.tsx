import { ActionButton } from "@/components/ActionButton";
import { Uploader } from "@/components/Uploader";
import { friendlyError } from "@/components/friendlyError";
import type { ExamPageData } from "@/lib/examPage";
import { LectureRow } from "./LectureRow";
import { OldStyleTopics } from "./OldStyleTopics";

/** Asked before "Re-split every lecture": it bills her key and can reset lessons and quizzes she already has. */
const RESPLIT_CONFIRM =
  "Re-split every lecture into new sections?\n\nThis uses your AI key and takes a few minutes. Sections whose slides change get a new lesson and a new quiz, and your quiz answers in those sections start over.";

/** Lectures: upload, then each lecture's sections (its topic map), with progress. */
export function LecturesSection({ data }: { data: ExamPageData }) {
  const { exam, docs, topics, totalPages, processing, reorganising, contentSlides, missingSlides, fillerSlides, oldStyle } = data;
  const id = exam.id;
  return (
    <section className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">Lectures</h2>
        <div className="flex items-center gap-2">
          {totalPages > 0 && <span className="eyebrow">{totalPages} slides</span>}
          {exam.topic_status !== "building" && docs.length > 0 && !processing &&
            (topics.length ? (
              <ActionButton url={`/api/exams/${id}/topics`} body={{ mode: "full" }} confirm={RESPLIT_CONFIRM} label="Re-split every lecture" className="btn-secondary btn-sm" />
            ) : (
              <ActionButton url={`/api/exams/${id}/topics`} body={{ mode: "auto" }} label="Split into sections" className="btn-secondary btn-sm" />
            ))}
        </div>
      </div>
      {exam.topic_status === "building" && (
        <p className="rounded-2xl bg-butter px-4 py-3 text-sm font-semibold text-on-butter">
          {reorganising
            ? "Reorganising your topics by lecture… this takes a minute or two. You can keep studying meanwhile."
            : "Splitting your lectures into sections… this takes a minute or two."}
        </p>
      )}
      {exam.topic_status === "error" && (
        <p className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
          Couldn&apos;t split your lectures into sections. {friendlyError(exam.topic_error, "Try again in a minute.")}
        </p>
      )}
      {topics.length > 0 && exam.topic_status !== "building" && contentSlides > 0 && (
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] font-semibold ${missingSlides ? "rounded-2xl bg-butter px-4 py-3 text-on-butter" : "text-muted-foreground"}`}
        >
          <p className="min-w-0 flex-1">
            {missingSlides ? `${missingSlides} of ${contentSlides} slides aren't in a section yet.` : `All ${contentSlides} slides are in your study plan.`}
            {fillerSlides > 0 && ` ${fillerSlides} title or agenda slide${fillerSlides === 1 ? " was" : "s were"} left out.`}
          </p>
          {/* Places only the missing slides (no AI for lectures that already have sections; nothing she has is reset). */}
          {missingSlides > 0 && !processing && (
            <ActionButton url={`/api/exams/${id}/topics`} body={{ mode: "auto" }} label="Add them" className="btn-primary btn-sm shrink-0" />
          )}
        </div>
      )}
      <Uploader examId={id} />
      {docs.map((d, i) => (
        <LectureRow key={d.id} data={data} doc={d} no={i + 1} />
      ))}
      {oldStyle && <OldStyleTopics data={data} oldStyle={oldStyle} />}
      {topics.length > 0 && (
        <div className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span>How well you know a section:</span>
            <span className="flex items-center gap-1.5">
              <span className="chip cb-mint">80%+</span> well
            </span>
            <span className="flex items-center gap-1.5">
              <span className="chip cb-butter">60–79%</span> getting there
            </span>
            <span className="flex items-center gap-1.5">
              <span className="chip cb-coral">under 60%</span> needs work
            </span>
            <span className="flex items-center gap-1.5">
              <span className="chip bg-muted text-muted-foreground">New</span> not tested yet
            </span>
          </p>
          <p>★ you emphasized in your notes. ↺ covered in an earlier exam. ✓ studied.</p>
        </div>
      )}
    </section>
  );
}
