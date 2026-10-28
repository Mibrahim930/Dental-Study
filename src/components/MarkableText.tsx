"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { addRange, coveringRange, removeRangeAt, type Range } from "@/lib/marks";
import { useMarks } from "./useMarks";

/** The two kinds of mark on lesson text, each a field of the saved marks ("text" = highlight, "under" = underline). */
type Kind = "text" | "under";
const NAMES: Record<Kind, string> = { text: "study-hl", under: "study-ul" };

/** The pill: where it sits, the selected range, and for each kind the existing mark covering it (if any). */
type Pill = { x: number; top: number; bottom: number; range: Range; covered: Partial<Record<Kind, Range>> };

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

/** Characters of text inside a node (0 for a <br>, an image or an empty element). */
function lengthOf(n: Node): number {
  if (n.nodeType === 3) return (n as Text).data.length;
  let total = 0;
  for (const c of Array.from(n.childNodes)) total += lengthOf(c);
  return total;
}

/**
 * The character offset of a boundary (node + offset, as a DOM Range gives it) in the block's text. On a text node the
 * offset is a character; on an element it is a child index, so the text of the children before it counts (a boundary
 * after a <br>, at the end of a paragraph that isn't the last, or on the block itself all land where they should).
 * Null for a node outside the block.
 */
function offsetOf(nodes: { node: Text; start: number }[], node: Node, offset: number): number | null {
  // The block: the lowest ancestor of `node` that holds every text node.
  let root: Node = node;
  while (root.parentNode && !nodes.every((n) => root.contains(n.node))) root = root.parentNode;
  let at = 0;
  let found: number | null = null;
  const visit = (n: Node): boolean => {
    if (n === node) {
      if (n.nodeType === 3) found = at + Math.min(offset, (n as Text).data.length);
      else {
        const kids = Array.from(n.childNodes);
        for (let i = 0; i < Math.min(offset, kids.length); i++) at += lengthOf(kids[i]);
        found = at;
      }
      return true;
    }
    if (n.nodeType === 3) {
      at += (n as Text).data.length;
      return false;
    }
    for (const k of Array.from(n.childNodes)) if (visit(k)) return true;
    return false;
  };
  visit(root);
  return found;
}

/** For each kind, the existing mark that covers the range (so the pill offers "Remove" for it and "Add" for the other). */
function coveredBy(m: { hl: Record<string, Range[]> }, range: Range): Partial<Record<Kind, Range>> {
  const out: Partial<Record<Kind, Range>> = {};
  for (const kind of ["text", "under"] as Kind[]) {
    const c = coveringRange(m.hl[kind] ?? [], range);
    if (c) out[kind] = c;
  }
  return out;
}

/** Character offsets of a selection inside `el`, trimmed of spaces at either edge; null when it's not inside, or blank. */
function selectionOffsets(el: HTMLElement, nodes: { node: Text; start: number }[], r: globalThis.Range): Range | null {
  if (!el.contains(r.startContainer)) return null;
  const text = nodes.map((n) => n.node.data).join("");
  let s = offsetOf(nodes, r.startContainer, r.startOffset);
  // A triple-click on the block's last paragraph ends at the start of whatever follows the block: that is its end.
  let e = el.contains(r.endContainer) ? offsetOf(nodes, r.endContainer, r.endOffset) : r.endOffset === 0 ? text.length : null;
  if (s == null || e == null) return null;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return e > s ? [s, e] : null;
}

/**
 * Rendered lesson text (markdown and all) the student can mark up: select some words and a pill offers Highlight and
 * Underline (the "Quiz me on this" pill sits below the selection, so all three come up together); tap a mark to
 * remove it. Marks are kept as character offsets over the block's text and saved to her account, like the ones on
 * questions. Painted with the browser's highlight API, so the rendered markdown is never rewritten (a browser without
 * that API, iOS before 17.2 or Firefox before 140, gets no pill: nothing could be shown). The key carries the text's
 * length, so a rewritten lesson starts clean instead of wearing marks at the wrong offsets.
 */
export function MarkableText({ marksKey, children, className = "" }: { marksKey: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useMarks(marksKey);
  const [pill, setPill] = useState<Pill | null>(null);
  const onPill = useRef(false);
  const tapped = useRef(false); // the pill came from a tap on a mark (no selection)
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
      if (!r) return setPill((p) => (p && p.range[1] - p.range[0] > 0 && !tapped.current ? null : p));
      const nodes = textNodes(el);
      const off = selectionOffsets(el, nodes, r);
      if (!off || !registry("text")) return setPill(null); // a selection elsewhere clears any pill; no highlight API, no pill
      const rect = r.getBoundingClientRect();
      tapped.current = false;
      setPill({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, range: off, covered: coveredBy(live.current, off) });
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
        const hit = (m.hl[kind] ?? []).find(([s, e2]) => at >= s && at <= e2);
        if (!hit) continue;
        // Only a tap on the mark itself (not blank space the caret snapped from): the finger must be over its boxes.
        const dr = domRange(nodes, hit);
        const boxes = dr ? Array.from(dr.getClientRects()) : [];
        const box = boxes.find((b) => e.clientX >= b.left - 4 && e.clientX <= b.right + 4 && e.clientY >= b.top - 4 && e.clientY <= b.bottom + 4);
        if (!box) continue;
        tapped.current = true;
        setPill({ x: Math.min(Math.max(e.clientX, box.left), box.right), top: box.top, bottom: box.bottom, range: hit, covered: coveredBy(m, hit) });
        return;
      }
    };
    const hide = () => setPill(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-mark-pill]")) return;
      onPill.current = false;
      if (tapped.current) {
        tapped.current = false;
        setPill(null);
      }
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
    const existing = pill.covered[kind];
    setMarks((m) => ({ ...m, hl: { ...m.hl, [kind]: existing ? removeRangeAt(m.hl[kind] ?? [], existing[0]) : addRange(m.hl[kind] ?? [], pill.range) } }));
    window.getSelection()?.removeAllRanges();
    setPill(null);
    onPill.current = false;
    tapped.current = false;
  }

  // Above the selection, or below it when there's no room at the top; always on screen.
  const above = pill ? pill.top > 64 : true;
  const pillTop = pill ? Math.min(Math.max(above ? pill.top - 48 : pill.bottom + 8, 8), window.innerHeight - 56) : 0;
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
            style={{ left: Math.min(Math.max(pill.x, 110), window.innerWidth - 110), top: pillTop }}
          >
            <button type="button" {...hold} onClick={() => apply("text")} className={btn}>
              <span aria-hidden className="h-3 w-3 rounded-[3px] bg-butter" />
              {pill.covered.text ? "Remove highlight" : "Highlight"}
            </button>
            <button type="button" {...hold} onClick={() => apply("under")} className={btn}>
              <span aria-hidden className="h-3 w-3 border-b-2 border-coral" />
              {pill.covered.under ? "Remove underline" : "Underline"}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
