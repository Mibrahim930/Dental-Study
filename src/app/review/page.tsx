"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { QuestionCard, type QuestionData } from "@/components/QuestionCard";
import { Icon, ICONS, Strip } from "@/components/ui";

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
  next?: { hard: string; good: string; easy: string };
};

const BUDGETS = [10, 20, 40] as const;

/** "tomorrow", "in 3 days", "in 2 weeks"… for the next time a card comes back. */
function when(iso: string | undefined): string {
  if (!iso) return "";
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  if (days <= 0) return "later today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

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
      <div className="mx-auto flex max-w-xl flex-col gap-2.5 sm:gap-4">
        <h1 className="page-title px-1">Daily review</h1>
        {due == null ? (
          <div className="card flex flex-col gap-3" aria-busy>
            <div className="shimmer h-6 w-1/2" />
            <div className="shimmer h-12 w-full" />
          </div>
        ) : due === 0 ? (
          <section className="tile cb-lilac flex flex-col gap-3 rounded-[28px]">
            <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-on-lilac text-lilac">
              <Icon d={ICONS.check} size={24} />
            </span>
            <div className="text-[26px] leading-tight font-extrabold tracking-tight">Nothing left to review.</div>
            <p className="text-[15px] font-medium">Questions you miss in practice exams come back here on a spaced schedule, right before you&apos;d forget them.</p>
            <Link href="/" className="btn-primary btn-sm self-start">Back to my exams</Link>
          </section>
        ) : (
          <section className="card-hero flex flex-col gap-4">
            <div>
              <div className="big-number">{due}</div>
              <div className="mt-1 text-[17px] font-bold">question{due === 1 ? "" : "s"} due</div>
            </div>
            <p className="text-[15px] text-hero-muted">How much time do you have?</p>
            <div className="grid grid-cols-3 gap-2">
              {BUDGETS.map((m) => (
                <button key={m} className="btn-hero btn-lg" onClick={() => start(m)}>
                  {m} min
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (index >= cards.length) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <section className="tile cb-lilac flex flex-col gap-3 rounded-[28px]">
          <div className="text-[30px] leading-tight font-extrabold tracking-tight">{done > 0 ? "Nice. That's your review done." : "Nothing to review."}</div>
          <p className="text-[15px] font-medium">
            You reviewed {done} question{done === 1 ? "" : "s"}. They&apos;ll come back right before you&apos;d forget them.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/" className="btn-primary btn-sm">Back to my exams</Link>
            <button
              className="btn btn-sm underline-offset-4 hover:underline"
              onClick={() => {
                setCards(null);
                setDue(null);
                fetch("/api/review?limit=0")
                  .then((r) => r.json())
                  .then((j) => setDue(j.due));
              }}
            >
              Review more
            </button>
          </div>
        </section>
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
    <div className="mx-auto flex max-w-3xl flex-col gap-2.5 sm:gap-3">
      <div className="flex items-center justify-between px-1">
        <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Daily review</h1>
        <span className="chip bg-card">
          {index + 1} of {cards.length}
        </span>
      </div>
      <Strip total={cards.length} filled={index} className="px-1" />
      <QuestionCard key={c.card_id} q={q} onChoose={chosen == null ? setChosen : undefined} />
      {chosen != null && (
        <section className="card flex flex-col gap-2.5">
          {correct ? (
            <>
              <span className="px-1 text-[13px] font-bold text-muted-foreground">How did that feel?</span>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["hard", "Hard", "cb-coral"],
                    ["good", "Good", "cb-butter"],
                    ["easy", "Easy", "cb-mint"],
                  ] as const
                ).map(([value, label, cls]) => (
                  <button key={value} className={`flex min-h-16 flex-col items-center justify-center rounded-[18px] transition-transform active:scale-[.97] ${cls}`} onClick={() => rate(true, value)}>
                    <span className="text-base font-extrabold">{label}</span>
                    {c.next && <span className="text-[12px] font-semibold opacity-80">{when(c.next[value])}</span>}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button className="btn-primary btn-lg" onClick={() => rate(false, "good")}>
              Next · you&apos;ll see this again soon
            </button>
          )}
        </section>
      )}
    </div>
  );
}
