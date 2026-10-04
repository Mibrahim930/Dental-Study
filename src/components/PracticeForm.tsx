"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function PracticeForm({ examId, topics }: { examId: number; topics: { id: number; title: string }[] }) {
  const router = useRouter();
  const [size, setSize] = useState(25);
  const [mode, setMode] = useState<"tutor" | "timed">("tutor");
  const [style, setStyle] = useState<"mixed" | "recall" | "case">("mixed");
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const res = await fetch(`/api/exams/${examId}/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size, mode, style, topicIds: selected }),
    });
    const { id } = await res.json();
    router.push(`/attempts/${id}`);
  }

  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="space-y-4">
      <Choice label="Length" value={size} onChange={setSize} options={[[10, "10 questions"], [25, "25"], [50, "50"]]} />
      <Choice
        label="Mode"
        value={mode}
        onChange={setMode}
        options={[["tutor", "Tutor (explanations as you go)"], ["timed", "Timed (exam conditions)"]]}
      />
      <Choice
        label="Question style"
        value={style}
        onChange={setStyle}
        options={[["mixed", "Mixed"], ["recall", "Recall only"], ["case", "Case & image (board style)"]]}
      />
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600">
          Topics: {selected.length === 0 ? "all (weighted toward weak and emphasized topics)" : `${selected.length} selected`}
        </summary>
        <div className="mt-2 grid gap-1">
          {topics.map((t) => (
            <label key={t.id} className="flex items-center gap-2">
              <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
              {t.title}
            </label>
          ))}
        </div>
      </details>
      <button className="btn-primary" onClick={start} disabled={busy}>
        {busy ? "Starting…" : "Start practice exam"}
      </button>
    </div>
  );
}

function Choice<T extends string | number>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map(([v, text]) => (
          <button
            key={String(v)}
            type="button"
            onClick={() => onChange(v)}
            className={`btn ${value === v ? "bg-teal-700 text-white" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
