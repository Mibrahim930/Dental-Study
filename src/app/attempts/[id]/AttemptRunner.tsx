"use client";
import Link from "next/link";
import type { AttemptView } from "@/lib/attemptView";
import { QuestionCard, type QuestionData } from "@/components/QuestionCard";
import { Icon, ICONS } from "@/components/ui";
import { useAttempt } from "./useAttempt";
import { Writing } from "./Writing";
import { Timer } from "./Timer";
import { Results } from "./Results";
import { QuestionNav } from "./QuestionNav";
import { ConfidencePicker } from "./ConfidencePicker";
import { FinishConfirm } from "./FinishConfirm";
import { AttemptError } from "./AttemptError";
import { ExamCoverage, ExamProgress } from "./ExamProgress";
import { planFields } from "@/components/examProgressText";

/** A practice exam: written (with a waiting screen), answered one question at a time, then the results. */
export function AttemptRunner({ attemptId, initial }: { attemptId: number; initial: AttemptView }) {
  const { view, index, goto, questionTop, pending, setPending, saving, saveError, finishing, confirmAt, setConfirmAt, report, finish, startedMs, lockIn } = useAttempt(attemptId, initial);
  const { attempt, questions } = view;
  const finished = attempt.status === "finished";

  if (attempt.status === "generating") return <Writing view={view} startedMs={startedMs} />;
  if (attempt.status === "error") return <AttemptError attempt={attempt} />;

  if (finished) return <Results view={view} onReport={report} />;

  if (questions.length === 0) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <section className="tile cb-lilac flex flex-col gap-3 rounded-[28px]">
          <div className="text-[26px] leading-tight font-extrabold tracking-tight">Every question in this exam was reported.</div>
          <p className="text-[15px] font-medium">There&apos;s nothing left to answer here. Finish it and write a new one from the exam page.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={finishing} onClick={() => void finish()}>
              Finish this exam
            </button>
            <Link href={`/exams/${attempt.exam_id}`} className="btn-ghost btn-sm text-on-lilac">Back to exam</Link>
          </div>
        </section>
      </div>
    );
  }

  const current = questions[Math.min(index, questions.length - 1)];
  const q = current as QuestionData;
  const answeredCount = questions.filter((x) => x.chosen_index != null).length;
  const tutor = attempt.mode === "tutor";

  // Picking an option only selects it; it locks in once the student says how sure they are (before seeing the answer).
  function choose(i: number) {
    if (q.chosen_index != null || saving) return;
    setPending((p) => ({ ...p, [q.id]: i }));
  }

  const left = questions.length - answeredCount;
  // Questions still to be written are lost if she finishes now, so that asks first too.
  const stillWriting = planFields(view).pending;
  const requestFinish = (at: "top" | "bottom") => (left > 0 || stillWriting > 0 ? setConfirmAt(at) : void finish());
  const confidence = <ConfidencePicker q={q} current={current} pending={pending} saving={saving} saveError={saveError} lockIn={(c) => lockIn(q, c)} />;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2.5 sm:gap-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <Link href={`/exams/${attempt.exam_id}`} className="flex min-w-0 items-center gap-1.5 text-[15px] font-bold text-muted-foreground hover:text-foreground">
          <Icon d={ICONS.arrowLeft} size={18} />
          <span className="truncate">{attempt.exam_name}</span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          {attempt.time_limit_sec && <Timer startedAt={attempt.started_at} limit={attempt.time_limit_sec} onExpire={finish} />}
          <button className="btn-primary btn-sm" disabled={finishing} onClick={() => requestFinish("top")}>
            Finish · {answeredCount}/{questions.length}
          </button>
        </div>
      </div>
      <div className="px-1">
        <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Practice exam · {tutor ? "Learn" : "Timed"}</h1>
      </div>
      <ExamCoverage view={view} />
      <ExamProgress view={view} count={questions.length} />

      <QuestionNav questions={questions} index={index} tutor={tutor} goto={goto} />

      <QuestionCard reportContext="this practice exam and its score"
        key={q.id}
        q={q}
        practice
        marksKey={`attempt:${attemptId}:${q.id}`}
        pending={pending[q.id]}
        onChoose={q.chosen_index == null ? choose : undefined}
        onReport={(reason) => report(q.id, reason)}
        belowOptions={confidence}
        tag={current.retry ? <span className="chip bg-on-lilac text-lilac">↺ Missed last time</span> : undefined}
        header={
          <div className="flex items-center justify-between px-1 text-[13px] font-bold text-muted-foreground">
            <span ref={questionTop} tabIndex={-1} className="outline-none">
              Question {index + 1} of {questions.length}
            </span>
            {q.type !== "recall" && !q.caseInfo && <span className="chip cb-sky">{q.type === "case" ? "Case" : "Image"}</span>}
          </div>
        }
      />

      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <button className="btn-secondary btn-lg bg-card" disabled={index === 0} onClick={() => goto(index - 1)}>
          ← Back
        </button>
        {index + 1 < questions.length ? (
          <button className="btn-primary btn-lg" onClick={() => goto(index + 1)}>Next question →</button>
        ) : (
          <button className="btn-primary btn-lg" disabled={finishing} onClick={() => requestFinish("bottom")}>Finish exam</button>
        )}
      </div>
      <FinishConfirm open={confirmAt != null} left={left} stillWriting={stillWriting} finishing={finishing} finish={finish} onClose={() => setConfirmAt(null)} />
    </div>
  );
}
