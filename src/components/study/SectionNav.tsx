"use client";
import type { TopicLite } from "./types";

/** The left column on a wide screen: every section under its lecture's header, in study order; a tap goes there. */
export function SectionNav({ topics, position, visited, onGo }: { topics: TopicLite[]; position: number; visited: Set<number>; onGo: (pos: number) => void }) {
  const navGroups: { key: string; label: string | null; items: TopicLite[] }[] = [];
  for (const t of topics) {
    const key = String(t.lectureId);
    const last = navGroups.at(-1);
    if (last?.key === key) last.items.push(t);
    else navGroups.push({ key, label: t.lectureId != null ? `Lecture ${t.lectureNo ?? "?"} · ${t.lecture}` : null, items: [t] });
  }

  return (
    <nav className="hidden lg:block" aria-label="Sections">
      <div className="card sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col gap-1 overflow-y-auto p-2.5">
        {navGroups.map((g) => (
          <div key={g.key} className="flex flex-col gap-1">
            {g.label && <div className="px-3 pt-2 pb-0.5 text-[12px] leading-snug font-extrabold text-muted-foreground">{g.label}</div>}
            <ol className="flex flex-col gap-1">
              {g.items.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => onGo(t.position)}
                    aria-current={t.position === position ? "step" : undefined}
                    className={`flex w-full items-start gap-2 rounded-[16px] px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                      t.position === position
                        ? "bg-hero text-hero-foreground"
                        : visited.has(t.position)
                          ? "hover:bg-muted"
                          : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <span className="w-5 shrink-0 font-extrabold">{t.lectureId != null ? t.section : t.position + 1}</span>
                    <span>
                      {t.title}
                      {t.emphasized && " ★"}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </nav>
  );
}
