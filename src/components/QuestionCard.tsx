"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { SlideImage, type CropBox } from "./SlideImage";

export type QuestionData = {
  id: number;
  type: "recall" | "case" | "image";
  patient_box: Record<string, string> | null;
  stem: string;
  options: string[];
  image: { page_id: number; aspect: number; crop: unknown } | null;
  chosen_index: number | null;
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

export function QuestionCard({
  q,
  onChoose,
  pending,
  header,
}: {
  q: QuestionData;
  onChoose?: (i: number) => void;
  pending?: number | null;
  header?: React.ReactNode;
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

  return (
    <div className="card space-y-4">
      {header}
      {q.caseInfo && (
        <div className="rounded-lg bg-info-soft px-3 py-2 text-sm text-info">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-info">
            Case {q.caseInfo.number} · Question {q.caseInfo.index} of {q.caseInfo.size}
          </div>
          {q.caseInfo.scenario}
        </div>
      )}
      {q.patient_box && (
        <dl className="grid gap-x-4 gap-y-1 rounded-lg border border-info/30 bg-info-soft p-3 text-sm sm:grid-cols-[150px_1fr]">
          {Object.entries(q.patient_box).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-medium text-info">{BOX_LABELS[k] ?? k}</dt>
              <dd className="text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {q.image && (
        <SlideImage
          pageId={q.image.page_id}
          aspect={q.image.aspect}
          crop={revealed ? null : (q.image.crop as CropBox | null)}
          alt="Clinical image for this question"
        />
      )}
      <p className="text-[15px] font-medium leading-relaxed">{q.stem}</p>
      <div className="grid gap-2">
        {q.options.map((o, i) => {
          let style = "border-input hover:bg-muted";
          if (revealed) {
            if (i === q.correct_index) style = "border-success bg-success-soft";
            else if (i === selected) style = "border-danger bg-danger-soft";
            else style = "border-border text-muted-foreground";
          } else if (i === selected) style = "border-primary bg-primary-soft";
          return (
            <button
              key={i}
              disabled={!onChoose}
              onClick={() => onChoose?.(i)}
              className={`rounded-lg border px-3 py-2 text-left text-sm disabled:cursor-default ${style}`}
            >
              <span className="mr-2 font-medium">{String.fromCharCode(65 + i)}.</span>
              {o}
            </button>
          );
        })}
      </div>
      {revealed && (
        <div className="space-y-2 rounded-lg bg-muted p-3 text-sm">
          <p className="font-semibold">{selected === q.correct_index ? "✓ Correct" : selected == null ? "Not answered" : "✗ Incorrect"}</p>
          <div className="prose-study text-sm">
            <ReactMarkdown>{q.explanation ?? ""}</ReactMarkdown>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {q.concept && <span>Concept: {q.concept}</span>}
            {q.source && (
              <button className="text-primary underline" onClick={() => setShowSource((s) => !s)}>
                Source: {q.source.filename}, slide {q.source.page_number}
              </button>
            )}
            <button className="ml-auto text-muted-foreground underline" onClick={flag} disabled={flagged}>
              {flagged ? "Reported. Thanks!" : "Report a problem"}
            </button>
          </div>
          {showSource && q.source && <SlideImage pageId={q.source.page_id} alt="Source slide" />}
        </div>
      )}
    </div>
  );
}
