"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon, ICONS } from "./ui";

export type TaskItem = {
  id: number;
  kind: string;
  title: string;
  minutes: number;
  status: "todo" | "done" | "missed";
  exam_id: number | null;
  exam_name: string | null;
};

/** Starts a plan task: opens the right study session, practice exam or review. */
function useStartTask() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function start(taskId: number) {
    setBusy(true);
    const res = await fetch(`/api/planner/tasks/${taskId}/start`, { method: "POST" });
    const { url } = await res.json();
    router.push(url);
  }
  return { busy, start };
}

/** The big "Continue · …" button in the home hero. */
export function StartTaskButton({ taskId, label }: { taskId: number; label: string }) {
  const { busy, start } = useStartTask();
  return (
    <button className="btn-hero btn-lg w-full text-[17px]" disabled={busy} onClick={() => start(taskId)}>
      {busy ? "Opening…" : label}
      <Icon d={ICONS.arrowRight} />
    </button>
  );
}

export function TaskList({ tasks, empty = "Nothing planned." }: { tasks: TaskItem[]; empty?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const { start } = useStartTask();

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

  if (tasks.length === 0) return <p className="px-1 py-2 text-[15px] text-muted-foreground">{empty}</p>;
  return (
    <ul>
      {tasks.map((t) => {
        const done = t.status === "done";
        return (
          <li key={t.id} className="flex min-h-14 items-center gap-3 py-2">
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              aria-label={done ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`}
              disabled={busy === t.id || t.status === "missed"}
              onClick={() => toggle(t)}
              className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] transition-colors ${
                done ? "bg-hero text-hero-foreground" : "bg-muted hover:bg-muted-strong"
              }`}
            >
              {done && <Icon d={ICONS.check} size={18} />}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`truncate text-base font-semibold ${done ? "text-muted-foreground line-through" : ""}`}>{t.title}</div>
              <div className="truncate text-[13px] font-medium text-muted-foreground">
                {t.minutes} min
                {t.exam_name && t.exam_id ? (
                  <>
                    {" · "}
                    <Link href={`/exams/${t.exam_id}`} className="hover:underline">
                      {t.exam_name}
                    </Link>
                  </>
                ) : null}
                {t.status === "missed" && <span className="text-warning"> · missed, rescheduled</span>}
              </div>
            </div>
            {t.status === "todo" && (
              <button
                className="btn-primary btn-sm"
                disabled={busy === t.id}
                onClick={() => {
                  setBusy(t.id);
                  void start(t.id);
                }}
              >
                {busy === t.id ? "…" : "Start"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
