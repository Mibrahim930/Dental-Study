"use client";
import type { Range } from "@/lib/marks";
import { Highlightable } from "./Highlightable";
import { optionClasses, type OptionState } from "./ui";

/**
 * One answer option, shared by practice exams and section quizzes. Not a <button>, so its text can be selected and
 * highlighted; it behaves as a radio (click, Enter or Space picks it; arrow keys move; "x" crosses it out).
 * A drag to select text never picks the answer.
 */
export function OptionRow({
  index,
  text,
  state,
  checked,
  onSelect,
  crossed,
  onToggleCross,
  ranges,
  onRanges,
  chips,
}: {
  index: number;
  text: string;
  state: OptionState;
  /** Shown as the student's pick (before the answer is revealed). */
  checked: boolean;
  /** Pick it; omitted when the question can't be answered (already answered or a review). */
  onSelect?: () => void;
  crossed: boolean;
  onToggleCross?: () => void;
  ranges: Range[];
  onRanges?: (r: Range[]) => void;
  chips?: React.ReactNode;
}) {
  const s = optionClasses(state);
  const letter = String.fromCharCode(65 + index);

  function pick() {
    // A drag or double-click to select words is for highlighting, not answering.
    if (window.getSelection()?.toString()) return;
    onSelect?.();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.();
    } else if ((e.key === "x" || e.key === "X") && onToggleCross) {
      e.preventDefault();
      onToggleCross();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
      const next = rows[rows.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  }

  return (
    <div
      role="radio"
      aria-checked={checked}
      aria-disabled={!onSelect}
      aria-label={`${letter}. ${text}${crossed ? " (crossed out)" : ""}`}
      tabIndex={0}
      onClick={pick}
      onKeyDown={onKeyDown}
      className={`flex min-h-[58px] items-center gap-3 rounded-[18px] border-2 py-2 pr-2 pl-3.5 text-left transition-colors ${onSelect ? "cursor-pointer" : "cursor-default"} ${s.row}`}
    >
      <span
        aria-hidden
        className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] text-sm font-extrabold transition-opacity ${s.key} ${crossed ? "opacity-40" : ""}`}
      >
        {letter}
      </span>
      <Highlightable
        text={text}
        ranges={ranges}
        onChange={onRanges}
        className={`flex-1 py-1 text-base leading-snug font-semibold ${crossed ? "line-through decoration-2 opacity-60" : ""}`}
      />
      {chips}
      {onToggleCross && (
        <button
          type="button"
          aria-label={crossed ? `Undo cross-out of option ${letter}` : `Cross out option ${letter}`}
          aria-pressed={crossed}
          title={crossed ? "Undo cross-out" : "Cross out"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCross();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-[15px] font-extrabold transition-colors ${
            crossed ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted-strong hover:text-foreground"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
            {crossed ? <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" /> : <path d="M6 6l12 12M18 6L6 18" />}
          </svg>
        </button>
      )}
    </div>
  );
}
