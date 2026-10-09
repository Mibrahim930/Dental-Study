"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { SlideImage, type CropBox } from "./SlideImage";
import { optionClasses, type OptionState } from "./ui";

export type QuestionData = {
  id: number;
  type: "recall" | "case" | "image";
  patient_box: Record<string, string> | null;
  stem: string;
  options: string[];
  image: { page_id: number; aspect: number; crop: unknown } | null;
  chosen_index: number | null;
  confidence?: "guess" | "unsure" | "sure" | null;
  flagged: boolean;
  topic: string | null;
  concept: string | null;
  caseInfo?: { number: number; index: number; size: number; scenario: string } | null;
  correct_index?: number;
  explanation?: string;
  source?: { page_id: number; filename: string | null; page_number: number | null } | null;
};

const BOX_LABELS: Record<string, string> = {
  patient: "Patient",
  chief_complaint: "Chief complaint",
  medical_history: "Medical history",
  medications: "Medications",
  allergies: "Allergies",
  dental_history: "Dental history",
  findings: "Findings",
};

const CONFIDENCE_TEXT = { guess: "You guessed", unsure: "You were unsure", sure: "You were confident" } as const;

/**
 * One question, laid out as separate blocks: the case (lilac), the patient box, the clinical image,
 * the question with its options, then the explanation (teal) once revealed.
 */
export function QuestionCard({
  q,
  onChoose,
  pending,
  header,
  tag,
  belowOptions,
  practice = false,
}: {
  q: QuestionData;
  onChoose?: (i: number) => void;
  pending?: number | null;
  header?: React.ReactNode;
  /** Small label such as "↺ Missed last time", shown on the case block (or above the question). */
  tag?: React.ReactNode;
  belowOptions?: React.ReactNode;
  /** In a practice exam, a missed question comes back in the next exam; say so under the explanation. */
  practice?: boolean;
}) {
  const revealed = q.correct_index != null;
  const selected = q.chosen_index ?? pending ?? null;
  const [showSource, setShowSource] = useState(false);
  const [flagged, setFlagged] = useState(q.flagged);

  async function flag() {
    const note = window.prompt("What's wrong with this question? (optional)") ?? undefined;
    await fetch(`/api/questions/${q.id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    setFlagged(true);
  }

  const stateOf = (i: number): OptionState =>
    revealed ? (i === q.correct_index ? "correct" : i === selected ? "wrong" : "dim") : i === selected ? "selected" : "default";

  return (
    <>
      {q.caseInfo && (
        <section className="tile cb-lilac flex flex-col gap-2 rounded-[28px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-extrabold">
              Case set {q.caseInfo.number} · question {q.caseInfo.index} of {q.caseInfo.size}
            </span>
            {tag}
          </div>
          <p className="text-base leading-normal font-medium">{q.caseInfo.scenario}</p>
        </section>
      )}

      {q.patient_box && (
        <section aria-label="Patient" className="card flex flex-col py-1.5">
          {Object.entries(q.patient_box).map(([k, v], i, all) => (
            <div key={k} className={`grid grid-cols-[112px_minmax(0,1fr)] gap-2.5 py-3 sm:grid-cols-[160px_minmax(0,1fr)] ${i < all.length - 1 ? "border-b border-border" : ""}`}>
              <span className="text-[13px] font-bold text-muted-foreground">{BOX_LABELS[k] ?? k}</span>
              <span className={`text-[15px] leading-relaxed ${k === "allergies" ? "font-bold" : ""}`}>{v}</span>
            </div>
          ))}
        </section>
      )}

      {q.image && (
        <figure className="overflow-hidden rounded-[22px] bg-slide p-1.5">
          <SlideImage
            pageId={q.image.page_id}
            aspect={q.image.aspect}
            crop={revealed ? null : (q.image.crop as CropBox | null)}
            alt="Clinical image for this question"
          />
        </figure>
      )}

      <section className="card flex flex-col gap-2.5">
        {header}
        {tag && !q.caseInfo && <div>{tag}</div>}
        <p className="mx-1 mb-1.5 text-[18px] leading-snug font-bold sm:text-[20px]">{q.stem}</p>
        {q.options.map((o, i) => {
          const s = optionClasses(stateOf(i));
          return (
            <button
              key={i}
              disabled={!onChoose}
              onClick={() => onChoose?.(i)}
              aria-pressed={!revealed && onChoose ? i === selected : undefined}
              className={`flex min-h-[58px] items-center gap-3 rounded-[18px] border-2 px-3.5 py-3 text-left transition-colors disabled:cursor-default ${s.row}`}
            >
              <span className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] text-sm font-extrabold ${s.key}`}>
                {String.fromCharCode(65 + i)}
              </span>
              <span className="flex-1 text-base leading-snug font-semibold">{o}</span>
              {revealed && i === q.correct_index && <span className="chip cb-mint shrink-0">✓ Correct</span>}
              {revealed && i === selected && i !== q.correct_index && <span className="chip cb-coral shrink-0">✗ Your answer</span>}
            </button>
          );
        })}
        {belowOptions}
      </section>

      {revealed && (
        <section className="rounded-[28px] bg-hero p-5 text-hero-foreground sm:p-6">
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-extrabold text-mint">
            {selected === q.correct_index ? "✓ Correct" : selected == null ? "Not answered" : `✗ Why ${String.fromCharCode(65 + q.correct_index!)}`}
            {q.confidence && <span className="font-semibold text-hero-muted">· {CONFIDENCE_TEXT[q.confidence]}</span>}
          </div>
          <div className="mt-1.5 text-base leading-relaxed [&_p]:my-1.5 [&_strong]:font-extrabold">
            <ReactMarkdown>{q.explanation ?? ""}</ReactMarkdown>
          </div>
          {practice && selected != null && selected !== q.correct_index && (
            <p className="mt-2 text-[15px] text-hero-muted">This comes back in your next practice exam with the choices shuffled.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5">
            {q.source ? (
              <button className="text-sm font-extrabold text-mint" onClick={() => setShowSource((s) => !s)}>
                Source: {q.source.filename}, slide {q.source.page_number} {showSource ? "↑" : "→"}
              </button>
            ) : (
              <span />
            )}
            <button className="text-[13px] font-semibold text-hero-muted underline-offset-4 hover:underline" onClick={flag} disabled={flagged}>
              {flagged ? "Reported. Thanks!" : "Report a problem"}
            </button>
          </div>
          {q.concept && <div className="mt-2 text-[13px] text-hero-muted">Concept: {q.concept}</div>}
          {showSource && q.source && (
            <div className="mt-3 overflow-hidden rounded-[18px] bg-slide p-1.5">
              <SlideImage pageId={q.source.page_id} alt="Source slide" />
            </div>
          )}
        </section>
      )}
    </>
  );
}
