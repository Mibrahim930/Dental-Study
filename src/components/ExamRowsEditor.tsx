"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { ExamKind } from "@/lib/db";
import { duplicateKey, EXAM_KINDS, isValidDate, KIND_LABEL } from "@/lib/calendar";
import { Icon, ICONS } from "./ui";

export type DraftRow = {
  key: string;
  include: boolean;
  name: string;
  date: string;
  kind: ExamKind;
  course: string;
  /** Set by the importers: how sure the reader was about the date, and anything it wanted to say. */
  confidence?: "high" | "medium" | "low";
  note?: string | null;
};

let keySeq = 0;
export const newRowKey = () => `r${Date.now().toString(36)}-${keySeq++}`;
export const blankRow = (): DraftRow => ({ key: newRowKey(), include: true, name: "", date: "", kind: "block", course: "" });

type Check = { errors: string[]; warnings: string[]; blank: boolean };

/**
 * The editable list of exams to add. "manual" is the "+ Add exams" table (add/remove rows); "confirm" is the check screen
 * after an import (tick boxes, "⚠ Check this date" on unsure rows). Both save with one "Add N exams" press, all at once.
 */
export function ExamRowsEditor({
  initial,
  existingKeys,
  today,
  mode,
}: {
  initial: DraftRow[];
  existingKeys: string[];
  today: string;
  mode: "manual" | "confirm";
}) {
  const router = useRouter();
  const [rows, setRows] = useState<DraftRow[]>(() => (initial.length ? initial : [blankRow(), blankRow(), blankRow()]));
  const [sameCourse, setSameCourse] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const existing = useMemo(() => new Set(existingKeys), [existingKeys]);

  const update = (key: string, patch: Partial<DraftRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  // Problems per row: errors block saving, warnings only ask her to look.
  const checks = new Map<string, Check>();
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.include && r.name.trim() && r.date) seen.set(duplicateKey(r.name, r.date), (seen.get(duplicateKey(r.name, r.date)) ?? 0) + 1);
  }
  for (const r of rows) {
    const blank = !r.name.trim() && !r.date && !r.course.trim();
    const c: Check = { errors: [], warnings: [], blank };
    if (r.include && !(blank && mode === "manual")) {
      if (!r.name.trim()) c.errors.push("Add a name.");
      if (!r.date) c.errors.push(mode === "confirm" ? "Add a date, or untick this one." : "Add a date.");
      else if (!isValidDate(r.date)) c.errors.push("That date doesn't exist.");
      else {
        if (r.date < today) c.warnings.push("This date has already passed.");
        if (r.name.trim() && (seen.get(duplicateKey(r.name, r.date)) ?? 0) > 1) c.warnings.push("Listed twice.");
      }
    }
    // Shown ticked or not, so she knows why a row arrived unticked.
    if (r.name.trim() && isValidDate(r.date) && existing.has(duplicateKey(r.name, r.date))) c.warnings.push("Already on your calendar.");
    checks.set(r.key, c);
  }
  const toAdd = rows.filter((r) => r.include && !(checks.get(r.key)!.blank && mode === "manual"));
  const hasErrors = toAdd.some((r) => checks.get(r.key)!.errors.length > 0);
  const n = toAdd.length;

  async function save() {
    if (n === 0 || hasErrors) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/calendar/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exams: toAdd.map((r) => ({ name: r.name, date: r.date, kind: r.kind, course: r.course.trim() || (mode === "manual" ? sameCourse : "") })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { added?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
      const firstYear = [...toAdd].sort((a, b) => a.date.localeCompare(b.date))[0].date.slice(0, 4);
      router.push(`/calendar?year=${firstYear}&added=${data.added ?? n}`);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Couldn't reach the site. Check your connection and try again.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="hidden gap-2 px-3 text-[13px] font-bold text-muted-foreground sm:flex">
        {mode === "confirm" && <span className="w-[30px]" />}
        <div className="grid flex-1 grid-cols-[minmax(0,2fr)_9.5rem_9rem_minmax(0,1.3fr)] gap-2">
          <span>Name</span>
          <span>Date</span>
          <span>Type</span>
          <span>Course</span>
        </div>
        <span className="w-9" />
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((r, i) => {
          const c = checks.get(r.key)!;
          const unsure = r.confidence === "low";
          return (
            <li key={r.key} className={`rounded-[20px] p-3 transition-opacity ${r.include ? "bg-muted" : "bg-muted/60 opacity-80"}`}>
              <div className="flex items-start gap-2">
                {mode === "confirm" && (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={r.include}
                    aria-label={`Add ${r.name || `exam ${i + 1}`}`}
                    onClick={() => update(r.key, { include: !r.include })}
                    className={`mt-1.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] ${r.include ? "bg-hero text-hero-foreground" : "bg-card"}`}
                  >
                    {r.include && <Icon d={ICONS.check} size={18} />}
                  </button>
                )}
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-[minmax(0,2fr)_9.5rem_9rem_minmax(0,1.3fr)]">
                  <input
                    className="input col-span-2 h-[42px] min-w-0 bg-card sm:col-span-1"
                    placeholder="Exam name, e.g. Endo Block 2"
                    aria-label={`Exam ${i + 1} name`}
                    aria-invalid={c.errors.includes("Add a name.") || undefined}
                    value={r.name}
                    maxLength={120}
                    onChange={(e) => update(r.key, { name: e.target.value })}
                  />
                  <input
                    type="date"
                    className={`input col-span-2 h-[42px] w-full min-w-0 bg-card px-2 sm:col-span-1 ${unsure ? "border-warning" : ""}`}
                    aria-invalid={c.errors.some((m) => /date/i.test(m)) || undefined}
                    aria-label={`Exam ${i + 1} date`}
                    value={r.date}
                    onChange={(e) => update(r.key, { date: e.target.value, confidence: r.confidence === "low" ? "medium" : r.confidence })}
                  />
                  <select className="input h-[42px] min-w-0 bg-card px-2" aria-label={`Exam ${i + 1} type`} value={r.kind} onChange={(e) => update(r.key, { kind: e.target.value as ExamKind })}>
                    {EXAM_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input h-[42px] min-w-0 bg-card"
                    placeholder={mode === "manual" && sameCourse ? sameCourse : "Course (optional)"}
                    aria-label={`Exam ${i + 1} course`}
                    value={r.course}
                    maxLength={80}
                    onChange={(e) => update(r.key, { course: e.target.value })}
                  />
                </div>
                {mode === "manual" && (
                  <button
                    type="button"
                    className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted-strong hover:text-foreground"
                    aria-label={`Remove row ${i + 1}`}
                    onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [blankRow()]))}
                  >
                    <span aria-hidden className="text-xl leading-none">×</span>
                  </button>
                )}
              </div>
              {(unsure || r.note || c.errors.length > 0 || c.warnings.length > 0) && (
                <div className={`flex flex-wrap items-center gap-1.5 pt-2 text-[13px] ${mode === "confirm" ? "sm:pl-[38px]" : ""}`}>
                  {unsure && <span className="chip cb-butter">⚠ Check this date</span>}
                  {c.errors.map((m) => (
                    <span key={m} className="font-semibold text-danger">
                      {m}
                    </span>
                  ))}
                  {c.warnings.map((m) => (
                    <span key={m} className="chip bg-card text-muted-foreground">
                      {m}
                    </span>
                  ))}
                  {r.note && <span className="text-muted-foreground">{r.note}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {mode === "manual" && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" className="btn-secondary btn-sm self-start" onClick={() => setRows((rs) => [...rs, blankRow()])}>
            <Icon d={ICONS.plus} size={16} /> Add row
          </button>
          <label className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            Same course for all
            <input className="input h-[42px] w-44 min-w-0" placeholder="e.g. Endodontics D2" value={sameCourse} maxLength={80} onChange={(e) => setSameCourse(e.target.value)} />
          </label>
        </div>
      )}

      <div className="flex flex-col gap-2 pt-1">
        <button type="button" className="btn-primary btn-lg w-full" disabled={saving || n === 0 || hasErrors} onClick={save}>
          {saving ? "Adding…" : n === 0 ? "Add exams" : `Add ${n} ${n === 1 ? "exam" : "exams"}`}
        </button>
        <p className="text-sm font-semibold text-danger empty:hidden" aria-live="polite">
          {hasErrors ? "Fix the rows marked in red first." : ""}
        </p>
        {error && (
          <p className="text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        )}
        <p className="text-[13px] text-muted-foreground">Each exam gets its own space for lectures; upload them whenever you&apos;re ready.</p>
      </div>
    </div>
  );
}
