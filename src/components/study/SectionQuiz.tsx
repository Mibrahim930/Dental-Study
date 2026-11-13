"use client";
import { QuestionCard } from "../QuestionCard";
import { ReportQuestion } from "../ReportQuestion";
import { LectureReviewCard } from "../LectureReviewCard";
import { RegenerateQuiz } from "./RegenerateQuiz";
import { useSectionQuiz } from "./useSectionQuiz";

/**
 * End-of-section quiz: one question at a time, with a way to skip ahead or stop and see the score at any point.
 * `index` counts the questions shown (reported ones are skipped); answers are keyed by the question's place in the quiz.
 */
export function SectionQuiz({
  sessionId,
  position,
  isLast,
  label,
  nextLabel,
  onNext,
  lectureReview,
}: {
  sessionId: number;
  position: number;
  isLast: boolean;
  /** "Section 3" (or "Topic 3" on an old-style map), for the score line. */
  label: string;
  /** "Next section →", "Next lecture →" on a lecture's last section, "Finish session" on the very last. */
  nextLabel: string;
  onNext: () => void;
  /** Set on a lecture's last section: the end-of-lecture review card goes under the score. */
  lectureReview: { examId: number; documentId: number; lecture: string } | null;
}) {
  const { quiz, answers, picked, setPicked, index, error, saveError, rewriting, retaking, box, heading, shown, total, right, done, check, goTo, report, retake, retry, regenerateProps } =
    useSectionQuiz(sessionId, position);

  const skipLabel = isLast ? "Skip & finish session" : nextLabel === "Next lecture →" ? "Skip to next lecture →" : "Skip to next section →";
  const skip = (
    <button className="btn-ghost px-1" onClick={onNext}>
      {skipLabel}
    </button>
  );

  if (error) {
    return (
      <section className="tile cb-coral flex flex-col gap-3 rounded-[28px]">
        <div>
          <div className="text-[17px] font-extrabold">Couldn&apos;t write the quiz for this section right now.</div>
          <div className="mt-1 text-[13px] font-medium opacity-80">{error}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary btn-sm" onClick={retry}>Try again</button>
          <button className="btn-ghost btn-sm text-on-coral" onClick={onNext}>
            {skipLabel}
          </button>
        </div>
      </section>
    );
  }
  if (!quiz) {
    return (
      <section className="card flex flex-col gap-3" aria-busy>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[15px] font-semibold text-muted-foreground">
            Writing this section&apos;s quiz (one question per fact on its slides) and checking it against the slides… about 1–2 minutes. Keep reading; it&apos;ll appear here.
          </span>
          {skip}
        </div>
        <div className="shimmer h-5 w-3/4" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
      </section>
    );
  }

  // The dots stay thin, but each is a 44 px tall tap target (the negative margin keeps the spacing close to before).
  const strip = (
    <div className="-my-3.5 grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, total)}, minmax(0, 1fr))` }}>
      {shown.map(({ q, at }, i) => (
        <button
          key={q.id ?? at}
          type="button"
          onClick={() => goTo(i)}
          aria-label={`Question ${i + 1}${answers[at] == null ? "" : answers[at] === q.correct_index ? ", right" : ", wrong"}`}
          aria-current={i === index ? "step" : undefined}
          className="flex h-11 items-center"
        >
          <span
            aria-hidden
            className={`h-1.5 w-full rounded-full ${
              answers[at] == null ? (i === index ? "bg-foreground" : "bg-muted-strong") : answers[at] === q.correct_index ? "bg-hero" : "bg-coral"
            }`}
          />
        </button>
      ))}
    </div>
  );

  // Finished (or stopped early): score and what to look at again.
  if (index >= total) {
    const missed = shown.filter((x) => answers[x.at] != null && answers[x.at] !== x.q.correct_index).map((x) => x.q);
    const good = done > 0 && right / done >= 0.8;
    return (
      <section ref={box} className={`tile scroll-mt-3 flex flex-col gap-4 rounded-[28px] ${good ? "cb-mint" : "bg-card"}`}>
        {strip}
        <div>
          <div ref={heading} tabIndex={-1} className="text-[13px] font-bold opacity-75 outline-none">Section quiz</div>
          <div className="text-[30px] leading-tight font-extrabold tracking-[-0.03em]">
            {good ? `${label}, done.` : done === 0 ? "No questions answered." : "Worth another look."}
          </div>
          {done > 0 && (
            <div className="mt-1 text-[17px] font-bold">
              {Math.round((right / done) * 100)}% · {right}/{done} right{done < total && <span className="font-medium opacity-75"> · {total - done} skipped</span>}
            </div>
          )}
        </div>
        {missed.length > 0 && (
          <div>
            <div className="mb-1.5 text-[13px] font-bold opacity-75">Look again at</div>
            <div className="flex flex-wrap gap-1.5">
              {[...new Set(missed.map((q) => q.concept))].map((c) => (
                <span key={c} className="chip cb-coral">{c}</span>
              ))}
            </div>
          </div>
        )}
        {lectureReview && <LectureReviewCard examId={lectureReview.examId} documentId={lectureReview.documentId} lecture={lectureReview.lecture} />}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            <button className="btn-secondary btn-lg" onClick={() => goTo(0)}>Look back at the questions</button>
            {done > 0 && (
              <button className="btn-ghost btn-lg" disabled={retaking || rewriting} onClick={retake}>
                {retaking ? "Clearing…" : "Retake this quiz"}
              </button>
            )}
          </div>
          <button className="btn-primary btn-lg" onClick={onNext}>{nextLabel}</button>
        </div>
        <RegenerateQuiz {...regenerateProps} />
      </section>
    );
  }

  const { q, at } = shown[index];
  const chosen = answers[at];
  const answered = chosen != null;

  return (
    <section ref={box} className="card scroll-mt-3 flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div ref={heading} tabIndex={-1} className="text-[13px] font-bold text-muted-foreground outline-none">
          Section quiz · {index + 1} of {total}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {q.id && <ReportQuestion key={q.id} onReport={(reason) => report(q.id, reason)} context="this quiz and your score" returnFocus={heading} />}
          {done > 0 && (
            <button className="btn-ghost px-1" onClick={() => goTo(total)}>
              I&apos;m done — see my score
            </button>
          )}
          {skip}
        </div>
      </div>
      {strip}
      {index === 0 && !answered && (
        <p className="px-1 text-[13px] font-semibold text-muted-foreground">
          {total === 1 ? "One question" : `${total} questions`} covering every fact on this section&apos;s {quiz.slides} {quiz.slides === 1 ? "slide" : "slides"}.
        </p>
      )}
      {/* Highlights and cross-outs are saved per question id; the answer shows once she has checked it. */}
      <QuestionCard
        bare
        key={q.id ?? at}
        q={{
          stem: q.question,
          options: q.options,
          image: q.image ?? null,
          option_notes: q.option_notes,
          explanation: q.explanation,
          chosen_index: chosen ?? null,
          correct_index: answered ? q.correct_index : undefined,
        }}
        pending={picked}
        onChoose={answered ? undefined : setPicked}
        locked={rewriting}
        marksKey={q.id ? `quiz:${q.id}` : null}
        belowOptions={saveError && <p className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">{saveError}</p>}
      />
      {answered ? (
        <button className="btn-primary btn-lg" onClick={() => goTo(index + 1)}>
          {index + 1 < total ? "Next question →" : "See my score"}
        </button>
      ) : (
        <button className="btn-primary btn-lg" disabled={picked == null || rewriting} onClick={check}>
          Check answer
        </button>
      )}
      <RegenerateQuiz {...regenerateProps} />
    </section>
  );
}
