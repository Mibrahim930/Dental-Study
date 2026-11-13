"use client";
import { useRef } from "react";
import { Dialog } from "@/components/Dialog";
import { finishPendingLine } from "@/components/examProgressText";

/**
 * "Finish" with questions left (unanswered, or still being written) asks first (one stray tap shouldn't end a timed
 * exam). "Keep going" has the focus.
 */
export function FinishConfirm({
  open,
  left,
  stillWriting = 0,
  finishing,
  finish,
  onClose,
}: {
  open: boolean;
  left: number;
  stillWriting?: number;
  finishing: boolean;
  finish: () => Promise<boolean>;
  onClose: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  const writing = finishPendingLine(stillWriting);
  return (
    <Dialog open={open} onClose={onClose} label="Finish the exam?" role="alertdialog" initialFocus={keep}>
      {left > 0 ? (
        <p className="text-[15px] font-bold">
          {left} question{left === 1 ? "" : "s"} still unanswered. Finish anyway?
        </p>
      ) : (
        <p className="text-[15px] font-bold">{writing} Finish anyway?</p>
      )}
      {left > 0 && writing && <p className="text-[15px] font-semibold">{writing}</p>}
      {left > 0 && <p className="text-[13px] font-medium text-muted-foreground">Unanswered questions count as skipped and come back in a later exam.</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button ref={keep} type="button" className="btn-secondary btn-lg" onClick={onClose}>
          Keep going
        </button>
        <button type="button" className="btn-primary btn-lg" disabled={finishing} onClick={() => void finish()}>
          {finishing ? "Finishing…" : "Yes, finish"}
        </button>
      </div>
    </Dialog>
  );
}
