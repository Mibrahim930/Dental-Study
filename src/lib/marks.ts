// Highlights and crossed-out options a student puts on a question. Pure helpers shared by the browser and the server.

/** Character range [start, end) inside one piece of text. */
export type Range = [number, number];

/**
 * Marks on one question: highlighted ranges per piece of text ("stem", "case", "opt0"…"opt4"), and the option numbers
 * crossed out. On a block of lesson text: "text" (highlights) and "under" (underlines).
 */
export type Marks = { hl: Record<string, Range[]>; crossed: number[] };

export const emptyMarks = (): Marks => ({ hl: {}, crossed: [] });

export const isEmpty = (m: Marks) => m.crossed.length === 0 && Object.values(m.hl).every((r) => r.length === 0);

/** Sorted, non-overlapping ranges: overlapping or touching ones are joined, empty ones dropped. */
export function mergeRanges(ranges: Range[]): Range[] {
  // Copies, so the caller's arrays (e.g. React state) are never changed.
  const sorted = ranges
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e] as Range)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export const addRange = (ranges: Range[], r: Range) => mergeRanges([...ranges, r]);

/** Remove the highlight that covers character `at` (if any). */
export const removeRangeAt = (ranges: Range[], at: number) => ranges.filter(([s, e]) => !(at >= s && at < e));

/** The highlight covering a whole selection, if one does (to offer "Remove highlight" instead of "Highlight"). */
export const coveringRange = (ranges: Range[], [s, e]: Range) => ranges.find(([a, b]) => a <= s && e <= b) ?? null;

/** Split text into plain and highlighted pieces for rendering. Ranges past the end of the text are clipped. */
export function segments(text: string, ranges: Range[]): { text: string; start: number; marked: boolean }[] {
  const out: { text: string; start: number; marked: boolean }[] = [];
  let at = 0;
  for (const [s0, e0] of mergeRanges(ranges)) {
    const s = Math.min(Math.max(s0, at), text.length);
    const e = Math.min(e0, text.length);
    if (e <= s) continue;
    if (s > at) out.push({ text: text.slice(at, s), start: at, marked: false });
    out.push({ text: text.slice(s, e), start: s, marked: true });
    at = e;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), start: at, marked: false });
  return out;
}

/**
 * Which marks can be stored: a practice-exam question, a section-quiz question by its id, a block of lesson text
 * ("lesson:<topic>:<slide>:<text length>", slide 0 for the intro; the length changes when the lesson is rewritten, so
 * old marks never land on new text), or a question of a "quiz me" / lecture-review quiz ("quizme:<quiz>:<index>").
 */
export const MARKS_KEY = /^(attempt:\d{1,12}:\d{1,12}|quiz:[0-9a-f]{8}|lesson:\d{1,12}:\d{1,12}:\d{1,7}|quizme:\d{1,12}:\d{1,4})$/;

/** Pieces of text marks are kept on: a question's stem, case and options; a lesson block's highlights and underlines. */
const FIELD = /^(stem|case|opt[0-9]|text|under)$/;

/** Marks from outside (browser storage or a request), checked and tidied; null if not usable. */
export function cleanMarks(x: unknown): Marks | null {
  if (!x || typeof x !== "object") return null;
  const { hl, crossed } = x as { hl?: unknown; crossed?: unknown };
  const out = emptyMarks();
  if (hl && typeof hl === "object") {
    for (const [field, ranges] of Object.entries(hl as Record<string, unknown>)) {
      if (!FIELD.test(field) || !Array.isArray(ranges)) continue;
      const rs = ranges
        .filter((r): r is Range => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 0 && n <= 20000))
        .slice(0, 100);
      const merged = mergeRanges(rs.map(([s, e]) => [s, e] as Range));
      if (merged.length) out.hl[field] = merged;
    }
  }
  if (Array.isArray(crossed)) out.crossed = [...new Set(crossed.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < 10))].sort();
  return out;
}
