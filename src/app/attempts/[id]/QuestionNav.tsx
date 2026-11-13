"use client";

import type { AttemptView } from "@/lib/attemptView";

/** The numbered squares: one per question, coloured once answered (right / wrong in Learn mode); a tap opens it. */
export function QuestionNav({ questions, index, tutor, goto }: { questions: AttemptView["questions"]; index: number; tutor: boolean; goto: (i: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 px-1" role="list" aria-label="Questions">
      {questions.map((x, i) => (
        <button
          key={x.id}
          role="listitem"
          onClick={() => goto(i)}
          aria-current={i === index ? "step" : undefined}
          aria-label={`Question ${i + 1}${x.chosen_index == null ? "" : tutor ? (x.correct ? ", right" : ", wrong") : ", answered"}`}
          className={`h-11 w-11 rounded-[12px] text-[13px] font-extrabold transition-colors ${
            x.chosen_index == null
              ? "bg-card text-muted-foreground"
              : tutor
                ? x.correct
                  ? "bg-mint text-on-mint"
                  : "bg-coral text-on-coral"
                : "bg-action text-action-foreground"
          } ${i === index ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}
