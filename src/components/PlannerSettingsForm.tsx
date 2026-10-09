"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "./Toaster";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function PlannerSettingsForm({ weekdayMinutes, reviewMinutes }: { weekdayMinutes: number[]; reviewMinutes: number }) {
  const router = useRouter();
  const [hours, setHours] = useState(weekdayMinutes.map((m) => m / 60));
  const [review, setReview] = useState(reviewMinutes);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await fetch("/api/planner/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        weekdayMinutes: hours.map((h) => Math.round(h * 60)),
        reviewMinutes: review,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    setBusy(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="label">Hours you can study each day</div>
      <div className="grid grid-cols-7 gap-1">
        {DAYS.map((d, i) => (
          <label key={d} className="text-center text-xs text-muted-foreground">
            {d}
            <input
              type="number"
              min={0}
              max={16}
              step={0.5}
              className="input mt-1 px-1 text-center"
              value={hours[i]}
              onChange={(e) => {
                setSaved(false);
                setHours((h) => h.map((v, j) => (j === i ? Number(e.target.value) : v)));
              }}
            />
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        Daily review
        <input
          type="number"
          min={0}
          max={120}
          step={5}
          className="input w-20"
          value={review}
          onChange={(e) => {
            setSaved(false);
            setReview(Number(e.target.value));
          }}
        />
        minutes
      </label>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={busy}>{busy ? "Re-planning…" : "Save and re-plan"}</button>
        {saved && <span className="text-sm text-success">Plan updated.</span>}
      </div>
    </form>
  );
}

export function CalendarSyncLink({ url }: { url: string }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input readOnly value={url} className="input font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            toast("Calendar link copied");
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        className="text-xs text-muted-foreground underline"
        onClick={async () => {
          if (!window.confirm("Make a new link? The old one will stop updating in any calendar that uses it.")) return;
          await fetch("/api/planner/ics-token", { method: "POST" });
          router.refresh();
        }}
      >
        Make a new link
      </button>
    </div>
  );
}
