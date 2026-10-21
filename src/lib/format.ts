/**
 * Whole days from `today` to `date` (both YYYY-MM-DD). Pass the student's own today (planner `userToday` / `todayIn`),
 * not the server clock: the server runs in UTC, which is already tomorrow on an American evening.
 */
export function daysUntil(date: string | null, today: string): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

export function formatDate(date: string | null): string {
  if (!date) return "No date";
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function pct(x: number | null | undefined): string {
  return x == null ? "—" : `${Math.round(x * 100)}%`;
}

export function masteryColor(m: number | null): string {
  if (m == null) return "bg-muted text-muted-foreground";
  if (m >= 0.8) return "cb-mint";
  if (m >= 0.6) return "cb-butter";
  return "cb-coral";
}
