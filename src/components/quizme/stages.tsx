"use client";
import { QuestionCard } from "../QuestionCard";
import { ReportQuestion } from "../ReportQuestion";
import { SIZES, type QuizMeState } from "./useQuizMe";

/** The question being written: about a minute. */
export function Writing({ size }: { size: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <p className="text-[15px] font-semibold text-muted-foreground" role="status">
        Writing {size} questions about this… about a minute.
      </p>
      <div className="shimmer h-5 w-3/4" />
      <div className="shimmer h-14 w-full" />
      <div className="shimmer h-14 w-full" />
      <div className="shimmer h-14 w-full" />
    </div>
  );
}

/** Between rounds of a lecture review: what she missed again comes round once more. */
export function RoundBreak({ s }: { s: QuizMeState }) {
  const { round, right, total, nextRound } = s;
  if (!nextRound) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[22px] bg-lilac p-5 text-on-lilac">
        <div className="text-[13px] font-extrabold opacity-75">Round {round} done · {Math.round((right / total) * 100)}% · {right}/{total} right</div>
        <div className="mt-1 text-[22px] font-extrabold tracking-tight">
          {nextRound.length === 1 ? "One question you missed again." : `${nextRound.length} questions you missed again.`}
        </div>
        <p className="mt-1 text-[14px] font-medium opacity-85">They come round once more, with the answers in a new order. Get one right and it&apos;s done.</p>
      </div>
      <button type="button" className="btn-primary btn-lg" onClick={s.startNextRound}>
        Next →
      </button>
    </div>
  );
}

/** The end of the quiz: her score, a way back through the questions, and Done. */
export function Score({ s }: { s: QuizMeState }) {
  const { quiz, total, right, firstRound, firstRight, stillMissed, laterRight } = s;
  if (!quiz) return null;
  const lecture = quiz.kind === "lecture";
  const retried = lecture && quiz.round > 1;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[22px] bg-hero p-5 text-hero-foreground">
        <div className="text-[13px] font-extrabold text-hero-accent">Your score</div>
        <div className="mt-1 text-[22px] font-extrabold tracking-tight">
          {lecture
            ? firstRound.length > 0
              ? `${Math.round((firstRight / firstRound.length) * 100)}% · ${firstRight}/${firstRound.length} right${retried ? " on the first pass" : ""}.`
              : "Nothing to score."
            : total > 0
              ? `${Math.round((right / total) * 100)}% · ${right}/${total} right.`
              : "Nothing to score."}
        </div>
        {retried && (
          <p className="mt-1 text-[14px] font-semibold">
            {laterRight} got right on a later try · {stillMissed > 0 ? `${stillMissed} still missed` : "all done"}
          </p>
        )}
        <p className="mt-1 text-[14px] font-medium opacity-85">
          {quiz.kind === "lecture"
            ? "These answers count toward your mastery. What you got right won't come back; what you missed will be in this lecture's next review."
            : "These answers count toward your mastery."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary btn-lg" onClick={s.lookBack}>
          ← Look back
        </button>
        <button type="button" className="btn-primary btn-lg" onClick={s.done}>
          Done
        </button>
      </div>
    </div>
  );
}

/** One question: pick an answer, then "Check answer"; back and forth between the ones she has answered. */
export function QuestionStep({ s }: { s: QuizMeState }) {
  const { quiz, shown, index, round, total, picked, saving, error, nextRound } = s;
  const item = shown[index];
  if (!quiz || !item) return null;
  const { q, at } = item;
  const answered = q.chosen != null;
  // Back and forth between the questions she has answered; forward only past an answered one.
  const canBack = index > 0 || round > 1;
  const canForward = answered || shown[index + 1]?.q.chosen != null;
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-bold text-muted-foreground">
          {quiz.kind === "lecture" && quiz.round > 1 ? `Round ${round} · ` : ""}Question {index + 1} of {total}
        </div>
        <ReportQuestion key={`${round}:${index}`} onReport={s.report} context="this quiz and your score" />
      </div>
      {/* Highlights and cross-outs are saved to her account under the quiz and question, like a section-quiz question. */}
      <QuestionCard
        bare
        key={`${quiz.id}:${at}`}
        q={{
          stem: q.question,
          options: q.options,
          image: q.image ?? null,
          option_notes: q.option_notes,
          explanation: q.explanation ?? undefined,
          chosen_index: q.chosen ?? null,
          correct_index: answered ? (q.correct_index ?? undefined) : undefined,
        }}
        pending={picked}
        onChoose={answered ? undefined : s.setPicked}
        locked={saving}
        marksKey={`quizme:${quiz.id}:${at}`}
        belowOptions={
          error && (
            <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
              {error}
            </p>
          )
        }
      />
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary btn-lg" disabled={!canBack} onClick={s.back} aria-label="Previous question">
          ←
        </button>
        {answered ? (
          <button type="button" className="btn-primary btn-lg flex-1" onClick={s.next}>
            {index + 1 < total ? "Next →" : nextRound || (quiz.kind === "lecture" && quiz.round > round) ? "Next →" : "See my score"}
          </button>
        ) : (
          <button type="button" className="btn-primary btn-lg flex-1" disabled={picked == null || saving} onClick={s.check}>
            {saving ? "Checking…" : "Check answer"}
          </button>
        )}
        {!answered && canForward && (
          <button type="button" className="btn-secondary btn-lg" onClick={s.next} aria-label="Next question">
            →
          </button>
        )}
      </div>
    </div>
  );
}

/** Choosing: the highlighted text and how many questions. */
export function ChooseSize({ s }: { s: QuizMeState }) {
  const { draft, size, error } = s;
  const text = draft?.text ?? "";
  return (
    <div className="flex flex-col gap-4">
      <blockquote className="line-clamp-5 rounded-[18px] bg-muted px-4 py-3 text-[15px] leading-snug font-medium break-words text-foreground">
        “{text.length > 320 ? `${text.slice(0, 320).trimEnd()}…` : text}”
      </blockquote>
      {draft?.cut && <p className="text-[13px] font-semibold text-muted-foreground">That&apos;s a long passage: the first part of it will be used.</p>}
      <div>
        <div className="label" id="quizme-size">
          How many questions?
        </div>
        <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="quizme-size">
          {SIZES.map((n) => (
            <button key={n} type="button" className="seg" aria-pressed={size === n} onClick={() => s.setSize(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
          {error}
        </p>
      )}
      <button type="button" className="btn-primary btn-lg" disabled={!text} onClick={s.start}>
        Start
      </button>
    </div>
  );
}
