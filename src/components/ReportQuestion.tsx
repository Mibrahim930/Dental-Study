"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, ICONS } from "./ui";
import { toast } from "./Toaster";

/** Keep in step with lib/reportedQuestions.ts. */
const REASON_MAX = 500;

/**
 * "Report" on any question. A tap opens a small dialog that asks "Are you sure?" (a mis-tap removes nothing), with an
 * optional one-line reason. On yes, `onReport` does the removing (the question leaves the quiz or exam she's in, and its
 * score) and the record goes to the site owner. `tone` matches the surface: "hero" on the dark explanation block,
 * "card" on a light one.
 */
export function ReportQuestion({ onReport, tone = "card", label = "Report" }: { onReport: (reason: string) => Promise<void>; tone?: "hero" | "card"; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onReport(reason.trim().slice(0, REASON_MAX));
      setOpen(false);
      setReason("");
      toast("Reported. It's out of this quiz and your score.");
    } catch {
      setError("The report didn't go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-bold ${
          tone === "hero" ? "text-hero-muted hover:bg-white/10 hover:text-hero-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
        aria-label={`${label} this question`}
      >
        <Icon d={ICONS.flag} size={15} />
        {label}
      </button>
      {open &&
        createPortal(
          <div>
            <div className="fixed inset-0 z-[60] bg-black/40" onClick={() => !busy && setOpen(false)} aria-hidden />
            <div
              ref={box}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="report-q-title"
              aria-describedby="report-q-text"
              className="fixed inset-x-4 top-1/2 z-[70] mx-auto flex max-w-[420px] -translate-y-1/2 flex-col gap-3 rounded-[24px] bg-card p-5 text-foreground shadow-[0_16px_48px_rgba(22,22,22,.28)]"
            >
              <h2 id="report-q-title" className="text-[18px] font-extrabold tracking-tight">
                Report this question?
              </h2>
              <p id="report-q-text" className="text-[15px] leading-snug text-muted-foreground">
                It will be removed from this quiz and from your score, and sent to the site owner so questions like it stop coming up.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-[13px] font-bold text-muted-foreground">What&apos;s wrong with it? (optional)</span>
                <input
                  ref={field}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={REASON_MAX}
                  disabled={busy}
                  className="h-11 w-full rounded-2xl border-2 border-transparent bg-muted px-3 text-[15px] outline-none focus:border-hero"
                  placeholder="e.g. it's about the cover slide"
                  onKeyDown={(e) => e.key === "Enter" && void confirm()}
                />
              </label>
              {error && (
                <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary btn-lg" disabled={busy} onClick={() => setOpen(false)}>
                  No, keep it
                </button>
                <button type="button" className="btn-primary btn-lg" disabled={busy} onClick={() => void confirm()}>
                  {busy ? "Reporting…" : "Yes, report it"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
