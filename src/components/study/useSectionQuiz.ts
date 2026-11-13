"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "../Toaster";
import { ServerMessage, failureText, jsonOf, signedOut } from "../clientFetch";
import type { RegenState } from "./RegenerateQuiz";
import type { QuizQ } from "./types";

type Loaded = { topicId: number; questions: QuizQ[]; answered?: Record<string, number>; slides?: number };

/** The section's quiz and her answers in it (null when signed out: already handled). */
async function loadQuiz(sessionId: number, position: number): Promise<Loaded | null> {
  const res = await fetch(`/api/sessions/${sessionId}/quiz?position=${position}`);
  if (signedOut(res)) return null;
  const json = await jsonOf<Loaded & { error?: unknown }>(res);
  if (!res.ok || !json || !Array.isArray(json.questions)) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
  return json;
}

/**
 * The section quiz's state and requests: the questions, her answers, which one is on screen, and "Check answer",
 * "Write new questions", "Retake" and Report. `index` counts the questions shown (reported ones are skipped); answers
 * are keyed by the question's place in the quiz.
 */
export function useSectionQuiz(sessionId: number, position: number) {
  const [quiz, setQuiz] = useState<{ topicId: number; questions: QuizQ[]; slides: number } | null>(null);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // "Write new questions": kept here (not in the button's own block, which the question and score views each show) so
  // switching views mid-rewrite can't offer it a second time. While it runs, answering is paused so no answer lands on
  // a question that's about to be replaced.
  const [regen, setRegen] = useState<{ state: RegenState; error: string }>({ state: "idle", error: "" });
  const regenRunning = useRef(false);
  const rewriting = regen.state === "working";
  // After "Next question →" on a phone the student would otherwise land on the bottom of the next question: when the
  // question changes by her own tap (not on load), the quiz scrolls back to its top and focus moves to its heading.
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    box.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, [index]);

  // One request per load (opening the section, "Try again", a fresh set): when the effect runs again for the same load
  // (React runs effects twice in development) it waits on the request already sent instead of sending a second.
  const loading = useRef<{ key: string; promise: Promise<Loaded | null> } | null>(null);
  useEffect(() => {
    const key = `${sessionId}:${position}:${attempt}`;
    if (loading.current?.key !== key) loading.current = { key, promise: loadQuiz(sessionId, position) };
    let cancelled = false;
    loading.current.promise
      .then((json) => {
        if (cancelled || !json) return;
        const answered = Object.fromEntries(Object.entries(json.answered ?? {}).map(([k, v]) => [Number(k), v]));
        setQuiz({ topicId: json.topicId, questions: json.questions, slides: Number(json.slides) || 0 });
        setAnswers(answered);
        // Pick up where the student left off.
        const shown = json.questions.map((q, i) => ({ q, i })).filter((x) => !x.q.hidden);
        const firstOpen = shown.findIndex((x) => answered[x.i] == null);
        setIndex(firstOpen === -1 ? shown.length : firstOpen);
      })
      .catch((err) => !cancelled && setError(failureText(err, "Check your connection and try again.")));
    return () => {
      cancelled = true;
    };
  }, [sessionId, position, attempt]);

  /** After "Write new questions": start the quiz over with the fresh set. */
  const reload = () => {
    setQuiz(null);
    setAnswers({});
    setPicked(null);
    setIndex(0);
    setError("");
    setSaveError("");
    setAttempt((a) => a + 1);
  };
  async function regenerate() {
    if (!quiz || regenRunning.current) return;
    regenRunning.current = true;
    setRegen({ state: "working", error: "" });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/quiz/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId: quiz.topicId }),
      });
      if (signedOut(res)) return;
      const json = await jsonOf<{ error?: unknown }>(res);
      if (!res.ok) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      setRegen({ state: "idle", error: "" });
      reload();
    } catch (err) {
      setRegen({ state: "error", error: failureText(err, "Couldn't reach the server. Check your connection and try again.") });
    } finally {
      regenRunning.current = false;
    }
  }
  /** "Retake this quiz": the same questions, her answers for this section cleared (asks first). */
  const [retaking, setRetaking] = useState(false);
  async function retake() {
    if (!quiz || retaking || rewriting) return;
    if (!window.confirm("Start this quiz over? Your answers for this section are cleared; the questions stay the same.")) return;
    setRetaking(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/quiz/retake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId: quiz.topicId }),
      });
      if (signedOut(res)) return;
      if (!res.ok) throw new Error(String(res.status));
      reload();
    } catch {
      toast("Couldn't reset the quiz. Check your connection and try again.", "error");
    } finally {
      setRetaking(false);
    }
  }
  /** "Try again" after the quiz didn't load. */
  const retry = () => {
    setError("");
    setAttempt((a) => a + 1);
  };

  // Reported questions are skipped; `at` is each one's place in the stored quiz (what answers are keyed by).
  const shown = quiz ? quiz.questions.map((q, at) => ({ q, at })).filter((x) => !x.q.hidden) : [];
  const total = shown.length;
  const right = shown.filter((x) => answers[x.at] === x.q.correct_index).length;
  const done = shown.filter((x) => answers[x.at] != null).length;

  function check() {
    const at = shown[index]?.at;
    if (!quiz || at == null || picked == null || answers[at] != null) return;
    const chosen = picked;
    setSaveError("");
    setAnswers((a) => ({ ...a, [at]: chosen }));
    fetch(`/api/sessions/${sessionId}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: quiz.topicId, index: at, chosen }),
    })
      .then((res) => {
        if (signedOut(res)) return;
        if (!res.ok) throw new Error(String(res.status));
      })
      .catch(() => {
        // Not saved: let the student answer again rather than showing an answer that won't be remembered.
        setAnswers((a) => {
          const next = { ...a };
          delete next[at];
          return next;
        });
        setSaveError("Your answer didn't save. Check your connection and try again.");
      });
  }

  const goTo = (i: number) => {
    setPicked(null);
    if (i !== index) moved.current = true;
    setIndex(i);
  };
  // Report: the question leaves this quiz (and its score) at once; the server hides it in every copy of the exam.
  const report = async (questionId: string | undefined, reason: string) => {
    if (!quiz) return;
    const res = await fetch(`/api/sessions/${sessionId}/quiz/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: quiz.topicId, questionId, reason }),
    });
    if (signedOut(res)) return;
    if (!res.ok) throw new Error(String(res.status));
    setPicked(null);
    setQuiz((z) => (z ? { ...z, questions: z.questions.map((x) => (x.id === questionId ? { ...x, hidden: true } : x)) } : z));
  };

  const regenerateProps = {
    state: regen.state,
    error: regen.error,
    onAsk: () => setRegen({ state: "confirm", error: "" }),
    onCancel: () => setRegen({ state: "idle", error: "" }),
    onRun: () => void regenerate(),
  };

  return {
    quiz,
    answers,
    picked,
    setPicked,
    index,
    error,
    saveError,
    rewriting,
    retaking,
    box,
    heading,
    shown,
    total,
    right,
    done,
    check,
    goTo,
    report,
    retake,
    retry,
    regenerateProps,
  };
}
