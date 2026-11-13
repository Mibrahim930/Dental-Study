"use client";
import Link from "next/link";
import { Dialog } from "../Dialog";

/**
 * After "End session" / "Finish session": the session's note, and an offer of a short practice exam on the sections she
 * covered. `summary` undefined: not ended yet (nothing shown); null: ended without a note.
 */
export function EndSession({
  summary,
  covered,
  starting,
  onPractice,
  examId,
}: {
  summary: string | null | undefined;
  covered: number;
  starting: boolean;
  onPractice: () => void;
  examId: number;
}) {
  // The session is over: this stays up until she picks one (no Escape or tap outside).
  return (
    <Dialog
      open={summary !== undefined}
      onClose={() => {}}
      dismissable={false}
      label="Session saved"
      className="card fixed inset-x-3.5 bottom-3.5 z-[70] mx-auto flex max-w-md flex-col gap-3 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
    >
      <h2 className="section-title">Session saved</h2>
      {summary && <p className="text-[15px] leading-relaxed">{summary}</p>}
      <p className="text-[15px] text-muted-foreground">
        Want to lock it in? Take a short practice exam on the {covered} section{covered === 1 ? "" : "s"} you covered.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button className="btn-primary btn-lg flex-1" disabled={starting} onClick={onPractice}>
          {starting ? "Starting…" : "Practice these topics"}
        </button>
        <Link className="btn-secondary btn-lg" href={`/exams/${examId}`}>Not now</Link>
      </div>
    </Dialog>
  );
}
