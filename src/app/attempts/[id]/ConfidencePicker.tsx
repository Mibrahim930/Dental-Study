"use client";

import type { AttemptView } from "@/lib/attemptView";
import type { Confidence } from "@/lib/practicePlan";

const CONFIDENCE_CHOICES: [Confidence, string, string][] = [
  ["guess", "Guessed", "bg-lilac text-on-lilac"],
  ["unsure", "Unsure", "bg-butter text-on-butter"],
  ["sure", "Confident", "bg-mint text-on-mint"],
];

/** Under the options: how sure she is, which locks in the picked answer (and the save error, if it didn't save). */
export function ConfidencePicker({
  q,
  current,
  pending,
  saving,
  saveError,
  lockIn,
}: {
  q: { id: number; chosen_index: number | null };
  current: AttemptView["questions"][number];
  pending: Record<number, number>;
  saving: boolean;
  saveError: { id: number; text: string } | null;
  lockIn: (confidence: Confidence) => void;
}) {
  const locked = q.chosen_index != null;
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <span className="px-1 text-[13px] font-bold text-muted-foreground">
        {locked ? "You said you were" : pending[q.id] != null ? "How sure are you? This locks in your answer." : "Pick an answer, then say how sure you are."}
      </span>
      <div className="grid grid-cols-3 gap-1.5">
        {CONFIDENCE_CHOICES.map(([value, label, chosenClass]) => {
          const isChosen = locked && current.confidence === value;
          return (
            <button
              key={value}
              type="button"
              disabled={locked || saving || pending[q.id] == null}
              aria-pressed={isChosen}
              onClick={() => lockIn(value)}
              className={`h-[52px] rounded-2xl text-[15px] font-bold transition-colors disabled:cursor-default ${
                isChosen ? chosenClass : locked ? "bg-muted text-muted-foreground opacity-60" : "bg-muted text-foreground hover:bg-muted-strong disabled:opacity-60"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {saveError?.id === q.id && (
        <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
          {saveError.text}
        </p>
      )}
    </div>
  );
}
