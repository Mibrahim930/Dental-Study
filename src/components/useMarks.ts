"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { cleanMarks, emptyMarks, type Marks } from "@/lib/marks";

// Highlights and cross-outs on one question. Saved to the student's account (so they follow her between phone and
// laptop) with a copy in this browser so they show instantly. Edits not yet saved are flagged "dirty" so a slower,
// older copy from the server never overwrites them.

const storageKey = (key: string) => `marks:v1:${key}`;

function readLocal(key: string): { marks: Marks; dirty: boolean } | null {
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const v = JSON.parse(raw) as { m?: unknown; dirty?: unknown };
    const marks = cleanMarks(v.m);
    return marks ? { marks, dirty: v.dirty === true } : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, marks: Marks, dirty: boolean) {
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify({ m: marks, dirty }));
  } catch {
    /* storage full or blocked: the account copy still works */
  }
}

function save(key: string, marks: Marks, keepalive = false): Promise<boolean> {
  return fetch("/api/marks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, marks }),
    keepalive,
  })
    .then((r) => r.ok)
    .catch(() => false);
}

/** Marks for `key` (null: kept in memory only), and a function to change them. */
export function useMarks(key: string | null): [Marks, (change: (m: Marks) => Marks) => void] {
  const [state, setState] = useState<{ key: string | null; marks: Marks }>({ key, marks: emptyMarks() });
  const marks = state.key === key ? state.marks : emptyMarks();
  const edited = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ key: string; marks: Marks } | null>(null);

  const flush = useCallback((keepalive = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    void save(p.key, p.marks, keepalive).then((ok) => {
      // Saved, and nothing newer queued meanwhile: no longer dirty.
      if (ok && !pending.current) writeLocal(p.key, p.marks, false);
    });
  }, []);

  // Load: this browser's copy right away, then the account's (unless this browser has unsaved edits, which win).
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    edited.current = false;
    const local = readLocal(key);
    queueMicrotask(() => {
      if (!cancelled && local && !edited.current) setState({ key, marks: local.marks });
    });
    fetch(`/api/marks?key=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { marks: unknown } | null) => {
        if (cancelled || !j || edited.current) return;
        if (local?.dirty) {
          pending.current = { key, marks: local.marks };
          flush();
          return;
        }
        const server = cleanMarks(j.marks) ?? emptyMarks();
        setState({ key, marks: server });
        writeLocal(key, server, false);
      })
      .catch(() => {
        /* offline: this browser's copy stays */
      });
    return () => {
      cancelled = true;
      // Leaving the question: send anything still waiting.
      if (pending.current) flush(true);
    };
  }, [key, flush]);

  // Closing the tab or switching apps on a phone: send anything still waiting.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && pending.current && flush(true);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  const update = useCallback(
    (change: (m: Marks) => Marks) => {
      edited.current = true;
      setState((s) => {
        const next = change(s.key === key ? s.marks : emptyMarks());
        if (key) {
          writeLocal(key, next, true);
          pending.current = { key, marks: next };
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => flush(), 600);
        }
        return { key, marks: next };
      });
    },
    [key, flush],
  );

  return [marks, update];
}
