/** Colour themes a user can pick in Settings. The colours themselves live in globals.css under [data-theme]. */
export const THEMES = [
  { id: "classic", label: "Classic", description: "The original calm teal.", swatches: ["#f6f7f9", "#0f766e", "#0f172a"] },
  { id: "evergreen", label: "Evergreen", description: "Deep green on warm paper. Two colours, easy on the eyes.", swatches: ["#f2efe8", "#123021"] },
  { id: "slate", label: "Slate", description: "Slate-charcoal on soft white. Two colours, cool and clinical.", swatches: ["#f4f4f2", "#2b2f36"] },
  { id: "blocks", label: "Color blocks", description: "Teal with coral, butter and lilac accents.", swatches: ["#0e5e55", "#ff8a73", "#ffd465", "#c9b8ff"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export function themeOf(value: string | null | undefined): ThemeId {
  return THEMES.some((t) => t.id === value) ? (value as ThemeId) : "classic";
}
