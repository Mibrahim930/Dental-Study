"use client";
import { useRef, useState } from "react";
import { Icon, ICONS } from "./ui";
import { toast } from "./Toaster";
import { Dialog } from "./Dialog";

/** Keep in step with lib/reportedQuestions.ts. */
const REASON_MAX = 500;

/**
 * "Report" on any question. A tap opens a small dialog that asks "Are you sure?" (a mis-tap removes nothing), with an
 * optional one-line reason. On yes, `onReport` does the removing (the question leaves the quiz or exam she's in, and its
 * score) and the record goes to the site owner. `context` says where it leaves ("this quiz and your score", "today's
 * review"); without it the wording doesn't name a place, which reads right anywhere.
 */
export function ReportQuestion({ onReport, context }: { onReport: (reason: string) => Promise<void>; context?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);

  // Closing gives focus back to the Report button (the dialog does that).
  const shut = () => setOpen(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onReport(reason.trim().slice(0, REASON_MAX));
      shut();
      setReason("");
      toast(context ? `Reported. It's out of ${context}.` : "Reported. It won't come up again.");
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
        className="inline-flex h-11 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-bold text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Report this question"
      >
        <Icon d={ICONS.flag} size={15} />
        Report
      </button>
      <Dialog
        open={open}
        onClose={shut}
        label="Report this question?"
        role="alertdialog"
        aria-describedby="report-q-text"
        initialFocus={field}
        dismissable={!busy}
      >
        <h2 id="report-q-title" className="text-[18px] font-extrabold tracking-tight">
          Report this question?
        </h2>
        <p id="report-q-text" className="text-[15px] leading-snug text-muted-foreground">
          {context ? `It will be removed from ${context}. ` : "It won't come up for you again. "}
          It also goes to the site owner so questions like it stop coming up.
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
          <button type="button" className="btn-secondary btn-lg" disabled={busy} onClick={shut}>
            No, keep it
          </button>
          <button type="button" className="btn-primary btn-lg" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Reporting…" : "Yes, report it"}
          </button>
        </div>
      </Dialog>
    </>
  );
}
