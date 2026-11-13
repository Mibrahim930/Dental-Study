"use client";
import { Icon, ICONS } from "./ui";
import { FloatingPill, useSelectionPill } from "./useSelectionPill";
import { enoughToQuiz, quizPillPlace } from "./selection";
import { useQuizMe } from "./quizme/useQuizMe";
import { QuizMePanel } from "./quizme/QuizMePanel";
import { ResumeButton } from "./quizme/ResumeButton";

type Pill = { left: number; top: number; text: string };

/**
 * "Quiz me on this": select three or more words anywhere in the page's <main> (lesson, key points, explanations)
 * and a pill offers a short quiz on exactly that: 3, 5 or 10 questions written from the matching
 * slides, answered one at a time with a note on every option. Answers count toward mastery. An unfinished quiz is
 * kept and offered again ("Resume your quiz") the next time this exam's pages open.
 */
export function QuizMe({ examId, topicId, selection = true }: { examId: number; topicId?: number; /** Offer "Quiz me on this" on a text selection (off on pages with nothing to quiz on). */ selection?: boolean }) {
  const s = useQuizMe(examId, topicId);

  // The pill: shown under a selection of three or more words inside the page's <main> (not in a field or this panel).
  const { pill, hold, done: pillDone } = useSelectionPill<Pill>({
    enabled: selection,
    delay: 150,
    pillAttr: "data-quizme-pill",
    read: (r) => {
      const node = r?.commonAncestorContainer;
      const el = node ? (node instanceof Element ? node : node.parentElement) : null;
      if (!r || !el || !el.closest("main") || el.closest("input, textarea, [contenteditable='true'], [data-quizme]")) return null;
      const text = window.getSelection()?.toString() ?? "";
      if (!enoughToQuiz(text)) return null;
      const rect = r.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { ...quizPillPlace(rect, window.innerWidth, window.innerHeight), text };
    },
  });

  function fromPill() {
    const text = pill?.text ?? "";
    pillDone();
    s.fromSelection(text);
  }

  return (
    <>
      {pill && !s.open && (
        <FloatingPill data-quizme-pill className="fixed z-50 -translate-x-1/2" style={{ left: pill.left, top: pill.top }}>
          <button
            type="button"
            {...hold}
            onClick={(e) => {
              e.stopPropagation();
              fromPill();
            }}
            className="flex h-11 items-center gap-1.5 rounded-full bg-hero px-4 text-[14px] font-extrabold whitespace-nowrap text-hero-foreground shadow-[0_8px_24px_rgba(0,0,0,.25)]"
          >
            <Icon d={ICONS.check} size={16} />
            Quiz me on this
          </button>
        </FloatingPill>
      )}
      <ResumeButton s={s} />
      <QuizMePanel s={s} />
    </>
  );
}
