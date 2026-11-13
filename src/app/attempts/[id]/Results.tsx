"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AttemptView } from "@/lib/attemptView";
import { QuestionCard, type QuestionData } from "@/components/QuestionCard";
import { DoubleRing, Icon, ICONS, RingLegend } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { ServerMessage, failureText, jsonOf, signedOut } from "@/components/clientFetch";
import { QuizMe } from "@/components/QuizMe";

/** A finished practice exam: score, what to do next, results by topic, and every question to look back at. */
export function Results({ view, onReport }: { view: AttemptView; onReport: (questionId: number, reason: string) => Promise<void> }) {
  const router = useRouter();
  const { attempt, questions, context } = view;
  // Keyed by question id: reporting a question removes it from the list, and the one she has open must stay open.
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
    // Questions whose topic no longer exists come from a removed lecture (or a rebuilt topic map).
    const k = q.topic ?? "Removed lecture";
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

  // Topics of the missed questions that still exist (a removed lecture takes its topics with it).
  const missedTopicIds = [...new Set(missed.map((q) => q.topic_id).filter((t): t is number => t != null))];

  async function studyMisses() {
    const topicIds = missedTopicIds;
    if (topicIds.length === 0) return;
    setStarting(true);
    try {
      const res = await fetch(`/api/exams/${attempt.exam_id}/attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: Math.min(25, Math.max(10, topicIds.length * 4)), mode: "tutor", style: "mixed", scope: { kind: "topics", topicIds } }),
      });
      if (signedOut(res)) return;
      const json = await jsonOf<{ id?: number; error?: string }>(res);
      if (!res.ok || !json?.id) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      router.push(`/attempts/${json.id}`);
    } catch (err) {
      setStarting(false);
      toast(failureText(err, "Couldn't start the practice exam. Check your connection and try again."), "error");
    }
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
            center={`${Math.round(score * 100)}%`}
            label={`Score ${Math.round(score * 100)} percent, ${right} of ${total} right, ${confidentRight} right and confident`}
          />
          <RingLegend
            items={[
              { color: "var(--hero-accent)", label: "Score", value: `${Math.round(score * 100)}% · ${right}/${total}` },
              { color: "var(--hero-accent-2)", label: "Right and confident", value: `${total ? Math.round((confidentRight / total) * 100) : 0}% · ${confidentRight}/${total}` },
            ]}
          />
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
          {missed.length > 0 && missedTopicIds.length === 0 && "The lectures your misses came from have been removed, so there's no new practice to write from them. "}
          {attempt.adaptive && unsureRight > 0 ? "Ideas you weren't sure about get new questions." : ""}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {missed.length > 0 && missedTopicIds.length > 0 && (
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
                    {Math.round(r * 100)}% · {t.right}/{t.total}
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
                onClick={() => setOpen(open === q.id ? null : q.id)}
                aria-expanded={open === q.id}
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
              {open === q.id && (
                <div className="flex flex-col gap-2.5 px-1 pt-1 pb-3">
                  <QuestionCard reportContext="this practice exam and its score" q={q as QuestionData} practice marksKey={`attempt:${attempt.id}:${q.id}`} onReport={(reason) => onReport(q.id, reason)} header={q.topic ? <div className="px-1 text-[13px] font-bold text-muted-foreground">{q.topic}</div> : undefined} />
                </div>
              )}
            </div>
          );
        })}
      </section>
      {/* On the results page only: highlighting any explanation offers "Quiz me on this" (never during a live exam). */}
      <QuizMe examId={attempt.exam_id} />
    </div>
  );
}
