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
    <div className="flex flex-col gap-4">
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

      <label className="flex cursor-pointer items-start gap-3 rounded-[22px] bg-butter p-4 text-on-butter">
        <span className="min-w-0 flex-1">
          <span className="block text-base font-extrabold">Focus on my weak spots</span>
          <span className="mt-0.5 block text-sm font-medium">
            {adaptive
              ? "More questions on what you missed or weren't sure about, while still covering the rest."
              : "Questions spread evenly over the material. Only questions you got wrong come back."}
          </span>
          {(missed > 0 || (adaptive && unsure > 0)) && (
            <span className="mt-2 block text-sm font-bold">
              {missed > 0 && `↺ ${missed} missed question${missed === 1 ? "" : "s"} come${missed === 1 ? "s" : ""} back${missed > size * 0.4 ? " (some now, the rest next time)" : ""}.`}
              {adaptive && unsure > 0 && ` ${unsure} unsure idea${unsure === 1 ? "" : "s"} get new questions.`}
            </span>
          )}
        </span>
        <input type="checkbox" role="switch" className="peer sr-only" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} />
        <span
          aria-hidden
          className="relative mt-0.5 h-8 w-[54px] shrink-0 rounded-full bg-black/15 transition-colors peer-checked:bg-on-butter peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary after:absolute after:top-[3px] after:left-[3px] after:h-[26px] after:w-[26px] after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-[22px] peer-checked:after:bg-butter"
        />
      </label>

      <Choice label="Length" value={size} onChange={setSize} options={[[10, "10"], [25, "25"], [50, "50"]]} />
      <Choice label="Mode" value={mode} onChange={setMode} options={[["tutor", "Tutor"], ["timed", "Timed"]]} />
      <p className="-mt-2 text-[13px] text-muted-foreground">
        {mode === "tutor" ? "See the answer and explanation after each question." : "Exam conditions: a timer, and answers only at the end."}
      </p>
      <div>
        <label className="label" htmlFor="style">Question style</label>
        <select id="style" className="input" value={style} onChange={(e) => setStyle(e.target.value as typeof style)}>
          <option value="mixed">Mixed (recall, cases and images)</option>
          <option value="recall">Recall only</option>
          <option value="case">Clinical cases and images</option>
          <option value="caseset">Case sets, INBDE style</option>
        </select>
      </div>
      {error && <p className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">{error}</p>}
      <button className="btn-primary btn-lg w-full" onClick={start} disabled={busy || nothingChosen}>
        {busy ? "Starting…" : nothingChosen ? `Choose ${cover === "lectures" ? "a lecture" : "a topic"} first` : "Write my practice exam"}
      </button>
    </div>
  );
}

function CheckList({ items, selected, onChange }: { items: { id: number; label: string }[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const all = selected.length === items.length;
  return (
    <div className="mt-2 overflow-hidden rounded-[20px] border-2 border-foreground bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-[13px] font-bold text-muted-foreground">
        <span>{selected.length} selected</span>
        <button type="button" className="text-primary hover:underline" onClick={() => onChange(all ? [] : items.map((i) => i.id))}>
          {all ? "Clear" : "Select all"}
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto p-1.5">
        {items.map((item) => {
          const on = selected.includes(item.id);
          return (
            <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-[14px] px-2.5 py-2 text-[15px] font-medium hover:bg-muted">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={on}
                onChange={() => onChange(on ? selected.filter((x) => x !== item.id) : [...selected, item.id])}
              />
              <span
                aria-hidden
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg peer-focus-visible:outline-3 peer-focus-visible:outline-primary ${on ? "bg-hero text-hero-foreground" : "bg-muted"}`}
              >
                {on && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7" />
                  </svg>
                )}
              </span>
              {item.label}
            </label>
          );
        })}
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
    <div role="group" aria-label={label}>
      <div className="label">{label}</div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map(([v, text]) => (
          <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className="seg">
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
