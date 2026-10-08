"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AttemptView } from "@/lib/attemptView";
import { QuestionCard, type QuestionData } from "@/components/QuestionCard";
import { pct } from "@/lib/format";
import type { Confidence } from "@/lib/practicePlan";

const CONFIDENCE_CHOICES: [Confidence, string][] = [
  ["guess", "Guessed"],
  ["unsure", "Unsure"],
  ["sure", "Confident"],
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

  if (attempt.status === "generating") {
    return (
      <div className="card mx-auto mt-10 max-w-md space-y-2 text-center">
        <div className="text-lg font-semibold">Writing your practice exam…</div>
        <p className="text-sm text-muted-foreground">
          New questions are written from your slides{attempt.adaptive ? ", with extra focus on what you missed or weren't sure about" : ", spread evenly over the material"}.
          This usually takes 30–90 seconds.
        </p>
        <div className="mx-auto h-1 w-40 animate-pulse rounded bg-primary" />
      </div>
    );
  }
  if (attempt.status === "error") {
    return (
      <div className="card mx-auto mt-10 max-w-md space-y-3">
        <p className="text-danger">Couldn&apos;t create this exam: {attempt.error}</p>
        <Link href={`/exams/${attempt.exam_id}`} className="btn-secondary">Back to exam</Link>
      </div>
    );
  }

  if (finished) return <Results view={view} />;

  const current = questions[index];
  const q = current as QuestionData;
  const answeredCount = questions.filter((x) => x.chosen_index != null).length;

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

  const confidencePrompt =
    q.chosen_index == null && pending[q.id] != null ? (
      <div className="rounded-lg border border-primary/30 bg-primary-soft p-3">
        <div className="mb-2 text-sm font-medium">How sure are you?</div>
        <div className="grid grid-cols-3 gap-2">
          {CONFIDENCE_CHOICES.map(([value, label]) => (
            <button key={value} type="button" className="btn-secondary px-2" disabled={saving} onClick={() => lockIn(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/exams/${attempt.exam_id}`} className="text-sm text-muted-foreground hover:underline">← {attempt.exam_name}</Link>
          <h1 className="text-xl font-semibold">Practice exam · {attempt.mode === "timed" ? "Timed" : "Tutor mode"}</h1>
        </div>
        <div className="flex items-center gap-3">
          {attempt.time_limit_sec && <Timer startedAt={attempt.started_at} limit={attempt.time_limit_sec} onExpire={finish} />}
          <button className="btn-secondary" onClick={finish}>
            {answeredCount < questions.length ? `Finish (${answeredCount}/${questions.length} answered)` : "See results"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {questions.map((x, i) => (
          <button
            key={x.id}
            onClick={() => setIndex(i)}
            className={`h-8 w-8 rounded text-xs font-medium ${
              i === index
                ? "bg-primary text-primary-foreground"
                : x.chosen_index == null
                  ? "bg-card text-muted-foreground ring-1 ring-input"
                  : attempt.mode === "tutor"
                    ? x.correct
                      ? "bg-success-soft text-success"
                      : "bg-danger-soft text-danger"
                    : "bg-muted-strong text-foreground"
            }`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <QuestionCard
        key={q.id}
        q={q}
        pending={pending[q.id]}
        onChoose={q.chosen_index == null ? choose : undefined}
        belowOptions={confidencePrompt}
        header={
          <div className="text-xs text-muted-foreground">
            Question {index + 1} of {questions.length}
            {q.type !== "recall" && !q.caseInfo && <span className="ml-2 badge bg-info-soft text-info">{q.type === "case" ? "Case" : "Image"}</span>}
            {current.retry && <span className="ml-2 badge bg-warning-soft text-warning">↺ Missed last time</span>}
          </div>
        }
      />

      <div className="flex justify-between">
        <button className="btn-secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>← Previous</button>
        {index + 1 < questions.length ? (
          <button className="btn-primary" onClick={() => setIndex(index + 1)}>Next →</button>
        ) : (
          <button className="btn-primary" onClick={finish}>Finish exam</button>
        )}
      </div>
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
    <span className={`font-mono text-sm ${s < 120 ? "text-danger" : "text-foreground"}`}>
      ⏱ {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

function Results({ view }: { view: AttemptView }) {
  const { attempt, questions } = view;
  const byTopic = new Map<string, { right: number; total: number }>();
  for (const q of questions) {
    const k = q.topic ?? "Other";
    const t = byTopic.get(k) ?? { right: 0, total: 0 };
    t.total++;
    if (q.correct) t.right++;
    byTopic.set(k, t);
  }
  const missed = questions.filter((q) => !q.correct).length;
  const unsureRight = questions.filter((q) => q.correct && (q.confidence === "guess" || q.confidence === "unsure")).length;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href={`/exams/${attempt.exam_id}`} className="text-sm text-muted-foreground hover:underline">← {attempt.exam_name}</Link>
      <div className="card flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-sm text-muted-foreground">Score</div>
          <div className="text-4xl font-semibold">{pct(attempt.score)}</div>
          <div className="text-sm text-muted-foreground">
            {questions.length - missed} of {questions.length} correct
            {unsureRight > 0 && ` · ${unsureRight} right but not sure`}
          </div>
          {(missed > 0 || (attempt.adaptive && unsureRight > 0)) && (
            <p className="mt-2 text-sm text-muted-foreground">
              {missed > 0 && `The ${missed} you missed will come back in your next practice exam and in daily review. `}
              {attempt.adaptive && unsureRight > 0 ? "Ideas you weren't sure about will be tested again with new questions." : ""}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Link href="/review" className="btn-secondary">Daily review</Link>
          <Link href={`/exams/${attempt.exam_id}`} className="btn-primary">Back to exam</Link>
        </div>
      </div>

      <div className="card">
        <h2 className="mb-2 font-semibold tracking-tight">By topic</h2>
        <ul className="space-y-2 text-sm">
          {[...byTopic.entries()]
            .sort((a, b) => a[1].right / a[1].total - b[1].right / b[1].total)
            .map(([title, t]) => (
              <li key={title}>
                <div className="flex justify-between">
                  <span>{title}</span>
                  <span>{t.right}/{t.total}</span>
                </div>
                <div className="mt-1 h-2 rounded bg-muted">
                  <div
                    className={`h-2 rounded ${t.right / t.total >= 0.8 ? "bg-success" : t.right / t.total >= 0.6 ? "bg-warning" : "bg-danger"}`}
                    style={{ width: `${(t.right / t.total) * 100}%` }}
                  />
                </div>
              </li>
            ))}
        </ul>
      </div>

      <h2 className="pt-2 font-semibold tracking-tight">Review every question</h2>
      {questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          q={q as QuestionData}
          header={<div className="text-xs text-muted-foreground">Question {i + 1}{q.topic && ` · ${q.topic}`}</div>}
        />
      ))}
    </div>
  );
}
