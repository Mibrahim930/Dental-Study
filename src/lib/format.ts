export function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date + "T00:00:00");
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

export function formatDate(date: string | null): string {
  if (!date) return "No date";
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function pct(x: number | null | undefined): string {
  return x == null ? "—" : `${Math.round(x * 100)}%`;
}

export function masteryColor(m: number | null): string {
  if (m == null) return "bg-slate-100 text-slate-600";
  if (m >= 0.8) return "bg-emerald-100 text-emerald-800";
  if (m >= 0.6) return "bg-amber-100 text-amber-800";
  return "bg-rose-100 text-rose-800";
}
