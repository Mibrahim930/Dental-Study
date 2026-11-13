"use client";
import { useRef } from "react";
import { Dialog } from "../Dialog";

export type RegenState = "idle" | "confirm" | "working" | "error";

/**
 * "Write new questions": the one way a section's quiz changes. Asks first (it takes a minute or two and costs a
 * little), then has the server write a fresh 20 (the old ones stay until the new ones are ready), and reloads the quiz.
 * Only draws it: the state and the request live in useSectionQuiz, so it can never run twice.
 */
export function RegenerateQuiz({
  state,
  error,
  onAsk,
  onCancel,
  onRun,
}: {
  state: RegenState;
  error: string;
  onAsk: () => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  if (state === "working") {
    return (
      <div className="rounded-[20px] bg-muted px-4 py-3 text-[14px] font-semibold text-muted-foreground" aria-busy>
        Writing a new set of questions (one per fact on these slides) and checking them against your slides… about 1–2 minutes. Keep this page open.
      </div>
    );
  }
  return (
    <>
      <div className="flex justify-end">
        <button className="btn-ghost px-1 text-[13px]" onClick={onAsk}>
          Write new questions for this section
        </button>
      </div>
      <Dialog open={state === "confirm" || state === "error"} onClose={onCancel} label="Write new questions?" role="alertdialog" initialFocus={keep}>
        <p className="text-[15px] font-bold">Replace this section&apos;s questions with 20 new ones?</p>
        <p className="text-[13px] font-medium text-muted-foreground">
          Takes 1–2 minutes and uses a little AI credit. Your answers to the current questions stay in your history but won&apos;t show here any more.
        </p>
        {state === "error" && (
          <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button ref={keep} type="button" className="btn-secondary btn-lg" onClick={onCancel}>
            Keep these
          </button>
          <button type="button" className="btn-primary btn-lg" onClick={onRun}>
            {state === "error" ? "Try again" : "Yes, write new questions"}
          </button>
        </div>
      </Dialog>
    </>
  );
}
