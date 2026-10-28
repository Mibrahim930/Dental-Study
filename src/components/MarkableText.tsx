"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { addRange, coveringRange, removeRangeAt, type Range } from "@/lib/marks";
import { useMarks } from "./useMarks";

/** The two kinds of mark on lesson text, each a field of the saved marks ("text" = highlight, "under" = underline). */
type Kind = "text" | "under";
const NAMES: Record<Kind, string> = { text: "study-hl", under: "study-ul" };

type Pill = { x: number; top: number; bottom: number; add: boolean; range: Range; kind?: Kind };

// The CSS Custom Highlight API (Chrome 105+, Safari 17.2+, Firefox 140+) paints ranges without touching the DOM.
/** The one registry entry per kind, made on first use; null where the browser has no highlight API. */
function registry(kind: Kind): Highlight | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || !CSS.highlights || typeof Highlight === "undefined") return null;
  let h = CSS.highlights.get(NAMES[kind]);
  if (!h) {
    h = new Highlight();
    CSS.highlights.set(NAMES[kind], h);
  }
  return h;
}

/** The text nodes under `el`, in order, with the character offset each one starts at. */
function textNodes(el: HTMLElement): { node: Text; start: number }[] {
  const out: { node: Text; start: number }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    out.push({ node: n as Text, start: at });
    at += (n as Text).data.length;
  }
  return out;
}

/** A DOM range for the characters [s, e) of `el`'s text. */
function domRange(nodes: { node: Text; start: number }[], [s, e]: Range): globalThis.Range | null {
  const r = document.createRange();
  let began = false;
  for (const { node, start } of nodes) {
    const end = start + node.data.length;
    if (!began && s < end) {
      r.setStart(node, Math.max(0, s - start));
      began = true;
    }
    if (began && e <= end) {
      r.setEnd(node, Math.max(0, e - start));
      return r;
    }
  }
  if (began && nodes.length) {
    const last = nodes[nodes.length - 1];
    r.setEnd(last.node, last.node.data.length);
    return r;
  }
  return null;
}

/** The character offset of a point (text node + offset) inside `el`. */
function offsetOf(nodes: { node: Text; start: number }[], node: Node, offset: number): number | null {
  const hit = nodes.find((n) => n.node === node);
  if (hit) return hit.start + offset;
  // A boundary on an element: the offset of its first text node (or the end).
  const el = node as Element;
  const child = el.childNodes?.[offset];
  if (child) {
    const inside = nodes.find((n) => child === n.node || (child as Element).contains?.(n.node));
    if (inside) return inside.start;
  }
  const total = nodes.reduce((n, x) => n + x.node.data.length, 0);
  return total;
}

/** Character offsets of a selection inside `el`, trimmed of spaces at either edge; null when it's not inside, or blank. */
function selectionOffsets(el: HTMLElement, nodes: { node: Text; start: number }[], r: globalThis.Range): Range | null {
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const text = nodes.map((n) => n.node.data).join("");
  let s = offsetOf(nodes, r.startContainer, r.startOffset);
  let e = offsetOf(nodes, r.endContainer, r.endOffset);
  if (s == null || e == null) return null;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return e > s ? [s, e] : null;
}

/**
 * Rendered lesson text (markdown and all) the student can mark up: select some words and a pill offers Highlight and
 * Underline (the "Quiz me on this" pill sits below the selection, so all three come up together); tap a mark to
 * remove it. Marks are kept as character offsets over the block's text and saved to her account, like the ones on
 * questions. Painted with the browser's highlight API, so the rendered markdown is never rewritten.
 */
