"use client";
import { useEffect, useRef } from "react";
import { addRange, coveringRange, removeRangeAt, segments, type Range } from "@/lib/marks";
import { FloatingPill, useSelectionPill } from "./useSelectionPill";
import { clampX, markPillTop } from "./selection";

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
  const live = useRef({ ranges, onChange, text });
  useEffect(() => {
    live.current = { ranges, onChange, text };
  });

  // The pill: "Highlight" on a selection inside this text, "Remove highlight" on one inside a highlight (or a tap on it).
  const { pill, setPill, hold, done } = useSelectionPill<Pill>({
    enabled: !!onChange,
    delay: 120,
    pillAttr: "data-hl-pill",
    read: (r) => {
      const el = ref.current;
      // A selection elsewhere takes away an "add" pill; a "remove" pill from a tap stays until the next press.
      if (!el || !r || !el.contains(r.startContainer) || !el.contains(r.endContainer)) return (p) => (p?.kind === "add" ? null : p);
      const off = offsetsIn(el, r, live.current.text);
      if (!off) return null;
      const rect = r.getBoundingClientRect();
      const covering = coveringRange(live.current.ranges, off);
      return { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, kind: covering ? "remove" : "add", range: covering ?? off };
    },
    press: () => (p) => (p?.kind === "remove" ? null : p),
  });

  function apply() {
    const { ranges: rs, onChange: change } = live.current;
    if (!pill || !change) return;
    change(pill.kind === "add" ? addRange(rs, pill.range) : removeRangeAt(rs, pill.range[0]));
    done();
  }

  const parts = segments(text, ranges);

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
                e.stopPropagation(); // tapping a highlight is about the highlight, not picking the answer
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
      {pill && onChange && (
        // Above the selection, or below it when there's no room at the top of the screen.
        <FloatingPill
          data-hl-pill
          role="toolbar"
          aria-label="Highlight"
          className="fixed z-[60] -translate-x-1/2"
          style={{ left: clampX(pill.x, 70, window.innerWidth), top: markPillTop(pill.top, pill.bottom) }}
        >
          <button
            type="button"
            {...hold}
            onClick={(e) => {
              e.stopPropagation();
              apply();
            }}
            className="flex h-11 items-center gap-1.5 rounded-full bg-foreground px-4 text-[14px] font-extrabold text-background shadow-[0_8px_24px_rgba(0,0,0,.25)]"
          >
            <span aria-hidden className="h-3 w-3 rounded-[3px] bg-butter" />
            {pill.kind === "add" ? "Highlight" : "Remove highlight"}
          </button>
        </FloatingPill>
      )}
    </>
  );
}
