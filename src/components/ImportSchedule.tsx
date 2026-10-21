"use client";
import { useRef, useState } from "react";
import type { ExamKind } from "@/lib/db";
import { duplicateKey } from "@/lib/calendar";
import { ExamRowsEditor, newRowKey, type DraftRow } from "./ExamRowsEditor";
import { Icon, ICONS } from "./ui";

/** Keep in step with MAX_IMPORT_MB in /api/calendar/import/read. */
const MAX_IMPORT_MB = 20;
const MAX_FILES = 4;

export type FoundExam = { name: string; date: string | null; course: string | null; kind: ExamKind; confidence: "high" | "medium" | "low"; note: string | null };

type Found = { rows: DraftRow[]; notes: string[]; source: "ai" | "ics" };

/** Turn what an importer found into editable rows: exams already on the calendar, or without a date, start unticked. */
export function toRows(found: FoundExam[], existingKeys: Set<string>): DraftRow[] {
  return found.map((e) => ({
    key: newRowKey(),
    include: e.date != null && !existingKeys.has(duplicateKey(e.name, e.date)),
    name: e.name,
    date: e.date ?? "",
    kind: e.kind,
    course: e.course ?? "",
    confidence: e.confidence,
    note: e.note,
  }));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The import screen: paste or snap a schedule → check the list → "Add N exams". */
export function ImportSchedule({ existingKeys, today }: { existingKeys: string[]; today: string }) {
  const [found, setFound] = useState<Found | null>(null);
  const [round, setRound] = useState(0);

  if (found) {
    const n = found.rows.length;
    return (
      <div className="flex flex-col gap-4">
        <section className="card flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="section-title">
                We found {plural(n, "exam", "exams")}. Untick any that aren&apos;t yours.
              </h2>
              {found.notes.map((note) => (
                <p key={note} className="text-[15px] text-muted-foreground">
                  {note}
                </p>
              ))}
            </div>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setFound(null)}>
              <Icon d={ICONS.arrowLeft} size={16} /> Start over
            </button>
          </div>
          <ExamRowsEditor key={round} initial={found.rows} existingKeys={existingKeys} today={today} mode="confirm" />
        </section>
      </div>
    );
  }

  const show = (f: Found) => {
    setRound((r) => r + 1);
    setFound(f);
  };
  return (
    <div className="flex flex-col gap-4">
      <PasteOrSnap existingKeys={existingKeys} onFound={show} />
      <CalendarFile existingKeys={existingKeys} onFound={show} />
    </div>
  );
}

type IcsEvent = { name: string; date: string; course: string | null; kind: ExamKind; looksLikeExam: boolean; past: boolean; recurring: boolean };

/** Which events go to the check screen: exam-like upcoming ones by default; the toggles add the rest (unticked unless exam-like). */
export function icsRows(events: IcsEvent[], opts: { showAll: boolean; includePast: boolean }, existingKeys: Set<string>): DraftRow[] {
  return events
    .filter((e) => (opts.showAll || e.looksLikeExam) && (opts.includePast || !e.past))
    .map((e) => ({
      key: newRowKey(),
      include: e.looksLikeExam && !existingKeys.has(duplicateKey(e.name, e.date)),
      name: e.name,
      date: e.date,
      kind: e.kind,
      course: e.course ?? "",
      confidence: "high" as const,
      note: e.recurring ? "Repeats in the school calendar; only the first date is shown." : null,
    }));
}

