// The dialogs open right now, oldest first, shared by every <Dialog> on the page. Plain module state (no React), so
// the rules are testable on their own: Escape and the focus trap belong to the top one only, and the page behind
// stays still while any is open.

const stack: symbol[] = [];
// Each open dialog's panel, so one closing over another can hand focus to the one still open.
const panels = new Map<symbol, HTMLElement>();

/** A dialog opened: it is now the top one. */
export function pushDialog(id: symbol, panel?: HTMLElement | null) {
  if (!stack.includes(id)) stack.push(id);
  if (panel) panels.set(id, panel);
}

/** A dialog closed (or unmounted). Whatever was under it is the top one again. */
export function removeDialog(id: symbol) {
  const at = stack.indexOf(id);
  if (at !== -1) stack.splice(at, 1);
  panels.delete(id);
}

/** The panel of the top dialog, if any is open (after one closed: the one now on top). */
export function topDialogPanel(): HTMLElement | null {
  return stack.length > 0 ? (panels.get(stack[stack.length - 1]) ?? null) : null;
}

/** Only the top dialog answers Escape and keeps focus. */
export function isTopDialog(id: symbol) {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** How many are open (for tests and the scroll lock). */
export function openDialogs() {
  return stack.length;
}

/** The page's own overflow before the first dialog locked it, put back when the last one closes. */
let saved: { html: string; body: string } | null = null;
let locks = 0;

/**
 * Stops the page behind from scrolling while any dialog is open. Call `lockScroll` when one opens and the function it
 * returns when it closes; nested dialogs share one lock, so closing the top one leaves the page locked for the one under it.
 */
export function lockScroll(doc: { documentElement: { style: { overflow: string } }; body: { style: { overflow: string } } } = document): () => void {
  if (!saved) {
    saved = { html: doc.documentElement.style.overflow, body: doc.body.style.overflow };
    doc.documentElement.style.overflow = "hidden";
    doc.body.style.overflow = "hidden";
  }
  locks++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks--;
    if (locks === 0 && saved) {
      doc.documentElement.style.overflow = saved.html;
      doc.body.style.overflow = saved.body;
      saved = null;
    }
  };
}

/** Below Tailwind's `sm` (40rem, 640 px): the phone layout, where `lockScroll: "narrow"` locks the page. */
export const NARROW_SCREEN = "not all and (min-width: 40rem)";

/** Whether a dialog with this `lockScroll` setting holds the page still right now (`narrow`: the screen is phone-sized). */
export function shouldLockScroll(setting: boolean | "narrow", narrow: boolean) {
  return setting === "narrow" ? narrow : setting;
}


/**
 * Where focus goes when a dialog closes. First the element that had it when the dialog opened, then `fallback` (the
 * opener's `returnFocus`), each only while it's still on the page and, when another dialog is still open underneath,
 * inside that one (focus must not leave the dialog she's still in). Then that dialog's panel itself, then the page's
 * <main>, so a keyboard or screen-reader user never lands back at the top of the document. Those last resorts only
 * when focus is `lost` (nothing on the page has it): if the page already moved it somewhere on purpose, it stays.
 * `temporary` says the target isn't focusable on its own (<main>): it gets tabindex -1 only while it holds focus.
 */
export function focusAfterClose<T extends { isConnected: boolean; contains(other: T): boolean }>({
  opener,
  fallback,
  under,
  main,
  lost,
}: {
  opener: T | null;
  fallback: T | null;
  under: T | null;
  main: T | null;
  lost: boolean;
}): { to: T; temporary: boolean } | null {
  const usable = (el: T | null): el is T => el != null && el.isConnected && (under == null || under.contains(el));
  if (usable(opener)) return { to: opener, temporary: false };
  if (!lost) return null;
  if (usable(fallback)) return { to: fallback, temporary: false };
  if (under?.isConnected) return { to: under, temporary: false };
  if (main?.isConnected) return { to: main, temporary: true };
  return null;
}

/** What Tab can land on inside a dialog. */
export const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Where Tab (or Shift+Tab) goes from `current` among `items` (the dialog's focusable elements, in order): it wraps at
 * either end, and from anywhere outside the list it goes to the first (or, going back, the last). Null means "let the
 * browser move it" (a step inside the list), or, with an empty list, that the dialog itself keeps focus.
 */
export function nextFocus<T>(items: T[], current: T | null, back: boolean): T | null {
  if (items.length === 0) return null;
  const at = current == null ? -1 : items.indexOf(current);
  if (at === -1) return back ? items[items.length - 1] : items[0];
  if (back) return at === 0 ? items[items.length - 1] : null;
  return at === items.length - 1 ? items[0] : null;
}
