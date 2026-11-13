"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AttemptView } from "@/lib/attemptView";
import { Icon, ICONS } from "@/components/ui";
import { SLOW_AFTER_MS } from "./useAttempt";
import { planFields, plannedStep, writtenStep } from "@/components/examProgressText";

/** Loading screen while the AI writes the exam: real steps from the exam's plan, and a spinning ring. */
export function Writing({ view, startedMs }: { view: AttemptView; startedMs: number }) {
  // After three minutes she is told it is slow and that she doesn't have to wait here.
  const [slow, setSlow] = useState(() => Date.now() - startedMs >= SLOW_AFTER_MS);
  useEffect(() => {
    if (slow) return;
    const t = setTimeout(() => setSlow(true), Math.max(0, startedMs + SLOW_AFTER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [slow, startedMs]);
  const plan = view.plan;
  const cases = plan?.style === "caseset";
  // An exam written to a plan reports real progress: how many questions the plan holds and how many are written.
  const { planned, written } = planFields(view);
  const sections = typeof plan?.topics === "number" ? plan.topics : null;
  const steps: { label: string; state: "done" | "active" | "todo" }[] = planned != null && planned > 0
    ? [
        { label: plannedStep(planned, sections), state: "done" },
        ...(plan && plan.retried > 0 ? [{ label: `Brought back ${plan.retried} you missed`, state: "done" as const }] : []),
        { label: writtenStep(written), state: "active" },
        { label: "Checking answers against your slides", state: "todo" },
      ]
    : plan
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
            <p className="text-[15px] text-nav-foreground">{slow ? "This is taking longer than usual." : "Usually 30–90 seconds."}</p>
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
        {slow ? (
          <p role="status" className="rounded-2xl bg-white/10 px-4 py-3 text-[15px] font-semibold">
            This is taking longer than usual. You don&apos;t have to wait here: go back to the exam, and this practice exam will appear on the exam page
            when it&apos;s ready.
          </p>
        ) : (
          <p className="text-[13px] text-nav-foreground">
            {view.attempt.adaptive ? "Extra focus on what you missed or weren't sure about." : "Spread evenly over the material."} You can leave this page; it&apos;ll be waiting on the
            exam page.
          </p>
        )}
        <Link href={`/exams/${view.attempt.exam_id}`} className={`${slow ? "btn-hero" : "btn-secondary bg-white/10 text-white hover:bg-white/20"} btn-sm self-start`}>
          <Icon d={ICONS.arrowLeft} size={16} /> Back to exam
        </Link>
      </section>
    </div>
  );
}
