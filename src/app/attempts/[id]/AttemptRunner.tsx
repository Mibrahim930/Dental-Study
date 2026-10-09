"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { AttemptView } from "@/lib/attemptView";
import { QuestionCard, type QuestionData } from "@/components/QuestionCard";
import type { Confidence } from "@/lib/practicePlan";
import { DoubleRing, Icon, ICONS } from "@/components/ui";

const CONFIDENCE_CHOICES: [Confidence, string, string][] = [
  ["guess", "Guessed", "bg-lilac text-on-lilac"],
  ["unsure", "Unsure", "bg-butter text-on-butter"],
  ["sure", "Confident", "bg-mint text-on-mint"],
];

export function AttemptRunner({ attemptId, initial }: { attemptId: number; initial: AttemptView }) {
  const [view, setView] = useState(initial);
  const [index, setIndex] = useState(() => {
    const firstOpen = initial.questions.findIndex((q) => q.chosen_index == null);
    return firstOpen === -1 ? 0 : firstOpen;
  });
  const [pending, setPending] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const { attempt, questions } = view;
  const finished = attempt.status === "finished";

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/attempts/${attemptId}`);
    if (res.ok) setView(await res.json());
  }, [attemptId]);

  // Poll while questions are being written.
  useEffect(() => {
    if (attempt.status !== "generating") return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [attempt.status, refresh]);

  const finish = useCallback(async () => {
    const res = await fetch(`/api/attempts/${attemptId}/finish`, { method: "POST" });
    setView(await res.json());
    window.scrollTo({ top: 0 });
  }, [attemptId]);

  if (attempt.status === "generating") return <Writing view={view} />;
  if (attempt.status === "error") {
    const keyProblem = /key|auth|401|403|credit|billing/i.test(attempt.error ?? "");
    return (
      <div className="mx-auto mt-6 flex max-w-lg flex-col gap-3">
        <section className="tile cb-coral flex flex-col gap-3 rounded-[28px]">
          <div className="text-[22px] font-extrabold tracking-tight">{keyProblem ? "Your AI key needs attention." : "Couldn't write this exam."}</div>
          <p className="text-[15px] font-medium break-words">{attempt.error}</p>
          <div className="flex flex-wrap gap-2">
            {keyProblem ? (
              <>
                <Link href="/settings" className="btn-primary btn-sm">Update key</Link>
                <Link href="/help/api-keys" className="btn-ghost btn-sm text-on-coral">How to fix</Link>
              </>
            ) : (
              <Link href={`/exams/${attempt.exam_id}`} className="btn-primary btn-sm">Back to exam</Link>
            )}
          </div>
        </section>
      </div>
    );
  }

  if (finished) return <Results view={view} />;

  const current = questions[index];
  const q = current as QuestionData;
  const answeredCount = questions.filter((x) => x.chosen_index != null).length;
  const tutor = attempt.mode === "tutor";

  // Picking an option only selects it; it locks in once the student says how sure they are (before seeing the answer).
  function choose(i: number) {
    if (q.chosen_index != null || saving) return;
    setPending((p) => ({ ...p, [q.id]: i }));
  }

  async function lockIn(confidence: Confidence) {
    const chosen = pending[q.id];
    if (chosen == null || q.chosen_index != null) return;
    setSaving(true);
    const res = await fetch(`/api/attempts/${attemptId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: q.id, chosen, confidence }),
    });
    setView(await res.json());
    setSaving(false);
  }

  const locked = q.chosen_index != null;
  const confidence = (
    <div className="mt-1.5 flex flex-col gap-2">
      <span className="px-1 text-[13px] font-bold text-muted-foreground">
        {locked ? "You said you were" : pending[q.id] != null ? "How sure are you? This locks in your answer." : "Pick an answer, then say how sure you are."}
      </span>
      <div className="grid grid-cols-3 gap-1.5">
        {CONFIDENCE_CHOICES.map(([value, label, chosenClass]) => {
          const isChosen = locked && current.confidence === value;
          return (
            <button
              key={value}
              type="button"
              disabled={locked || saving || pending[q.id] == null}
              aria-pressed={isChosen}
              onClick={() => lockIn(value)}
              className={`h-[52px] rounded-2xl text-[15px] font-bold transition-colors disabled:cursor-default ${
                isChosen ? chosenClass : locked ? "bg-muted text-muted-foreground opacity-60" : "bg-muted text-foreground hover:bg-muted-strong disabled:opacity-60"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2.5 sm:gap-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <Link href={`/exams/${attempt.exam_id}`} className="flex min-w-0 items-center gap-1.5 text-[15px] font-bold text-muted-foreground hover:text-foreground">
          <Icon d={ICONS.arrowLeft} size={18} />
          <span className="truncate">{attempt.exam_name}</span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          {attempt.time_limit_sec && <Timer startedAt={attempt.started_at} limit={attempt.time_limit_sec} onExpire={finish} />}
          <button className="btn-primary btn-sm" onClick={finish}>
            Finish · {answeredCount}/{questions.length}
          </button>
        </div>
      </div>
      <div className="px-1">
        <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Practice exam · {tutor ? "Tutor" : "Timed"}</h1>
      </div>

      <div className="flex flex-wrap gap-1.5 px-1" role="list" aria-label="Questions">
        {questions.map((x, i) => (
          <button
            key={x.id}
            role="listitem"
            onClick={() => setIndex(i)}
            aria-current={i === index ? "step" : undefined}
            aria-label={`Question ${i + 1}${x.chosen_index == null ? "" : tutor ? (x.correct ? ", right" : ", wrong") : ", answered"}`}
            className={`h-9 w-9 rounded-[11px] text-[13px] font-extrabold transition-colors ${
              x.chosen_index == null
                ? "bg-card text-muted-foreground"
                : tutor
                  ? x.correct
                    ? "bg-mint text-on-mint"
                    : "bg-coral text-on-coral"
                  : "bg-action text-action-foreground"
            } ${i === index ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <QuestionCard
        key={q.id}
        q={q}
        practice
        pending={pending[q.id]}
        onChoose={q.chosen_index == null ? choose : undefined}
        belowOptions={confidence}
        tag={current.retry ? <span className="chip bg-on-lilac text-lilac">↺ Missed last time</span> : undefined}
        header={
          <div className="flex items-center justify-between px-1 text-[13px] font-bold text-muted-foreground">
            <span>
              Question {index + 1} of {questions.length}
            </span>
            {q.type !== "recall" && !q.caseInfo && <span className="chip cb-sky">{q.type === "case" ? "Case" : "Image"}</span>}
          </div>
        }
      />

      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <button className="btn-secondary btn-lg bg-card" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          ← Back
        </button>
        {index + 1 < questions.length ? (
          <button className="btn-primary btn-lg" onClick={() => setIndex(index + 1)}>Next question →</button>
        ) : (
          <button className="btn-primary btn-lg" onClick={finish}>Finish exam</button>
        )}
      </div>
    </div>
  );
}

/** Loading screen while the AI writes the exam: real steps from the exam's plan, and a spinning ring. */
function Writing({ view }: { view: AttemptView }) {
  const plan = view.plan;
  const cases = plan?.style === "caseset";
  const steps: { label: string; state: "done" | "active" | "todo" }[] = plan
    ? [
        {
          label: cases ? `Planned ${plan.cases} case set${plan.cases === 1 ? "" : "s"} across ${plan.topics} topic${plan.topics === 1 ? "" : "s"}` : `Picked ${plan.size} questions across ${plan.topics} topic${plan.topics === 1 ? "" : "s"}`,
          state: "done",
        },
        ...(plan.retried > 0 ? [{ label: `Brought back ${plan.retried} you missed`, state: "done" as const }] : []),
        { label: cases ? `Writing ${plan.fresh} new case set${plan.fresh === 1 ? "" : "s"} from your slides` : `Writing ${plan.fresh} new questions from your slides`, state: "active" },
        { label: "Checking answers against your slides", state: "todo" },
      ]
    : [{ label: "Choosing questions for you", state: "active" }];
  return (
    <div className="mx-auto mt-4 flex max-w-lg flex-col gap-3">
      <section className="flex flex-col gap-5 rounded-[32px] bg-nav p-6 text-white sm:p-8">
        <div className="flex items-center gap-4">
          <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0 animate-spin" aria-hidden>
            <circle cx="28" cy="28" r="22" fill="none" stroke="rgb(255 255 255 / 0.12)" strokeWidth="7" />
            <circle cx="28" cy="28" r="22" fill="none" stroke="var(--hero-accent)" strokeWidth="7" strokeLinecap="round" strokeDasharray="40 138" />
          </svg>
          <div>
            <h1 className="text-[24px] leading-tight font-extrabold tracking-tight">Writing your practice exam…</h1>
            <p className="text-[15px] text-nav-foreground">Usually 30–90 seconds.</p>
          </div>
        </div>
        <ol className="flex flex-col gap-2.5" aria-live="polite">
          {steps.map((s) => (
            <li key={s.label} className={`flex items-center gap-3 text-[15px] font-semibold ${s.state === "todo" ? "text-nav-foreground" : ""}`}>
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs ${
                  s.state === "done" ? "bg-mint text-on-mint" : s.state === "active" ? "bg-butter text-on-butter" : "bg-white/10"
                }`}
                aria-hidden
              >
                {s.state === "done" ? <Icon d={ICONS.check} size={14} /> : s.state === "active" ? "●" : ""}
              </span>
              {s.label}
            </li>
          ))}
        </ol>
        <p className="text-[13px] text-nav-foreground">
          {view.attempt.adaptive ? "Extra focus on what you missed or weren't sure about." : "Spread evenly over the material."} You can leave this page; it&apos;ll be waiting on the exam
          page.
        </p>
      </section>
    </div>
  );
}

function Timer({ startedAt, limit, onExpire }: { startedAt: string; limit: number; onExpire: () => void }) {
  const end = new Date(startedAt.replace(" ", "T") + "Z").getTime() + limit * 1000;
  const [left, setLeft] = useState(() => Math.max(0, end - Date.now()));
  useEffect(() => {
    const t = setInterval(() => {
      const l = Math.max(0, end - Date.now());
      setLeft(l);
      if (l === 0) {
        clearInterval(t);
        onExpire();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [end, onExpire]);
  const s = Math.floor(left / 1000);
  return (
    <span className={`flex h-[38px] items-center rounded-xl px-3 font-mono text-sm font-bold ${s < 120 ? "bg-coral text-on-coral" : "bg-butter text-on-butter"}`}>
      ⏱ {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

function Results({ view }: { view: AttemptView }) {
  const router = useRouter();
  const { attempt, questions, context } = view;
  const [open, setOpen] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  const total = questions.length;
  const skipped = questions.filter((q) => q.chosen_index == null).length;
  const missed = questions.filter((q) => q.chosen_index != null && !q.correct);
  const right = total - missed.length - skipped;
  const confidentRight = questions.filter((q) => q.correct && q.confidence === "sure").length;
  const unsureRight = questions.filter((q) => q.correct && (q.confidence === "guess" || q.confidence === "unsure")).length;
  const score = attempt.score ?? 0;

  const byTopic = new Map<string, { right: number; total: number }>();
  for (const q of questions) {
    const k = q.topic ?? "Other";
    const t = byTopic.get(k) ?? { right: 0, total: 0 };
    t.total++;
    if (q.correct) t.right++;
    byTopic.set(k, t);
  }

  const diff = context?.previous != null ? Math.round((score - context.previous) * 100) : null;
  const headline = context?.best
    ? `Your best ${attempt.exam_name} score yet.`
    : score >= 0.8
      ? "Solid work."
      : score >= 0.6
        ? "Getting there."
        : "Good practice. Now let's fix the misses.";

  async function studyMisses() {
    const topicIds = [...new Set(missed.map((q) => q.topic_id).filter((t): t is number => t != null))];
    if (topicIds.length === 0) return;
    setStarting(true);
    const res = await fetch(`/api/exams/${attempt.exam_id}/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: Math.min(25, Math.max(10, topicIds.length * 4)), mode: "tutor", style: "mixed", scope: { kind: "topics", topicIds } }),
    });
    const { id } = await res.json();
    router.push(`/attempts/${id}`);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2.5 sm:gap-3">
      <Link href={`/exams/${attempt.exam_id}`} className="flex items-center gap-1.5 px-1 text-[15px] font-bold text-muted-foreground hover:text-foreground">
        <Icon d={ICONS.arrowLeft} size={18} /> {attempt.exam_name}
      </Link>

      <section className="card-hero flex flex-col gap-5">
        <div>
          <h1 className="text-[32px] leading-[1.02] font-extrabold tracking-[-0.035em] sm:text-[44px]">{headline}</h1>
          {diff != null && diff !== 0 && (
            <p className="mt-1.5 text-[17px] font-bold text-hero-accent">
              {diff > 0 ? `Up ${diff} points since last time.` : `${Math.abs(diff)} points below last time. That's what practice is for.`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-[18px]">
          <DoubleRing
            outer={score}
            inner={total ? confidentRight / total : 0}
            center={`${right} of ${total}`}
            label={`Score ${Math.round(score * 100)} percent, ${confidentRight} right and confident`}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-hero-muted">Score</span>
              <span className="flex items-center gap-2 text-[15px] font-bold">
                <span className="h-3 w-3 rounded-[4px] bg-hero-accent" aria-hidden /> {Math.round(score * 100)}%
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-hero-muted">Right and confident</span>
              <span className="flex items-center gap-2 text-[15px] font-bold">
                <span className="h-3 w-3 rounded-[4px] bg-hero-accent-2" aria-hidden /> {confidentRight} of {total}
              </span>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-3 gap-2.5">
        <div className="tile cb-butter flex h-28 flex-col justify-between px-3.5 py-4">
          <span className="text-[13px] leading-tight font-bold">Right but not sure</span>
          <span className="big-number">{unsureRight}</span>
        </div>
        <div className="tile cb-lilac flex h-28 flex-col justify-between px-3.5 py-4">
          <span className="text-[13px] font-bold">Skipped</span>
          <span className="big-number">{skipped}</span>
        </div>
        <div className="tile cb-coral flex h-28 flex-col justify-between px-3.5 py-4">
          <span className="text-[13px] leading-tight font-bold">Come back next time</span>
          <span className="big-number">{missed.length}</span>
        </div>
      </div>
      {(missed.length > 0 || (attempt.adaptive && unsureRight > 0)) && (
        <p className="px-2 text-[15px] text-muted-foreground">
          {missed.length > 0 && "Missed questions come back in your next practice exam and in daily review. "}
          {attempt.adaptive && unsureRight > 0 ? "Ideas you weren't sure about get new questions." : ""}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {missed.length > 0 && (
          <button className="btn-primary btn-lg flex-1" disabled={starting} onClick={studyMisses}>
            {starting ? "Starting…" : "Study my misses now"}
          </button>
        )}
        <Link href={`/exams/${attempt.exam_id}`} className="btn-secondary btn-lg flex-1 bg-card">Back to exam</Link>
      </div>

      <section className="card flex flex-col gap-3.5">
        <h2 className="section-title">By topic</h2>
        {[...byTopic.entries()]
          .sort((a, b) => a[1].right / a[1].total - b[1].right / b[1].total)
          .map(([title, t]) => {
            const r = t.right / t.total;
            return (
              <div key={title}>
                <div className="flex justify-between gap-3 text-[15px] font-semibold">
                  <span className="min-w-0">{title}</span>
                  <span className="shrink-0">
                    {t.right}/{t.total}
                  </span>
                </div>
                <div className="bar mt-1.5 h-2.5">
                  <span className={r >= 0.8 ? "bg-primary" : r >= 0.6 ? "bg-butter" : "bg-coral"} style={{ width: `${Math.max(3, r * 100)}%` }} />
                </div>
              </div>
            );
          })}
      </section>

      <section className="card flex flex-col gap-1 p-3 sm:p-4">
        <h2 className="section-title px-2 pt-1 pb-2">Every question</h2>
        {questions.map((q, i) => {
          const state = q.chosen_index == null ? "skip" : q.correct ? "right" : "wrong";
          return (
            <div key={q.id}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left hover:bg-muted"
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[13px] font-extrabold ${
                    state === "right" ? "bg-mint text-on-mint" : state === "wrong" ? "bg-coral text-on-coral" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{q.stem}</span>
                {q.confidence && (
                  <span className={`chip shrink-0 ${q.confidence === "sure" ? "cb-mint" : q.confidence === "unsure" ? "cb-butter" : "cb-lilac"}`}>
                    {q.confidence === "sure" ? "Confident" : q.confidence === "unsure" ? "Unsure" : "Guessed"}
                  </span>
                )}
              </button>
              {open === i && (
                <div className="flex flex-col gap-2.5 px-1 pt-1 pb-3">
                  <QuestionCard q={q as QuestionData} practice header={q.topic ? <div className="px-1 text-[13px] font-bold text-muted-foreground">{q.topic}</div> : undefined} />
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
