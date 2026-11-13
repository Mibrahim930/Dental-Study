"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { SlideImage, type CropBox } from "./SlideImage";
import { type OptionState } from "./ui";
import { OptionRow } from "./OptionRow";
import { Highlightable } from "./Highlightable";
import { useMarks } from "./useMarks";
import { signedOut } from "./clientFetch";
import { ReportQuestion } from "./ReportQuestion";

export type QuestionData = {
  id: number;
  type: "recall" | "case" | "image";
  patient_box: Record<string, string> | null;
  stem: string;
  options: string[];
  image: { page_id: number; aspect: number; crop: unknown } | null;
  chosen_index: number | null;
  confidence?: "guess" | "unsure" | "sure" | null;
  /** Written from a slide she emphasized in her notes. */
  emphasized?: boolean;
  flagged: boolean;
  topic: string | null;
  concept: string | null;
  caseInfo?: { number: number; index: number; size: number; scenario: string } | null;
  correct_index?: number;
  explanation?: string;
  /** One line per option (display order): why right / why wrong. Older questions have none. */
  option_notes?: string[] | null;
  source?: { page_id: number; filename: string | null; page_number: number | null; aspect?: number | null } | null;
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

/**
 * What the card needs to draw a question. Practice exams and the daily review pass a whole QuestionData; the section
 * quiz and the quiz panel (`bare`) pass just the question, with `correct_index` set only once it's answered.
 */
export type CardQuestion = Pick<QuestionData, "stem" | "options" | "chosen_index"> & Partial<Omit<QuestionData, "stem" | "options" | "chosen_index">>;

const CONFIDENCE_TEXT = { guess: "You guessed", unsure: "You were unsure", sure: "You were confident" } as const;

/**
 * The explanation under an answered question, the same everywhere: "✓ Correct", or "✗ Why B" when she missed it.
 * `compact` is the smaller block used inside the section quiz and the quiz panel; `aside` sits beside the heading and
 * `children` under the text.
 */
export function Explanation({
  chosen,
  correctIndex,
  explanation,
  compact = false,
  aside,
  children,
}: {
  chosen: number | null;
  correctIndex: number;
  explanation: string;
  compact?: boolean;
  aside?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const Box = compact ? "div" : "section";
  return (
    <Box className={`bg-hero text-hero-foreground ${compact ? "rounded-[22px] p-5" : "rounded-[28px] p-5 sm:p-6"}`}>
      <div className="flex flex-wrap items-center gap-2 text-[13px] font-extrabold text-hero-accent">
        {chosen === correctIndex ? "✓ Correct" : chosen == null ? "Not answered" : `✗ Why ${String.fromCharCode(65 + correctIndex)}`}
        {aside}
      </div>
      <div className="mt-1.5 text-base leading-relaxed break-words [&_p]:my-1.5 [&_strong]:font-extrabold">
        <ReactMarkdown>{explanation}</ReactMarkdown>
      </div>
      {children}
    </Box>
  );
}

/**
 * One question, laid out as separate blocks: the case (lilac), the patient box, the clinical image,
 * the question with its options, then the explanation (teal) once revealed.
 *
 * The card draws; the caller runs the answering (practice: pick, then say how sure; daily review: reveal on tap; section
 * quiz and quiz panel: pick, then "Check answer") and passes in where it stands: `q.chosen_index` (her answer),
 * `pending` (picked, not yet checked), `q.correct_index` (set once revealed) and `onChoose` (left out once she can't pick).
 * `bare` is for a question inside the section quiz or the quiz panel, which draw their own frame, header and Report.
 */
export function QuestionCard({
  q,
  onChoose,
  pending,
  header,
  tag,
  belowOptions,
  practice = false,
  marksKey = null,
  onReport,
  reportContext,
  bare = false,
  locked = false,
}: {
  q: CardQuestion;
  onChoose?: (i: number) => void;
  pending?: number | null;
  header?: React.ReactNode;
  /** Small label such as "↺ Missed last time", shown on the case block (or above the question). */
  tag?: React.ReactNode;
  belowOptions?: React.ReactNode;
  /** In a practice exam, a missed question comes back in the next exam; say so under the explanation. */
  practice?: boolean;
  /** Where the student's highlights and cross-outs on this question are saved (e.g. "attempt:12:345"). */
  marksKey?: string | null;
  /**
   * What "Report" does: the caller removes the question from where it's shown (and its score). Without it, the
   * question is flagged everywhere (daily review, an old results page) and the card hides itself.
   */
  onReport?: (reason: string) => Promise<void>;
  /** Where a reported question leaves, for the Report dialog's wording ("this practice exam and its score", "today's review"). */
  reportContext?: string;
  /** No card around the stem and options and no Report button (the caller has its own), and the smaller explanation. */
  bare?: boolean;
  /** Picking is paused for a moment (an answer is being saved, or the questions are being rewritten). */
  locked?: boolean;
}) {
  const revealed = q.correct_index != null;
  const selected = q.chosen_index ?? pending ?? null;
  const [showSource, setShowSource] = useState(false);
  const [flagged, setFlagged] = useState(q.flagged ?? false);
  const report =
    onReport ??
    (async (reason: string) => {
      const res = await fetch(`/api/questions/${q.id}/flag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      if (signedOut(res)) return;
      if (!res.ok) throw new Error(String(res.status));
      setFlagged(true);
    });
  const [marks, setMarks] = useMarks(marksKey);
  const hl = (field: string) => ({
    ranges: marks.hl[field] ?? [],
    onRanges: (r: typeof marks.hl[string]) => setMarks((m) => ({ ...m, hl: { ...m.hl, [field]: r } })),
  });
  const hlProps = (h: ReturnType<typeof hl>) => ({ ranges: h.ranges, onChange: h.onRanges });
  const toggleCross = (i: number) =>
    setMarks((m) => ({ ...m, crossed: m.crossed.includes(i) ? m.crossed.filter((x) => x !== i) : [...m.crossed, i].sort() }));
  const choose = (i: number) => {
    // Picking a crossed-out option un-crosses it.
    if (marks.crossed.includes(i)) toggleCross(i);
    onChoose?.(i);
  };

  const stateOf = (i: number): OptionState =>
    revealed ? (i === q.correct_index ? "correct" : i === selected ? "wrong" : "dim") : i === selected ? "selected" : "default";

  const image = q.image && (
    <figure className="overflow-hidden rounded-[22px] bg-slide p-1.5">
      <SlideImage
        pageId={q.image.page_id}
        aspect={q.image.aspect}
        crop={revealed ? null : (q.image.crop as CropBox | null)}
        alt={bare ? "Picture for this question" : "Clinical image for this question"}
      />
    </figure>
  );
  const options = (
    <div role="radiogroup" aria-label="Answer choices" className={`flex flex-col ${bare ? "gap-2" : "gap-2.5"}`}>
      {q.options.map((o, i) => (
        <OptionRow
          key={i}
          index={i}
          text={o}
          state={stateOf(i)}
          checked={i === selected}
          onSelect={onChoose && !locked ? () => choose(i) : undefined}
          crossed={marks.crossed.includes(i)}
          // The option she has picked can't also be crossed out.
          onToggleCross={onChoose && i === selected ? undefined : () => toggleCross(i)}
          note={revealed ? q.option_notes?.[i] : undefined}
          {...hl(`opt${i}`)}
          chips={
            <>
              {revealed && i === q.correct_index && <span className="chip cb-mint shrink-0">✓ Correct</span>}
              {revealed && i === selected && i !== q.correct_index && <span className="chip cb-coral shrink-0">✗ Your answer</span>}
            </>
          }
        />
      ))}
    </div>
  );

  if (bare) {
    return (
      <>
        {image}
        <p className="px-1 text-[18px] leading-snug font-bold break-words">
          <Highlightable text={q.stem} {...hlProps(hl("stem"))} />
        </p>
        {options}
        {belowOptions}
        {revealed && q.explanation && <Explanation compact chosen={selected} correctIndex={q.correct_index!} explanation={q.explanation} />}
      </>
    );
  }

  if (flagged && !q.flagged) {
    return (
      <section className="card">
        <p className="text-[15px] font-semibold text-muted-foreground">Reported. This question won&apos;t be shown again.</p>
      </section>
    );
  }

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
          <p className="text-base leading-normal font-medium">
            <Highlightable text={q.caseInfo.scenario} {...hlProps(hl("case"))} />
          </p>
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

      {image}

      <section className="card flex flex-col gap-2.5">
        {header}
        {tag && !q.caseInfo && <div>{tag}</div>}
        {q.emphasized && <span className="chip cb-coral self-start">★ You emphasized this</span>}
        <p className="mx-1 mb-1.5 text-[18px] leading-snug font-bold sm:text-[20px]">
          <Highlightable text={q.stem} {...hlProps(hl("stem"))} />
        </p>
        {options}
        {belowOptions}
        <div className="-mb-1 flex justify-end">
          <ReportQuestion onReport={report} context={reportContext} />
        </div>
      </section>

      {revealed && (
        <Explanation
          chosen={selected}
          correctIndex={q.correct_index!}
          explanation={q.explanation ?? ""}
          aside={q.confidence && <span className="font-semibold text-hero-muted">· {CONFIDENCE_TEXT[q.confidence]}</span>}
        >
          {practice && selected != null && selected !== q.correct_index && (
            <p className="mt-2 text-[15px] text-hero-muted">This comes back in your next practice exam with the choices shuffled.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5">
            {q.source ? (
              <button className="-my-2.5 min-h-11 text-left text-sm font-extrabold text-hero-accent" aria-expanded={showSource} onClick={() => setShowSource((s) => !s)}>
                Source: {q.source.filename}, slide {q.source.page_number} {showSource ? "↑" : "→"}
              </button>
            ) : (
              <span />
            )}
            <span />
          </div>
          {q.concept && <div className="mt-2 text-[13px] text-hero-muted">Concept: {q.concept}</div>}
          {showSource && q.source && (
            <div className="mt-3 overflow-hidden rounded-[18px] bg-slide p-1.5">
              <SlideImage pageId={q.source.page_id} aspect={q.source.aspect ?? undefined} alt="Source slide" />
            </div>
          )}
        </Explanation>
      )}
    </>
  );
}
