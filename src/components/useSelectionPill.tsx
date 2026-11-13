"use client";
import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";

/** What the pill becomes: a new value, or a function of what it is now. */
type Next<P> = SetStateAction<P | null>;

/**
 * A pill that follows the text selection: Highlight on a question, Highlight / Underline on lesson text, "Quiz me on
 * this" on the page. The three share the tracking and differ only in their rules, given here:
 *
 * - `read(range)`: a moment (`delay` ms) after the selection stops changing, with the selection's range (null when
 *   nothing is selected) — returns what the pill becomes.
 * - `press()`: a press anywhere but on the pill — returns what the pill becomes (default: gone).
 *
 * Scrolling, resizing and Escape always hide it. On phones tapping the pill can clear the selection before the tap
 * lands, so the pill's buttons take `hold` (it keeps the selection and pauses tracking until `done()`).
 * `pillAttr` is the data attribute on the pill (e.g. "data-hl-pill"), so a press on it isn't a press elsewhere.
 */
export function useSelectionPill<P>({
  enabled = true,
  delay,
  pillAttr,
  read,
  press,
}: {
  enabled?: boolean;
  delay: number;
  pillAttr: string;
  read: (range: globalThis.Range | null) => Next<P>;
  press?: () => Next<P>;
}): {
  pill: P | null;
  setPill: Dispatch<SetStateAction<P | null>>;
  hold: { onPointerDown: (e: React.PointerEvent) => void; onMouseDown: (e: React.MouseEvent) => void };
  done: () => void;
} {
  const [pill, setPill] = useState<P | null>(null);
  const onPill = useRef(false);
  const live = useRef({ read, press });
  useEffect(() => {
    live.current = { read, press };
  });

  useEffect(() => {
    if (!enabled) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (onPill.current) return; // tapping the pill can clear the selection first on phones
      const sel = window.getSelection();
      const r = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      setPill(live.current.read(r));
    };
    const onSel = () => {
      clearTimeout(t);
      t = setTimeout(update, delay);
    };
    const hide = () => setPill(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(`[${pillAttr}]`)) return;
      onPill.current = false;
      setPill(live.current.press ? live.current.press() : null);
    };
    document.addEventListener("selectionchange", onSel);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("selectionchange", onSel);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, delay, pillAttr]);

  const hold = {
    onPointerDown: (e: React.PointerEvent) => {
      onPill.current = true;
      e.preventDefault(); // keep the selection
    },
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
  };
  /** The pill did its job: it goes, with the selection, and tracking picks up again. */
  const done = () => {
    onPill.current = false;
    setPill(null);
    window.getSelection()?.removeAllRanges();
  };
  return { pill, setPill, hold, done };
}

/** The pill itself: fixed on screen, drawn over everything in a portal. Pass the pill's data attribute in `rest`. */
export function FloatingPill({
  className,
  style,
  children,
  ...rest
}: {
  className: string;
  style: CSSProperties;
  children: ReactNode;
  role?: string;
  "aria-label"?: string;
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  return createPortal(
    <div {...rest} className={className} style={style}>
      {children}
    </div>,
    document.body,
  );
}
