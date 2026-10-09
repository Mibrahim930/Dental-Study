// Small presentational pieces shared by the redesigned pages: the app mark, the double progress ring and progress strips.

/** The app mark: a tooth whose crown doubles as an open book. `inverted` flips it for use on teal/dark surfaces. */
export function Logo({ size = 40, inverted = false, className = "" }: { size?: number; inverted?: boolean; className?: string }) {
  const tile = inverted ? "var(--hero-accent)" : "var(--hero)";
  const tooth = inverted ? "var(--hero)" : "var(--hero-accent)";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="18" fill={tile} />
      <path
        d="M19 17c0-5.5 5-8 9.5-6.6 1.6.5 2.4 1.1 3.5 1.1s1.9-.6 3.5-1.1C40 9 45 11.5 45 17c0 6-1.7 10.3-2.7 15-1.3 6.3-2.3 14.6-4.6 19.4-1 2.1-3.1 1.8-3.5-.6l-1.3-9.6c-.2-1.6-1.6-1.6-1.8 0l-1.3 9.6c-.4 2.4-2.5 2.7-3.5.6-2.3-4.8-3.3-13.1-4.6-19.4C20.7 27.3 19 23 19 17z"
        fill={tooth}
      />
      {size >= 24 && (
        <>
          <path d="M24.5 22c2.6-1.6 5.2-1.6 7.5.4 2.3-2 4.9-2 7.5-.4" fill="none" stroke={tile} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M32 22.4v5" fill="none" stroke={tile} strokeWidth="2.2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

const clamp = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/**
 * Double progress ring: outer ring for the main measure, inner ring for the supporting one.
 * Always pair it with a legend (RingLegend) so the colours aren't the only cue.
 */
export function DoubleRing({
  outer,
  inner,
  center,
  size = 124,
  outerColor = "var(--hero-accent)",
  innerColor = "var(--hero-accent-2)",
  track = "var(--hero-track)",
  textColor = "currentColor",
  label,
}: {
  outer: number;
  inner?: number | null;
  center: string;
  size?: number;
  outerColor?: string;
  innerColor?: string;
  track?: string;
  textColor?: string;
  label: string;
}) {
  const ring = (r: number, width: number, value: number, color: string) => {
    const c = 2 * Math.PI * r;
    return (
      <>
        <circle cx="66" cy="66" r={r} fill="none" stroke={track} strokeWidth={width} />
        {value > 0 && (
          <circle
            cx="66"
            cy="66"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeLinecap="round"
            strokeDasharray={`${clamp(value) * c} ${c}`}
            transform="rotate(-90 66 66)"
            className="transition-[stroke-dasharray] duration-[600ms] ease-out"
          />
        )}
      </>
    );
  };
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label={label} className="shrink-0">
      {ring(56, 12, outer, outerColor)}
      {inner != null && ring(38, 9, inner, innerColor)}
      <text x="66" y="74" textAnchor="middle" fill={textColor} fontSize={center.length > 4 ? 20 : 26} fontWeight="800" fontFamily="inherit">
        {center}
      </text>
    </svg>
  );
}

/** Legend row for a ring: coloured square, a small label and a bold value. */
export function RingLegend({ items, mutedClass = "text-hero-muted" }: { items: { color: string; label: string; value: string }[]; mutedClass?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      {items.map((i) => (
        <div key={i.label} className="flex flex-col gap-0.5">
          <span className={`text-[13px] font-semibold ${mutedClass}`}>{i.label}</span>
          <span className="flex items-center gap-2 text-[15px] font-bold">
            <span className="h-3 w-3 shrink-0 rounded-[4px]" style={{ background: i.color }} aria-hidden />
            {i.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A row of rounded segments, e.g. 2 of 5 tasks done. */
export function Strip({ total, filled, color = "var(--hero)", className = "" }: { total: number; filled: number; color?: string; className?: string }) {
  if (total <= 0) return null;
  return (
    <div className={`grid gap-1 ${className}`} style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }} aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="h-1.5 rounded-full" style={{ background: i < filled ? color : "var(--muted-strong)" }} />
      ))}
    </div>
  );
}

/** Mastery chip: always shows the number, coloured by threshold (≥80 mint, ≥60 butter, below coral, untested sunk). */
export function MasteryChip({ value, className = "" }: { value: number | null; className?: string }) {
  const cls = value == null ? "bg-muted text-muted-foreground" : value >= 0.8 ? "cb-mint" : value >= 0.6 ? "cb-butter" : "cb-coral";
  return <span className={`chip ${cls} ${className}`}>{value == null ? "New" : `${Math.round(value * 100)}%`}</span>;
}

export type OptionState = "default" | "selected" | "correct" | "wrong" | "dim";

/** Answer option row (section quiz, practice exam): 58px, r18, 2px border, with a 30px letter key. */
export function optionClasses(state: OptionState): { row: string; key: string } {
  switch (state) {
    case "selected":
      return { row: "border-foreground bg-card", key: "bg-action text-action-foreground" };
    case "correct":
      return { row: "border-primary bg-success-soft", key: "bg-hero text-hero-foreground" };
    case "wrong":
      return { row: "border-coral bg-danger-soft", key: "bg-coral text-on-coral" };
    case "dim":
      return { row: "border-transparent bg-muted opacity-75", key: "bg-card" };
    default:
      return { row: "border-transparent bg-muted hover:bg-muted-strong", key: "bg-card" };
  }
}

/** Simple line icons on a 24px grid (Lucide-style). */
export function Icon({ d, size = 20, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

export const ICONS = {
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  arrowLeft: "M19 12H5M11 18l-6-6 6-6",
  check: "M5 12.5l4.5 4.5L19 7",
  plus: "M12 5v14M5 12h14",
  book: "M4 19.5V5a2 2 0 0 1 2-2h14v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H20v-5",
  calendar: "M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  review: "M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5",
  progress: "M3 3v18h18M7 15l4-4 3 3 6-6",
  classes: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  shield: "M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  zoom: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3M11 8v6M8 11h6",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.2A8 8 0 1 1 21 12z",
  close: "M18 6L6 18M6 6l12 12",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  star: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z",
} as const;