function CalendarFile({ existingKeys, onFound }: { existingKeys: string[]; onFound: (f: Found) => void }) {
  const [loaded, setLoaded] = useState<{ fileName: string; events: IcsEvent[]; total: number; cut: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [includePast, setIncludePast] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  async function load(file: File) {
    setError("");
    setLoaded(null);
    if (input.current) input.current.value = "";
    if (file.size > MAX_IMPORT_MB * 1024 * 1024) return setError(`That file is over ${MAX_IMPORT_MB} MB.`);
    const body = new FormData();
    body.set("file", file);
    setReading(true);
    try {
      const res = await fetch("/api/calendar/import/ics", { method: "POST", body });
      const data = (await res.json().catch(() => null)) as { events?: IcsEvent[]; total?: number; cut?: boolean; error?: string } | null;
      if (!res.ok || !data?.events) return setError(data?.error ?? "We couldn't read that calendar file. Try exporting it again.");
      setLoaded({ fileName: file.name, events: data.events, total: data.total ?? data.events.length, cut: !!data.cut });
    } catch {
      setError("Couldn't reach the site. Check your connection and try again.");
    } finally {
      setReading(false);
    }
  }

  const keys = new Set(existingKeys);
  const rows = loaded ? icsRows(loaded.events, { showAll, includePast }, keys) : [];
  const examLike = loaded ? loaded.events.filter((e) => e.looksLikeExam && !e.past).length : 0;
  const pastCount = loaded ? loaded.events.filter((e) => e.past && (showAll || e.looksLikeExam)).length : 0;

  return (
    <section className="card flex flex-col gap-4" aria-labelledby="ics-title" aria-busy={reading}>
      <div className="flex flex-col gap-1">
        <h2 id="ics-title" className="section-title">
          Import a calendar file (.ics) from your school
        </h2>
        <p className="text-[15px] text-muted-foreground">
          Canvas, Brightspace, Outlook and Google Calendar can all export one (look for &quot;Export&quot; or &quot;Calendar feed&quot;). Free, no AI.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary btn-sm" disabled={reading} onClick={() => input.current?.click()}>
          {reading ? "Reading…" : loaded ? "Choose another file" : "Choose a .ics file"}
        </button>
        {loaded && <span className="min-w-0 truncate text-sm font-semibold">{loaded.fileName}</span>}
        <input ref={input} type="file" accept=".ics,text/calendar" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
      </div>
      {error && (
        <p className="text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}
      {loaded && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-[15px]">
            {plural(loaded.total, "event", "events")} in this file; <strong>{plural(examLike, "upcoming one looks", "upcoming ones look")} like {examLike === 1 ? "an exam" : "exams"}</strong>.
            {loaded.cut ? " Only the most relevant are listed." : ""}
          </p>
          <div className="flex flex-col gap-2">
            <Toggle checked={showAll} onChange={setShowAll} label="Show all events" hint="not only the ones that look like exams" />
            <Toggle checked={includePast} onChange={setIncludePast} label="Include past events" hint={pastCount ? `${pastCount} in the last year` : "none in this file"} />
          </div>
          <button
            type="button"
            className="btn-primary btn-lg w-full"
            disabled={rows.length === 0}
            onClick={() =>
              onFound({
                rows,
                notes: [
                  ...(showAll ? ["Events that don't look like exams start unticked."] : []),
                  "Nothing is saved until you press Add.",
                ],
                source: "ics",
              })
            }
          >
            {rows.length === 0 ? "No exams found. Try \"Show all events\"" : `Check ${plural(rows.length, "event", "events")}`}
          </button>
        </div>
      )}
    </section>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-xl bg-muted px-3 py-2.5">
      <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--action)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-[15px] font-semibold">
        {label} <span className="font-normal text-muted-foreground">({hint})</span>
      </span>
    </label>
  );
}

function PasteOrSnap({ existingKeys, onFound }: { existingKeys: string[]; onFound: (f: Found) => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList) {
    setError("");
    const next = [...files, ...Array.from(list)];
    if (next.length > MAX_FILES) setError(`Add up to ${MAX_FILES} files at a time.`);
    setFiles(next.slice(0, MAX_FILES));
    if (input.current) input.current.value = "";
  }

  async function read() {
    setError("");
    setEmpty("");
    if (!text.trim() && files.length === 0) return setError("Paste the schedule or add a photo first.");
    if (files.reduce((s, f) => s + f.size, 0) > MAX_IMPORT_MB * 1024 * 1024) {
      return setError(`That's over ${MAX_IMPORT_MB} MB. Try a smaller photo, a screenshot, or paste the text instead.`);
    }
    const body = new FormData();
    body.set("text", text);
    for (const f of files) body.append("files", f);
    setReading(true);
    try {
      const res = await fetch("/api/calendar/import/read", { method: "POST", body });
      const data = (await res.json().catch(() => null)) as {
        exams?: FoundExam[];
        yearAssumed?: number | null;
        pdfCut?: boolean;
        message?: string | null;
        error?: string;
      } | null;
      if (!res.ok || !data) {
        setError(data?.error ?? (res.status === 413 ? `That's over ${MAX_IMPORT_MB} MB. Try a smaller photo or paste the text instead.` : "Something went wrong reading that. Try again in a moment."));
        return;
      }
      if (!data.exams?.length) {
        setEmpty(data.message ?? "We couldn't find any exam dates in that. Try a clearer photo or paste the text.");
        return;
      }
      const notes: string[] = [];
      if (data.yearAssumed) notes.push(`Dates without a year were read as ${data.yearAssumed}.`);
      if (data.pdfCut) notes.push("Only the first 3 pages of the PDF were read. If more exams are further in, add a photo of those pages.");
      notes.push("Nothing is saved until you press Add.");
      onFound({ rows: toRows(data.exams, new Set(existingKeys)), notes, source: "ai" });
    } catch {
      setError("Couldn't reach the site. Check your connection and try again.");
    } finally {
      setReading(false);
    }
  }

  return (
    <section className="card flex flex-col gap-4" aria-labelledby="paste-title" aria-busy={reading}>
      <div className="flex flex-col gap-1">
        <h2 id="paste-title" className="section-title">
          Paste or snap your exam schedule
        </h2>
        <p className="text-[15px] text-muted-foreground">
          Copy it from your syllabus or email, or take a photo. We&apos;ll read the dates and you check them before anything is saved.
        </p>
      </div>
      <label className="flex flex-col">
        <span className="label">Paste the schedule</span>
        <textarea
          className="input h-40 resize-y py-3 leading-snug"
          placeholder={"e.g.\nEndo Block 2 — Tue Nov 4\nPerio Quiz 3 — Nov 6\nOSCE — Dec 1–2"}
          value={text}
          maxLength={30000}
          disabled={reading}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="flex flex-col gap-2">
        <span className="label mb-0">Or add a photo or PDF</span>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary btn-sm" disabled={reading || files.length >= MAX_FILES} onClick={() => input.current?.click()}>
            <Icon d={ICONS.plus} size={16} /> Photo or PDF
          </button>
          <span className="text-[13px] text-muted-foreground">JPG, PNG or PDF (first 3 pages), up to {MAX_IMPORT_MB} MB</span>
          <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
        </div>
        {files.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-semibold">{f.name}</span>
                <span className="shrink-0 text-muted-foreground">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground underline hover:text-danger"
                  disabled={reading}
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <button type="button" className="btn-primary btn-lg w-full" disabled={reading} onClick={read}>
          {reading ? "Reading your schedule…" : "Read my schedule"}
        </button>
        <div aria-live="polite" className="flex flex-col gap-2">
          {reading && <p className="text-sm text-muted-foreground">This usually takes 10–30 seconds.</p>}
          {empty && <p className="tile cb-butter rounded-[18px] p-4 text-[15px] font-semibold">{empty}</p>}
          {error && (
            <p className="text-sm font-semibold text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <p className="text-[13px] text-muted-foreground">Uses your AI key, about 1–2 cents.</p>
      </div>
    </section>
  );
}