export function MarkableText({ marksKey, children, className = "" }: { marksKey: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useMarks(marksKey);
  const [pill, setPill] = useState<Pill | null>(null);
  const onPill = useRef(false);
  const live = useRef(marks);
  useEffect(() => {
    live.current = marks;
  }, [marks]);

  // Paint the saved marks (and repaint when they or the text change).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nodes = textNodes(el);
    const mine: { kind: Kind; range: globalThis.Range }[] = [];
    for (const kind of ["text", "under"] as Kind[]) {
      const h = registry(kind);
      if (!h) continue;
      for (const r of marks.hl[kind] ?? []) {
        const dr = domRange(nodes, r);
        if (dr) {
          h.add(dr);
          mine.push({ kind, range: dr });
        }
      }
    }
    return () => {
      for (const { kind, range } of mine) registry(kind)?.delete(range);
    };
  }, [marks, children]);

  // The pill: on a selection inside this block, or a tap on a mark.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (onPill.current) return;
      const sel = window.getSelection();
      const r = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      if (!r) return setPill((p) => (p?.add ? null : p));
      const nodes = textNodes(el);
      const off = selectionOffsets(el, nodes, r);
      if (!off) return setPill((p) => (p?.add ? null : p));
      const rect = r.getBoundingClientRect();
      const m = live.current;
      const covered = (["text", "under"] as Kind[]).map((kind) => ({ kind, range: coveringRange(m.hl[kind] ?? [], off) })).find((x) => x.range);
      setPill({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, add: !covered, range: covered?.range ?? off, kind: covered?.kind });
    };
    const onSel = () => {
      clearTimeout(t);
      t = setTimeout(update, 120);
    };
    const onClick = (e: MouseEvent) => {
      if (window.getSelection()?.toString()) return;
      const point = (document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(e.clientX, e.clientY);
      const range = point ? null : document.caretRangeFromPoint?.(e.clientX, e.clientY);
      const node = point?.offsetNode ?? range?.startContainer;
      const offset = point?.offset ?? range?.startOffset;
      if (!node || offset == null || !el.contains(node)) return;
      const nodes = textNodes(el);
      const at = offsetOf(nodes, node, offset);
      if (at == null) return;
      const m = live.current;
      for (const kind of ["text", "under"] as Kind[]) {
        const hit = (m.hl[kind] ?? []).find(([s, e2]) => at >= s && at < e2);
        if (hit) {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          setPill({ x: e.clientX, top: rect.top, bottom: rect.bottom, add: false, range: hit, kind });
          return;
        }
      }
    };
    const hide = () => setPill(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-mark-pill]")) return;
      onPill.current = false;
      setPill((p) => (p && !p.add ? null : p));
    };
    document.addEventListener("selectionchange", onSel);
    document.addEventListener("pointerdown", onDown);
    el.addEventListener("click", onClick);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("selectionchange", onSel);
      document.removeEventListener("pointerdown", onDown);
      el.removeEventListener("click", onClick);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  function apply(kind: Kind) {
    if (!pill) return;
    const { range, add } = pill;
    setMarks((m) => ({ ...m, hl: { ...m.hl, [kind]: add ? addRange(m.hl[kind] ?? [], range) : removeRangeAt(m.hl[kind] ?? [], range[0]) } }));
    window.getSelection()?.removeAllRanges();
    setPill(null);
    onPill.current = false;
  }

  const above = pill ? pill.top > 64 : true;
  const hold = {
    onPointerDown: (e: React.PointerEvent) => {
      onPill.current = true;
      e.preventDefault(); // keep the selection
    },
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
  };
  const btn = "flex h-10 items-center gap-1.5 px-3.5 text-[14px] font-extrabold";

  return (
    <>
      <div ref={ref} className={`select-text ${className}`} data-markable>
        {children}
      </div>
      {pill &&
        createPortal(
          <div
            data-mark-pill
            role="toolbar"
            aria-label="Mark this text"
            className="fixed z-[60] flex -translate-x-1/2 overflow-hidden rounded-full bg-foreground text-background shadow-[0_8px_24px_rgba(0,0,0,.25)] divide-x divide-background/20"
            style={{ left: Math.min(Math.max(pill.x, 110), window.innerWidth - 110), top: above ? pill.top - 48 : pill.bottom + 8 }}
          >
            {pill.add ? (
              <>
                <button type="button" {...hold} onClick={() => apply("text")} className={btn}>
                  <span aria-hidden className="h-3 w-3 rounded-[3px] bg-butter" />
                  Highlight
                </button>
                <button type="button" {...hold} onClick={() => apply("under")} className={btn}>
                  <span aria-hidden className="h-3 w-3 border-b-2 border-coral" />
                  Underline
                </button>
              </>
            ) : (
              <button type="button" {...hold} onClick={() => apply(pill.kind ?? "text")} className={btn}>
                {pill.kind === "under" ? "Remove underline" : "Remove highlight"}
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
