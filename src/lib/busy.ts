// Busy days: one-off date ranges ("Spring break") and weekly repeats ("Clinic every Tuesday until 12 Dec").
// One place decides whether a day is busy, so the planner, the calendar page and the phone feed always agree.
import { db } from "./db";

export type BusyRow = {
  id: number;
  start_date: string;
  end_date: string;
  label: string;
  /** Repeat days as a bit mask (bit 0 = Monday … bit 6 = Sunday); null or 0 = a one-off range. */
  weekdays: number | null;
};

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 0 = Monday … 6 = Sunday */
export const dayOfWeek = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
export const isRepeating = (b: Pick<BusyRow, "weekdays">) => !!b.weekdays && (b.weekdays & 0x7f) !== 0;
export const maskOf = (days: number[]) => days.reduce((m, d) => (Number.isInteger(d) && d >= 0 && d <= 6 ? m | (1 << d) : m), 0);
export const daysOf = (mask: number | null) => [0, 1, 2, 3, 4, 5, 6].filter((d) => ((mask ?? 0) >> d) & 1);
export const skipKey = (busyId: number, date: string) => `${busyId}|${date}`;

/** Would this row block `date` if nothing were skipped? */
export function coversDate(b: BusyRow, date: string): boolean {
  if (date < b.start_date || date > b.end_date) return false;
  return isRepeating(b) ? ((b.weekdays! >> dayOfWeek(date)) & 1) === 1 : true;
}

/** Busy entries that block `date` (skipped weeks of a repeat don't). */
export function busyOn(rows: BusyRow[], skips: Set<string>, date: string): BusyRow[] {
  return rows.filter((b) => coversDate(b, date) && !(isRepeating(b) && skips.has(skipKey(b.id, date))));
}

/** Repeats that would have blocked `date` but were skipped that week (so the day panel can offer "undo"). */
export function skippedOn(rows: BusyRow[], skips: Set<string>, date: string): BusyRow[] {
  return rows.filter((b) => isRepeating(b) && coversDate(b, date) && skips.has(skipKey(b.id, date)));
}

/** "every Tuesday", "every Tue and Thu", "every Mon, Wed and Fri", "every day". */
export function repeatLabel(mask: number | null): string {
  const days = daysOf(mask);
  if (days.length === 7) return "every day";
  if (days.length === 5 && days.every((d) => d < 5)) return "every weekday";
  if (days.length === 1) return `every ${DAY_NAMES[days[0]]}`;
  const names = days.map((d) => SHORT[d]);
  return `every ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** First day a repeat actually happens (null if its days never fall inside its range). */
export function firstOccurrence(b: BusyRow): string | null {
  if (!isRepeating(b)) return b.start_date;
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${b.start_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    if (day > b.end_date) return null;
    if (coversDate(b, day)) return day;
  }
  return null;
}

/** A student's busy entries (optionally only those still running on or after `from`) and their skipped weeks. */
export function loadBusy(userId: number, from?: string): { rows: BusyRow[]; skips: Set<string> } {
  const rows = (
    from
      ? db.prepare("SELECT id, start_date, end_date, label, weekdays FROM busy_days WHERE user_id = ? AND end_date >= ? ORDER BY start_date, id").all(userId, from)
      : db.prepare("SELECT id, start_date, end_date, label, weekdays FROM busy_days WHERE user_id = ? ORDER BY start_date, id").all(userId)
  ) as BusyRow[];
  const skips = new Set(
    (
      db
        .prepare("SELECT s.busy_id, s.date FROM busy_skips s JOIN busy_days b ON b.id = s.busy_id WHERE b.user_id = ?")
        .all(userId) as { busy_id: number; date: string }[]
    ).map((s) => skipKey(s.busy_id, s.date)),
  );
  return { rows, skips };
}
