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
          className="space-y-2 rounded-lg border border-border bg-muted p-3"
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
      {open === "busy" && (
        <form
          key={`busy-${date}`}
          className="space-y-2 rounded-lg border border-border bg-muted p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void submit("/api/calendar/busy", { start: f.get("start"), end: f.get("end"), label: f.get("label") });
          }}
        >
          <input name="label" className="input" placeholder="What's happening? e.g. Clinic, Spring break" />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted-foreground">From<input name="start" type="date" className="input mt-1" defaultValue={date} required /></label>
            <label className="text-xs text-muted-foreground">To<input name="end" type="date" className="input mt-1" defaultValue={date} /></label>
          </div>
          <p className="text-xs text-muted-foreground">The planner won&apos;t schedule studying on these days.</p>
          <button className="btn-primary w-full" disabled={busy}>Save busy days</button>
        </form>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

export function DeleteBusyButton({ id }: { id: number }) {
  const router = useRouter();
  return (
    <button
      className="text-xs text-muted-foreground underline hover:text-danger"
      onClick={async () => {
        await fetch(`/api/calendar/busy/${id}/delete`, { method: "POST" });
        router.refresh();
      }}
    >
      remove
    </button>
  );
}
