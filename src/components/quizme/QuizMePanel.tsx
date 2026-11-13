"use client";
import { Dialog } from "../Dialog";
import { Icon, ICONS } from "../ui";
import { ChooseSize, QuestionStep, RoundBreak, Score, Writing } from "./stages";
import type { QuizMeState } from "./useQuizMe";

/** The quiz panel: a bottom sheet on a phone, a card in the corner on wider screens. Shows whichever stage it's on. */
export function QuizMePanel({ s }: { s: QuizMeState }) {
  const { stage, quiz, index, total, nextRound, shown } = s;
  let body: React.ReactNode;
  if (stage === "writing") body = <Writing size={s.writingSize} />;
  else if (stage === "quiz" && quiz && index >= total && nextRound) body = <RoundBreak s={s} />;
  else if (stage === "quiz" && quiz && index >= total) body = <Score s={s} />;
  else if (stage === "quiz" && quiz && shown[index]) body = <QuestionStep s={s} />;
  else body = <ChooseSize s={s} />;

  return (
    // Escape, a tap beside it or Close shut it; focus goes back where it was ("Resume your quiz" stays on the page,
    // hidden, while it's open). The page behind stays scrollable beside the corner card on a wider screen.
    <Dialog open={s.open} onClose={s.close} label={s.title} variant="sheet" lockScroll="narrow" data-quizme>
      <div className="flex items-start justify-between gap-2">
        <h2 id="quizme-title" className="text-[18px] font-extrabold tracking-tight">
          {s.title}
        </h2>
        <button type="button" onClick={s.close} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted" aria-label="Close">
          <Icon d={ICONS.close} size={18} />
        </button>
      </div>
      {body}
    </Dialog>
  );
}
