"use client";
import { useTransition } from "react";
import { setTheme } from "@/app/actions";
import { THEMES, type ThemeId } from "@/lib/themes";

/** Radio cards for the colour theme; saves as soon as one is picked. */
export function ThemePicker({ current }: { current: ThemeId }) {
  const [pending, startTransition] = useTransition();

  function pick(id: ThemeId) {
    const data = new FormData();
    data.set("theme", id);
    startTransition(() => setTheme(data));
  }

  return (
    <fieldset className="grid gap-2 sm:grid-cols-2" disabled={pending}>
      <legend className="sr-only">Colour theme</legend>
      {THEMES.map((t) => (
        <label
          key={t.id}
          className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted has-[:checked]:border-primary has-[:checked]:bg-primary-soft"
        >
          <input type="radio" name="theme" value={t.id} defaultChecked={t.id === current} onChange={() => pick(t.id)} className="mt-1 accent-[var(--primary)]" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t.label}</span>
              <span className="flex shrink-0 overflow-hidden rounded-md border border-border" aria-hidden>
                {t.swatches.map((c) => (
                  <span key={c} className="h-5 w-5" style={{ background: c }} />
                ))}
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
