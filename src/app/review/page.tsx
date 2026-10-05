"use client";
import { useEffect, useState } from "react";
import { QuestionCard, type QuestionData } from "@/components/QuestionCard";

type Card = {
  card_id: number;
  id: number;
  type: "recall" | "case" | "image";
  patient_box: Record<string, string> | null;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  image: QuestionData["image"];
  source_page_id: number | null;
};

const BUDGETS = [
  [10, "10 min"],
  [20, "20 min"],
  [40, "40 min"],
] as const;

export default function ReviewPage() {
  const [due, setDue] = useState<number | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [done, setDone] = useState(0);

  useEffect(() => {
    fetch("/api/review?limit=0")
      .then((r) => r.json())
      .then((j) => setDue(j.due));
  }, []);

  async function start(minutes: number) {
    // About one minute per card.
    const res = await fetch(`/api/review?limit=${minutes}`);
    const j = await res.json();
    setCards(j.cards);
    setIndex(0);
    setChosen(null);
  }

  async function rate(correct: boolean, confidence: "hard" | "good" | "easy") {
    const card = cards![index];
    await fetch(`/api/review/${card.card_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correct, confidence }),
    });
    setDone((d) => d + 1);
    setChosen(null);
    setIndex((i) => i + 1);
  }

  if (!cards) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="page-title">Daily review</h1>
        <div className="card space-y-3">
          <p className="text-foreground">
            {due == null ? "Loading…" : due === 0 ? "Nothing due right now. Missed practice questions show up here on a spaced schedule." : `${due} question${due === 1 ? "" : "s"} due.`}
          </p>
          {!!due && (
            <>
              <p className="text-sm text-muted-foreground">How much time do you have?</p>
              <div className="flex gap-2">
                {BUDGETS.map(([m, label]) => (
                  <button key={m} className="btn-primary" onClick={() => start(m)}>{label}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (index >= cards.length) {
    return (
      <div className="card mx-auto max-w-xl space-y-3 text-center">
        <h1 className="text-xl font-semibold">Done for now 🎉</h1>
        <p className="text-muted-foreground">You reviewed {done} question{done === 1 ? "" : "s"}. They&apos;ll come back right before you&apos;d forget them.</p>
        <button className="btn-secondary" onClick={() => { setCards(null); setDue(null); fetch("/api/review?limit=0").then((r) => r.json()).then((j) => setDue(j.due)); }}>
          Back
        </button>
      </div>
    );
  }

  const c = cards[index];
  const q: QuestionData = {
    id: c.id,
    type: c.type,
    patient_box: c.patient_box,
    stem: c.stem,
    options: c.options,
    image: c.image,
    chosen_index: chosen,
    flagged: false,
    topic: null,
    concept: null,
    ...(chosen != null ? { correct_index: c.correct_index, explanation: c.explanation, source: null } : {}),
  };
  const correct = chosen === c.correct_index;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="text-sm text-muted-foreground">Card {index + 1} of {cards.length}</div>
      <QuestionCard key={c.card_id} q={q} onChoose={chosen == null ? setChosen : undefined} />
      {chosen != null && (
        <div className="card flex flex-wrap items-center gap-2">
          {correct ? (
            <>
              <span className="mr-2 text-sm text-muted-foreground">How did that feel?</span>
              <button className="btn-secondary" onClick={() => rate(true, "hard")}>Hard</button>
              <button className="btn-primary" onClick={() => rate(true, "good")}>Good</button>
              <button className="btn-secondary" onClick={() => rate(true, "easy")}>Easy</button>
            </>
          ) : (
            <button className="btn-primary" onClick={() => rate(false, "good")}>Next (you&apos;ll see this again soon)</button>
          )}
        </div>
      )}
    </div>
  );
}
