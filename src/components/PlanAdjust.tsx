"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "./Toaster";

const hoursText = (min: number) => {
  const h = Math.round((min / 60) * 100) / 100;
  return `${h} h`;
};

/** "You missed N tasks yesterday — that's fine. [Re-plan from today]" */
export function MissedBanner({ count, yesterdayOnly }: { count: number; yesterdayOnly: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (count <= 0) return null;
  return (
    <section className="tile cb-lilac flex flex-col gap-2 rounded-[24px]" aria-live="polite">
      <p className="text-[15px] font-semibold">
        You missed {count} {count === 1 ? "task" : "tasks"} {yesterdayOnly ? "yesterday" : "this week"} — that&apos;s fine.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              const res = await fetch("/api/planner/replan", { method: "POST" });
              const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
              if (!res.ok) throw new Error(data.error ?? "Couldn't re-plan. Try again.");
              toast(data.message ?? "Done. Your plan now starts from today.");
              router.refresh();
            } catch (err) {
              setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Couldn't reach the site. Try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Re-planning…" : "Re-plan from today"}
        </button>
        {error && (
          <span className="text-sm font-semibold" role="alert">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * "Study time this day: [1.5] h (usually 2 h) · [Day off]" in the calendar's day panel.
 * `override` is this day's own minutes (null = the usual for its weekday).
 */
export function DayHours({ date, usual, override }: { date: string; usual: number; override: number | null }) {
  const router = useRouter();
  const [hours, setHours] = useState(String(Math.round(((override ?? usual) / 60) * 100) / 100));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function save(minutes: number | null) {
    setPending(true);
    setError("");
    try {
      const res = await fetch("/api/planner/day", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, minutes }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save. Try again.");
      toast(minutes == null ? "Back to your usual time for this day" : minutes === 0 ? "Day off. Your plan moved around it." : "Saved. Your plan is updated.");
      if (minutes == null) setHours(String(Math.round((usual / 60) * 100) / 100));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Couldn't reach the site. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-[20px] bg-muted p-3">
      <form
        className="flex flex-wrap items-center gap-x-2 gap-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const h = Number(hours.replace(",", "."));
          if (!Number.isFinite(h) || h < 0 || h > 16) return setError("Enter between 0 and 16 hours.");
          void save(Math.round(h * 60));
        }}
      >
        <label htmlFor={`day-hours-${date}`} className="text-sm font-bold">
          Study time this day:
        </label>
        <span className="flex items-center gap-1.5">
          <input
            id={`day-hours-${date}`}
            type="number"
            inputMode="decimal"
            min={0}
            max={16}
            step={0.25}
            className="input h-10 w-20 bg-card px-2 text-center"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <span className="text-sm">h</span>
        </span>
        <span className="text-sm text-muted-foreground">(usually {hoursText(usual)})</span>
        <span className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto">
          <button className="btn-primary btn-sm" disabled={pending} aria-label="Save study time for this day">
            {pending ? "Saving…" : "Save"}
          </button>
          {override !== 0 && (
            <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => save(0)}>
              Day off
            </button>
          )}
          {override != null && (
            <button type="button" className="text-sm font-semibold underline" disabled={pending} onClick={() => save(null)}>
              Back to usual
            </button>
          )}
        </span>
      </form>
      {override != null && (
        <p className="text-[13px] text-muted-foreground">
          {override === 0
            ? "Day off: nothing is planned this day."
            : `Changed for this day (${hoursText(override)} instead of ${hoursText(usual)}).${
                override > usual ? " The extra time is used when your plan needs it; work isn't pulled forward just to fill it." : ""
              }`}
        </p>
      )}
      {error && (
        <p className="text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
