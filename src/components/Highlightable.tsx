"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addRange, coveringRange, removeRangeAt, segments, type Range } from "@/lib/marks";

/**
 * Character offsets of a selection inside `el` (whose only content is `text`), without spaces at either edge
 * (a double-click on Windows selects the word plus the space after it). Null if nothing but spaces is selected.
 */
function offsetsIn(el: HTMLElement, r: globalThis.Range, text: string): Range | null {
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  let start = Math.min(pre.toString().length, text.length);
  let end = Math.min(start + r.toString().length, text.length);
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? [start, end] : null;
}

type Pill = { x: number; top: number; bottom: number; kind: "add" | "remove"; range: Range };

/**
 * Plain text the student can highlight: select some words and tap "Highlight"; tap a highlight (or select inside it)
 * to remove it. Without `onChange` it just shows the highlights.
 */
export function Highlightable({
  text,
  ranges,
  onChange,
  className = "",
}: {
  text: string;
  ranges: Range[];
  onChange?: (ranges: Range[]) => void;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pill, setPill] = useState<Pill | null>(null);
  const onPill = useRef(false);
  const live = useRef({ ranges, onChange, text });
  useEffect(() => {
    live.current = { ranges, onChange, text };
  });

  useEffect(() => {
    if (!onChange) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (onPill.current) return; // tapping the pill can clear the selection first on phones
      const el = ref.current;
      const sel = window.getSelection();
      const r = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      if (!el || !r || !el.contains(r.startContainer) || !el.contains(r.endContainer)) {
        setPill((p) => (p?.kind === "add" ? null : p));
        return;
      }
      const off = offsetsIn(el, r, live.current.text);
      if (!off) return setPill(null);
      const rect = r.getBoundingClientRect();
      const covering = coveringRange(live.current.ranges, off);
      setPill({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, kind: covering ? "remove" : "add", range: covering ?? off });
    };
    const onSel = () => {
      clearTimeout(t);
      t = setTimeout(update, 120);
    };
    const hide = () => setPill(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-hl-pill]")) return;
      onPill.current = false;
      setPill((p) => (p?.kind === "remove" ? null : p));
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
  }, [onChange]);

  function apply() {
    const { ranges: rs, onChange: change } = live.current;
    if (!pill || !change) return;
    change(pill.kind === "add" ? addRange(rs, pill.range) : removeRangeAt(rs, pill.range[0]));
    window.getSelection()?.removeAllRanges();
    setPill(null);
    onPill.current = false;
  }

  const parts = segments(text, ranges);
  // Above the selection, or below it when there's no room at the top of the screen.
  const above = pill ? pill.top > 64 : true;

  return (
    <>
      <span ref={ref} className={`select-text ${className}`}>
        {parts.map((p) =>
          p.marked ? (
            <mark
              key={p.start}
              className="hl"
              onClick={(e) => {
                if (!onChange || window.getSelection()?.toString()) return;
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setPill({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, kind: "remove", range: [p.start, p.start + p.text.length] });
              }}
            >
              {p.text}
            </mark>
          ) : (
            <span key={p.start}>{p.text}</span>
          ),
        )}
      </span>
      {pill &&
        onChange &&
        createPortal(
          <div
            data-hl-pill
            role="toolbar"
            aria-label="Highlight"
            className="fixed z-[60] -translate-x-1/2"
            style={{ left: Math.min(Math.max(pill.x, 70), window.innerWidth - 70), top: above ? pill.top - 48 : pill.bottom + 8 }}
          >
            <button
              type="button"
              onPointerDown={(e) => {
                onPill.current = true;
                e.preventDefault(); // keep the selection
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                apply();
              }}
              className="flex h-10 items-center gap-1.5 rounded-full bg-foreground px-4 text-[14px] font-extrabold text-background shadow-[0_8px_24px_rgba(0,0,0,.25)]"
            >
              <span aria-hidden className="h-3 w-3 rounded-[3px] bg-butter" />
              {pill.kind === "add" ? "Highlight" : "Remove highlight"}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
