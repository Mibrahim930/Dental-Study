"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const KINDS = [
  ["block", "Block exam"],
  ["quiz", "Quiz"],
  ["practical", "Practical"],
  ["board", "Board exam (e.g. INBDE)"],
  ["other", "Other"],
] as const;

export function CalendarForms({ date }: { date: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<"exam" | "busy" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(url: string, body: object) {
    setBusy(true);
    setError("");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error ?? "Something went wrong.");
    setOpen(null);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button className={open === "exam" ? "btn-primary" : "btn-secondary"} onClick={() => setOpen(open === "exam" ? null : "exam")}>
          + Add exam
        </button>
        <button className={open === "busy" ? "btn-primary" : "btn-secondary"} onClick={() => setOpen(open === "busy" ? null : "busy")}>
          + Mark busy days
        </button>
      </div>
      {open === "exam" && (
        <form
          key={`exam-${date}`}
          className="space-y-2 rounded-[20px] bg-muted bg-muted p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void submit("/api/calendar/exams", { name: f.get("name"), course: f.get("course"), kind: f.get("kind"), date: f.get("date") });
          }}
        >
          <input name="name" className="input" placeholder="Exam name, e.g. Endo Block Exam" required />
          <div className="grid grid-cols-2 gap-2">
            <input name="date" type="date" className="input" defaultValue={date} required />
            <select name="kind" className="input" defaultValue="block">
              {KINDS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <input name="course" className="input" placeholder="Course (optional)" />
          <p className="text-xs text-muted-foreground">This also creates the exam&apos;s workspace, where you upload its lectures.</p>
          <button className="btn-primary w-full" disabled={busy}>Add exam</button>
        </form>
      )}
      {open === "busy" && <BusyForm key={`busy-${date}`} date={date} busy={busy} onSubmit={(body) => submit("/api/calendar/busy", body)} />}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayIndex = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const plusDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** "Mark busy days": a range, or "Repeats every week on [Mon]…[Sun] until [date]". */
function BusyForm({ date, busy, onSubmit }: { date: string; busy: boolean; onSubmit: (body: object) => Promise<void> }) {
  const [start, setStart] = useState(date);
  const [repeat, setRepeat] = useState(false);
  const [days, setDays] = useState<number[]>([dayIndex(date)]);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-2 rounded-[20px] bg-muted p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        const f = new FormData(e.currentTarget);
        if (repeat && days.length === 0) return setError("Pick at least one day of the week.");
        void onSubmit(
          repeat
            ? { start: f.get("start"), label: f.get("label"), weekdays: days, until: f.get("until") }
            : { start: f.get("start"), end: f.get("end"), label: f.get("label") },
        );
      }}
    >
      <input name="label" className="input" placeholder="What's happening? e.g. Clinic, Spring break" maxLength={80} />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted-foreground">
          {repeat ? "Starting" : "From"}
          <input name="start" type="date" className="input mt-1 min-w-0" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        {!repeat && (
          <label className="text-xs text-muted-foreground">
            To
            <input name="end" type="date" className="input mt-1 min-w-0" defaultValue={date} min={start} />
          </label>
        )}
      </div>
      <label className="flex items-center gap-2 pt-1 text-sm font-semibold">
        <input type="checkbox" className="h-5 w-5 accent-[var(--action)]" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
        Repeats every week
      </label>
      {repeat && (
        <div className="space-y-2">
          <fieldset>
            <legend className="mb-1 text-xs text-muted-foreground">Repeats every week on</legend>
            <div className="grid grid-cols-7 gap-1">
              {SHORT_DAYS.map((d, i) => {
                const on = days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    className={`h-9 rounded-xl text-xs font-bold ${on ? "bg-action text-action-foreground" : "bg-card text-foreground hover:bg-muted-strong"}`}
                    onClick={() => setDays((ds) => (on ? ds.filter((x) => x !== i) : [...ds, i].sort()))}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="block text-xs text-muted-foreground">
            until
            <input name="until" type="date" className="input mt-1 min-w-0" defaultValue={plusDays(date, 7 * 15)} min={start} required />
          </label>
        </div>
      )}
      <p className="text-xs text-muted-foreground">The planner won&apos;t schedule studying on these days.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn-primary w-full" disabled={busy}>
        Save busy days
      </button>
    </form>
  );
}

export function DeleteBusyButton({ id, label, repeating = false }: { id: number; label: string; repeating?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      className="text-xs text-muted-foreground underline hover:text-danger"
      disabled={pending}
      onClick={async () => {
        if (!window.confirm(repeating ? `Remove every "${label}" day? To skip just one week, use "skip this week".` : `Remove "${label}"?`)) return;
        setPending(true);
        await fetch(`/api/calendar/busy/${id}/delete`, { method: "POST" });
        setPending(false);
        router.refresh();
      }}
    >
      remove
    </button>
  );
}

/** "skip this week" on a repeating busy day, or "undo" to put that week back. */
export function SkipBusyButton({ id, date, undo = false }: { id: number; date: string; undo?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="text-xs font-semibold underline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          const res = await fetch(`/api/calendar/busy/${id}/skip`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date, undo }),
          }).catch(() => null);
          setPending(false);
          if (!res?.ok) return setError("Couldn't save. Try again.");
          router.refresh();
        }}
      >
        {pending ? "…" : undo ? "undo" : "skip this week"}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </>
  );
}
