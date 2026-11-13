// The dialogs open right now, oldest first, shared by every <Dialog> on the page. Plain module state (no React), so
// the rules are testable on their own: Escape and the focus trap belong to the top one only, and the page behind
// stays still while any is open.

const stack: symbol[] = [];

/** A dialog opened: it is now the top one. */
export function pushDialog(id: symbol) {
  if (!stack.includes(id)) stack.push(id);
}

/** A dialog closed (or unmounted). Whatever was under it is the top one again. */
export function removeDialog(id: symbol) {
  const at = stack.indexOf(id);
  if (at !== -1) stack.splice(at, 1);
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
