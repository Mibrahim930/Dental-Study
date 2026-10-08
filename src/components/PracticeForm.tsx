"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

type TopicOption = { id: number; title: string; lectureIds: number[]; missed: number; unsure: number };
type Cover = "all" | "lectures" | "topics";

export function PracticeForm({
  examId,
  topics,
  lectures,
  focusWeak,
}: {
  examId: number;
  topics: TopicOption[];
  lectures: { id: number; name: string }[];
  focusWeak: boolean;
}) {
  const router = useRouter();
  const [size, setSize] = useState(25);
  const [mode, setMode] = useState<"tutor" | "timed">("tutor");
  const [style, setStyle] = useState<"mixed" | "recall" | "case" | "caseset">("mixed");
  const [cover, setCover] = useState<Cover>("all");
  const [lectureIds, setLectureIds] = useState<number[]>([]);
  const [topicIds, setTopicIds] = useState<number[]>([]);
  const [adaptive, setAdaptive] = useState(focusWeak);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const inScope =
    cover === "all" ? topics : cover === "lectures" ? topics.filter((t) => t.lectureIds.some((l) => lectureIds.includes(l))) : topics.filter((t) => topicIds.includes(t.id));
  const missed = inScope.reduce((n, t) => n + t.missed, 0);
  const unsure = inScope.reduce((n, t) => n + t.unsure, 0);
  const nothingChosen = cover !== "all" && inScope.length === 0;

  async function start() {
    setBusy(true);
    setError("");
    const scope = cover === "lectures" ? { kind: "lectures", documentIds: lectureIds } : cover === "topics" ? { kind: "topics", topicIds } : { kind: "all" };
    const res = await fetch(`/api/exams/${examId}/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size, mode, style, scope, adaptive }),
    });
    const json = await res.json();
    if (!res.ok) {
      setBusy(false);
      return setError(json.error ?? "Couldn't start the exam.");
    }
    router.push(`/attempts/${json.id}`);
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="label" htmlFor="cover">What to cover</label>
        <select id="cover" className="input" value={cover} onChange={(e) => setCover(e.target.value as Cover)}>
          <option value="all">Entire exam{lectures.length > 1 ? ` (all ${lectures.length} lectures)` : ""}</option>
          {lectures.length > 1 && <option value="lectures">Choose lectures…</option>}
          <option value="topics">Choose topics…</option>
        </select>
        {cover === "lectures" && (
          <CheckList items={lectures.map((l) => ({ id: l.id, label: l.name }))} selected={lectureIds} onChange={setLectureIds} />
        )}
        {cover === "topics" && <CheckList items={topics.map((t) => ({ id: t.id, label: t.title }))} selected={topicIds} onChange={setTopicIds} />}
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
        <input type="checkbox" role="switch" className="peer sr-only" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} />
        <span
          aria-hidden
          className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-muted-strong transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-card after:shadow after:transition-transform peer-checked:after:translate-x-4"
        />
        <span className="text-sm">
          <span className="font-medium">Focus on my weak spots</span>
          <span className="mt-0.5 block text-muted-foreground">
            {adaptive
              ? "More questions on what you missed or weren't sure about, while still covering the rest."
              : "Questions spread evenly over the material. Only questions you got wrong come back."}
          </span>
        </span>
      </label>

      {(missed > 0 || (adaptive && unsure > 0)) && (
        <p className="rounded-lg bg-primary-soft px-3 py-2 text-sm text-primary">
          {missed > 0 && `${missed} question${missed === 1 ? "" : "s"} you missed will come back${missed > size * 0.4 ? " (some now, the rest next time)" : ""}.`}
          {adaptive && unsure > 0 && ` ${unsure} idea${unsure === 1 ? "" : "s"} you weren't sure about will be tested with new questions.`}
        </p>
      )}

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
        options={[["mixed", "Mixed"], ["recall", "Recall only"], ["case", "Case & image"], ["caseset", "Case sets (INBDE)"]]}
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn-primary" onClick={start} disabled={busy || nothingChosen}>
        {busy ? "Starting…" : nothingChosen ? `Choose ${cover === "lectures" ? "a lecture" : "a topic"} first` : "Start practice exam"}
      </button>
    </div>
  );
}

function CheckList({ items, selected, onChange }: { items: { id: number; label: string }[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const all = selected.length === items.length;
  return (
    <div className="mt-2 rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>{selected.length} selected</span>
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => onChange(all ? [] : items.map((i) => i.id))}>
          {all ? "Clear" : "Select all"}
        </button>
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto p-1.5">
        {items.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              checked={selected.includes(item.id)}
              onChange={() => onChange(selected.includes(item.id) ? selected.filter((x) => x !== item.id) : [...selected, item.id])}
            />
            {item.label}
          </label>
        ))}
      </div>
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
            className={`btn ${value === v ? "bg-primary text-primary-foreground" : "border border-input bg-card text-foreground hover:bg-muted"}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
