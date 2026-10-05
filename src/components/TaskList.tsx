"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type TaskItem = {
  id: number;
  kind: string;
  title: string;
  minutes: number;
  status: "todo" | "done" | "missed";
  exam_id: number | null;
  exam_name: string | null;
};

const ICON: Record<string, string> = { learn: "📖", practice: "✍️", weak_review: "🎯", final_practice: "⏱", review: "🔁", upload: "⬆️" };

export function TaskList({ tasks, empty = "Nothing planned." }: { tasks: TaskItem[]; empty?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);

  async function toggle(t: TaskItem) {
    setBusy(t.id);
    await fetch(`/api/planner/tasks/${t.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: t.status === "done" ? "todo" : "done" }),
    });
    setBusy(null);
    router.refresh();
  }

  async function start(t: TaskItem) {
    setBusy(t.id);
    const res = await fetch(`/api/planner/tasks/${t.id}/start`, { method: "POST" });
    const { url } = await res.json();
    router.push(url);
  }

  if (tasks.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-2">
      {tasks.map((t) => (
        <li key={t.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${t.status === "done" ? "border-border bg-muted" : "border-border bg-card"}`}>
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={t.status === "done"}
            disabled={busy === t.id || t.status === "missed"}
            onChange={() => toggle(t)}
            aria-label={`Mark "${t.title}" done`}
          />
          <span aria-hidden>{ICON[t.kind] ?? "•"}</span>
          <div className="min-w-0 flex-1">
            <div className={`truncate text-sm ${t.status === "done" ? "text-subtle line-through" : "text-foreground"}`}>{t.title}</div>
            <div className="text-xs text-muted-foreground">
              {t.minutes} min{t.exam_name && t.exam_id ? <> · <Link href={`/exams/${t.exam_id}`} className="hover:underline">{t.exam_name}</Link></> : null}
              {t.status === "missed" && <span className="ml-1 text-warning">· missed (rescheduled)</span>}
            </div>
          </div>
          {t.status === "todo" && (
            <button className="btn-secondary px-3 py-1" disabled={busy === t.id} onClick={() => start(t)}>
              {busy === t.id ? "…" : "Start"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
