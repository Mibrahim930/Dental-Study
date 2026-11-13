"use client";
import { createPortal } from "react-dom";
import { Icon, ICONS } from "../ui";
import type { QuizMeState } from "./useQuizMe";

/**
 * "Resume your quiz" (or "Writing your quiz…"): floats above the tab bar and the Report button while the panel is shut.
 * On a phone it would cover the page's last lines, so it also adds room at the end of <main> for them to scroll clear.
 * While the panel is open it stays on the page, hidden: the panel opened from it gives focus back to it on closing.
 */
export function ResumeButton({ s }: { s: QuizMeState }) {
  if (!s.resumable) return null;
  const { stage, quiz } = s;
  const main = document.querySelector("main");
  return (
    <>
      {main && s.showResume && createPortal(<div aria-hidden className="h-14 sm:hidden" />, main)}
      {createPortal(
        <button
          type="button"
          hidden={!s.showResume}
          data-quizme
          onClick={() => (stage === "writing" ? s.setOpen(true) : s.resume())}
          className="fixed left-3.5 bottom-[calc(168px+env(safe-area-inset-bottom))] z-30 flex h-11 max-w-[calc(100vw-28px)] items-center gap-2 rounded-full bg-hero px-4 text-[14px] font-extrabold text-hero-foreground shadow-[0_8px_24px_rgba(22,22,22,.18)] sm:left-[80px] sm:bottom-6"
        >
          <Icon d={ICONS.review} size={16} />
          <span className="truncate">
            {stage === "writing" ? "Writing your quiz…" : `Resume your ${quiz!.kind === "lecture" ? "lecture review" : "quiz"} (${quiz!.left} of ${quiz!.questions.filter((x) => !x.hidden).length} left)`}
          </span>
        </button>,
        document.body,
      )}
    </>
  );
}
