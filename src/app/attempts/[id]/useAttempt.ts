"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttemptView } from "@/lib/attemptView";
import type { Confidence } from "@/lib/practicePlan";
import { toast } from "@/components/Toaster";
import { ServerMessage, failureText, jsonOf, signedOut } from "@/components/clientFetch";

/** After this long "generating", the writing screen says it is taking longer than usual and polls less often. */
export const SLOW_AFTER_MS = 3 * 60 * 1000;

/** A SQLite "YYYY-MM-DD HH:MM:SS" time (UTC) in milliseconds. */
export const utcMs = (sqlTime: string) => new Date(sqlTime.replace(" ", "T") + "Z").getTime();

/**
 * A practice exam's state on the client: the attempt as the server last sent it, the open question, picked-but-not-
 * locked answers, polling while it's being written, reporting a question, locking in an answer, and finishing.
 */
export function useAttempt(attemptId: number, initial: AttemptView) {
  const [view, setView] = useState(initial);
  const [index, setIndex] = useState(() => {
    const firstOpen = initial.questions.findIndex((q) => q.chosen_index == null);
    return firstOpen === -1 ? 0 : firstOpen;
  });
  const [pending, setPending] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  // A failed save is pinned to its question, so it never shows under a question she moved on to meanwhile.
  const [saveError, setSaveError] = useState<{ id: number; text: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  // "Finish" with questions left asks first (one stray tap shouldn't end a timed exam): which Finish button asked.
  const [confirmAt, setConfirmAt] = useState<"top" | "bottom" | null>(null);
  const { attempt } = view;
  // Report: the question leaves this exam and its score (15 questions, one reported, 8 right → 8/14).
  const report = useCallback(
    async (questionId: number, reason: string) => {
      const res = await fetch(`/api/attempts/${attemptId}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId, reason }) });
      if (signedOut(res)) return;
      const json = await jsonOf<AttemptView & { error?: string }>(res);
      if (!res.ok || !json?.attempt) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      setView(json);
      setIndex((i) => Math.min(i, Math.max(0, json.questions.length - 1)));
    },
    [attemptId],
  );

  // Moving to another question by her own tap scrolls back to the top (on a phone she'd otherwise land on the bottom
  // of the next question) and puts focus on "Question N of M", so a screen reader announces where she is.
  const questionTop = useRef<HTMLSpanElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    questionTop.current?.focus({ preventScroll: true });
  }, [index]);
  function goto(i: number) {
    if (i !== index) moved.current = true;
    setIndex(i);
  }

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/attempts/${attemptId}`);
      if (signedOut(res)) return;
      const json = await jsonOf<AttemptView>(res);
      if (res.ok && json?.attempt) setView(json);
    } catch {
      // Offline for a moment: the next poll tries again.
    }
  }, [attemptId]);

  // Poll while questions are being written: every 3 s, then every 10 s once it is taking longer than usual (a
  // writer cut off by a restart is turned into an error by the server, which the next poll picks up).
  const startedMs = utcMs(attempt.started_at);
  useEffect(() => {
    if (attempt.status !== "generating") return;
    let gone = false;
    let t: ReturnType<typeof setTimeout>;
    const next = () => {
      t = setTimeout(tick, Date.now() - startedMs >= SLOW_AFTER_MS ? 10_000 : 3000);
    };
    const tick = async () => {
      await refresh();
      if (!gone) next();
    };
    next();
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [attempt.status, refresh, startedMs]);

  // The floating Report button is hidden while a timed exam runs, so it never covers an answer option.
  const timedRunning = attempt.status === "ready" && attempt.mode === "timed";
  useEffect(() => {
    if (!timedRunning) return;
    document.body.dataset.examRunning = "";
    return () => {
      delete document.body.dataset.examRunning;
    };
  }, [timedRunning]);

  /** True when the exam is finished (or she was signed out and is leaving). `quiet` skips the toast (timer retries). */
  const finish = useCallback(
    async (quiet = false): Promise<boolean> => {
      setFinishing(true);
      try {
        const res = await fetch(`/api/attempts/${attemptId}/finish`, { method: "POST" });
        if (signedOut(res)) return true;
        const json = await jsonOf<AttemptView>(res);
        if (!res.ok || !json?.attempt) throw new Error(String(res.status));
        setView(json);
        window.scrollTo({ top: 0 });
        return true;
      } catch {
        // The exam is still open on the server; nothing is lost. (When the timer ran out, the server has already stopped the clock.)
        if (!quiet) toast("Couldn't finish the exam. Check your connection and press Finish again.", "error");
        return false;
      } finally {
        setFinishing(false);
      }
    },
    [attemptId],
  );

  // Locks in the option she picked on question `q` with how sure she is (before seeing the answer).
  async function lockIn(q: { id: number; chosen_index: number | null }, confidence: Confidence) {
    const chosen = pending[q.id];
    if (chosen == null || q.chosen_index != null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/attempts/${attemptId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: q.id, chosen, confidence }),
      });
      if (signedOut(res)) return;
      const json = await jsonOf<AttemptView & { error?: string }>(res);
      if (!res.ok || !json?.attempt) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      setView(json);
    } catch (err) {
      // Not saved: the picked option stays so she can tap a confidence button again once she's back online.
      setSaveError({ id: q.id, text: failureText(err, "Your answer didn't save. Check your connection and try again.") });
    } finally {
      setSaving(false);
    }
  }

  return { view, index, goto, questionTop, pending, setPending, saving, saveError, finishing, confirmAt, setConfirmAt, report, finish, startedMs, lockIn };
}
