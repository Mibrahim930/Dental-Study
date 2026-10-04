// Calendar grid helpers (Monday-first weeks). Dates are YYYY-MM-DD strings.
import type { ExamKind } from "./db";

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const KIND_LABEL: Record<ExamKind, string> = {
  block: "Block exam",
  quiz: "Quiz",
  practical: "Practical",
  board: "Board exam",
  other: "Other",
};

export const KIND_STYLE: Record<ExamKind, string> = {
  block: "bg-rose-600 text-white",
  quiz: "bg-amber-500 text-white",
  practical: "bg-violet-600 text-white",
  board: "bg-indigo-700 text-white",
  other: "bg-slate-600 text-white",
};

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Weeks of a month (month is 0-based); days outside the month are null. */
export function monthWeeks(year: number, month: number): (string | null)[][] {
  const first = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => ymd(year, month, i + 1))];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
