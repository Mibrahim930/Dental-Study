// The numbers behind the pills that come up on a text selection (Highlight, Highlight / Underline, Quiz me on this).
// Plain functions, no DOM, so they can be tested.

/** "Quiz me on this" wants at least this much text (keep in step with lib/quizMe.ts). */
export const QUIZ_MIN_WORDS = 3;
export const QUIZ_MIN_CHARS = 20;
/** Longer selections are cut at a word near this length. */
export const QUIZ_MAX_CHARS = 2000;

/** The selection's text, tidied, and cut at a word near QUIZ_MAX_CHARS when she selected a lot. */
export function tidy(raw: string): { text: string; cut: boolean } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= QUIZ_MAX_CHARS) return { text, cut: false };
  const head = text.slice(0, QUIZ_MAX_CHARS);
  const space = head.lastIndexOf(" ");
  return { text: (space > QUIZ_MAX_CHARS * 0.8 ? head.slice(0, space) : head).trim(), cut: true };
}

/** Enough selected text to write a quiz on: three words and twenty characters, once tidied. */
export function enoughToQuiz(raw: string): boolean {
  const { text } = tidy(raw);
  return text.split(" ").filter(Boolean).length >= QUIZ_MIN_WORDS && text.length >= QUIZ_MIN_CHARS;
}

/** Below this many pixels from the top of the screen there is no room for a pill above the selection. */
export const ROOM_ABOVE = 64;

/** A pill's centre, kept `half` pixels clear of either edge of a screen `width` wide. */
export function clampX(x: number, half: number, width: number): number {
  return Math.min(Math.max(x, half), width - half);
}

/** The marking pills' top: above the selection (48 px up), or 8 px below it when it is near the top of the screen. */
export function markPillTop(top: number, bottom: number): number {
  return top > ROOM_ABOVE ? top - 48 : bottom + 8;
}

/**
 * "Quiz me on this": under the selection (the marking pill sits above it, or below it when there's no room at the top:
 * then this one goes a row further down), kept on a screen `height` tall; centred on it, kept 92 px from either edge.
 */
export function quizPillPlace(rect: { left: number; width: number; top: number; bottom: number }, width: number, height: number): { left: number; top: number } {
  const below = rect.bottom + 14 + (rect.top <= ROOM_ABOVE ? 48 : 0);
  return { left: clampX(rect.left + rect.width / 2, 92, width), top: Math.max(8, Math.min(below, height - 60)) };
}
