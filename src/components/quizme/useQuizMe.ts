"use client";
import { useEffect, useRef, useState } from "react";
import type { QuizMeAnswer, QuizMeView } from "@/lib/quizMe";
import { failureText, jsonOf, ServerMessage, signedOut } from "../clientFetch";
import { toast } from "../Toaster";
import { tidy } from "../selection";

/** Keep in step with lib/quizMe.ts. */
export const SIZES = [3, 5, 10] as const;
export type Size = (typeof SIZES)[number];
type Stage = "choose" | "writing" | "quiz";

/** A JSON request through the shared helpers: null when signed out (already handled), ServerMessage on a refusal. */
async function call<T>(url: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(url, init);
  if (signedOut(res)) return null;
  const json = await jsonOf<T & { error?: unknown }>(res);
  if (!res.ok || !json) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
  return json;
}

/** The questions of one round, in order, each with its index in the stored list. */
const ofRound = (q: QuizMeView, round: number) => q.questions.map((x, at) => ({ q: x, at })).filter((x) => !x.q.hidden && x.q.round === round);

/** Where to pick a round up: its first unanswered question, or its end. */
const firstOpen = (q: QuizMeView, round = q.round) => {
  const shown = ofRound(q, round);
  const i = shown.findIndex((x) => x.q.chosen == null);
  return i === -1 ? shown.length : i;
};

/** The quiz with one answer filled in from the server's reply. */
function withAnswer(q: QuizMeView, at: number, r: QuizMeAnswer): QuizMeView {
  const questions = q.questions.map((x, i) =>
    i === at ? { ...x, chosen: r.chosen, correct_index: r.correct_index, explanation: r.explanation, option_notes: r.option_notes } : x,
  );
  const left = questions.filter((x) => !x.hidden && x.chosen == null).length;
  return { ...q, questions, answers: questions.map((x) => x.chosen), left, finished: r.finished || left === 0 };
}

/** Everything the quiz panel knows and does: which stage it's on, the quiz, her place in it, and the requests. */
export function useQuizMe(examId: number, topicId?: number) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [stage, setStage] = useState<Stage>("choose");
  const [draft, setDraft] = useState<{ text: string; cut: boolean } | null>(null);
  const [size, setSize] = useState<Size>(5);
  const [writingSize, setWritingSize] = useState(5);
  const [quiz, setQuiz] = useState<QuizMeView | null>(null);
  const [index, setIndex] = useState(0);
  // Lecture review: the round on screen. When a finished round opens the next one, a page in between says so first.
  const [round, setRound] = useState(1);
  const [picked, setPicked] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The selection quiz being written: a number per request. Anything that takes the panel off "writing" (a lecture
  // review opened meanwhile) moves it on, so a quiz that comes back late can't replace what is on screen.
  const writing = useRef(0);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Another part of the page (the lecture review card) hands over a quiz to run here.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const q = (e as CustomEvent<QuizMeView>).detail;
      if (!q || q.examId !== examId) return;
      writing.current++;
      setQuiz(q);
      setRound(q.round);
      setIndex(firstOpen(q));
      setPicked(null);
      setError("");
      setStage("quiz");
      setOpen(true);
    };
    window.addEventListener("quizme-open", onOpen);
    return () => window.removeEventListener("quizme-open", onOpen);
  }, [examId]);

  // Cards that count misses refresh when the panel closes.
  const close = () => {
    setOpen(false);
    window.dispatchEvent(new Event("quizme-closed"));
  };

  // An unfinished quiz for this exam is offered again.
  useEffect(() => {
    let alive = true;
    fetch(`/api/quizme/open?examId=${examId}`)
      .then(async (res) => {
        if (!alive || signedOut(res)) return;
        const json = await jsonOf<{ quiz?: QuizMeView | null }>(res);
        const found = res.ok ? json?.quiz : null;
        if (alive && found && !found.finished) setQuiz((q) => q ?? found);
      })
      .catch(() => {
        // Nothing to resume is the quiet fallback; the page itself works without it.
      });
    return () => {
      alive = false;
    };
  }, [examId]);

  /** "Quiz me on this" was tapped on this selected text. */
  function fromSelection(text: string) {
    setOpen(true);
    if (stage === "writing") return; // one quiz at a time: the panel shows the one being written
    setDraft(tidy(text));
    setError("");
    setStage("choose");
  }

  function resume() {
    if (!quiz) return;
    setRound(quiz.round);
    setIndex(firstOpen(quiz));
    setPicked(null);
    setError("");
    setStage("quiz");
    setOpen(true);
  }

  async function start() {
    if (!draft || stage === "writing") return;
    const req = ++writing.current;
    setWritingSize(size);
    setStage("writing");
    setError("");
    try {
      const q = await call<QuizMeView>("/api/quizme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId, text: draft.text, size, ...(topicId != null ? { topicId } : {}) }),
      });
      if (!q || writing.current !== req) return;
      writing.current++;
      setQuiz(q);
      setRound(q.round);
      setIndex(firstOpen(q));
      setPicked(null);
      setStage("quiz");
      if (!openRef.current) toast("Your quiz is ready. Tap “Resume your quiz”.");
    } catch (err) {
      if (writing.current !== req) return;
      writing.current++;
      setError(failureText(err, "Couldn't write the quiz. Check your connection and try again."));
      setStage("choose");
      if (!openRef.current) toast("Couldn't write that quiz. Try again.", "error");
    }
  }

  const shown = quiz ? ofRound(quiz, round) : [];

  async function check() {
    const item = shown[index];
    if (!quiz || !item || picked == null || saving || item.q.chosen != null) return;
    const id = quiz.id;
    setSaving(true);
    setError("");
    try {
      const r = await call<QuizMeAnswer>(`/api/quizme/${id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: item.at, chosen: picked }),
      });
      if (!r) return;
      // A finished round with misses opens the next on the server: fetch the quiz again so the new round is here.
      if (r.finished === false && quiz.kind === "lecture" && shown.every((x) => x.at === item.at || x.q.chosen != null)) {
        try {
          const fresh = await call<QuizMeView>(`/api/quizme/${id}`);
          if (fresh) return setQuiz((q) => (q && q.id === id ? fresh : q));
        } catch {
          // The answer is saved; only the next round didn't load. Check again fetches it (the answer stands).
          return setError("Your answer is saved, but the next round didn't load. Check your connection and tap Check answer again.");
        }
      }
      setQuiz((q) => (q && q.id === id ? withAnswer(q, item.at, r) : q));
    } catch (err) {
      setError(failureText(err, "Couldn't save that answer. Check your connection and try again."));
    } finally {
      setSaving(false);
    }
  }

  function next() {
    setIndex((i) => i + 1);
    setPicked(null);
    setError("");
  }

  function back() {
    // From the first question of a later round, back goes to the last question of the round before it.
    if (index === 0 && round > 1 && quiz) {
      setRound(round - 1);
      setIndex(Math.max(0, ofRound(quiz, round - 1).length - 1));
    } else {
      setIndex((i) => Math.max(0, i - 1));
    }
    setPicked(null);
    setError("");
  }

  /** Round `round` is answered and the quiz holds a later one with questions in it: the page in between. */
  const later = quiz && quiz.kind === "lecture" && quiz.round > round && ofRound(quiz, round).every((x) => x.q.chosen != null) ? ofRound(quiz, round + 1) : [];
  const nextRound = later.length > 0 ? later : null;

  /** From the page between rounds into the next round. */
  function startNextRound() {
    if (!quiz) return;
    setRound(round + 1);
    setIndex(firstOpen(quiz, round + 1));
    setPicked(null);
    setError("");
  }

  /** From the score back to the first question. */
  function lookBack() {
    setIndex(0);
    setPicked(null);
  }

  function done() {
    writing.current++;
    close();
    setQuiz(null);
    setStage("choose");
    setDraft(null);
  }

  // Report: the question leaves this quiz and its score; the owner gets the record.
  async function report(reason: string) {
    const item = shown[index];
    if (!quiz || !item) return;
    const id = quiz.id;
    const r = await call<{ ok: boolean; quiz: QuizMeView | null }>(`/api/quizme/${id}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: item.at, reason }),
    });
    if (!r?.quiz) return;
    setPicked(null);
    setQuiz((q) => (q && q.id === id ? r.quiz : q));
    // Reporting can empty the round on screen (its last copy is gone): fall back to the latest round that is left.
    if (r.quiz.round < round) {
      setRound(r.quiz.round);
      setIndex(firstOpen(r.quiz, r.quiz.round));
    }
  }

  const total = shown.length;
  const right = shown.filter((x) => x.q.chosen != null && x.q.chosen === x.q.correct_index).length;
  const firstRound = quiz ? ofRound(quiz, 1) : [];
  const firstRight = firstRound.filter((x) => x.q.chosen === x.q.correct_index).length;
  // Lecture review score: the first pass is what counts; later rounds say how much of it she has since got right.
  const latest = quiz ? ofRound(quiz, quiz.round) : [];
  const stillMissed = latest.filter((x) => x.q.chosen != null && x.q.chosen !== x.q.correct_index).length;
  const laterRight = quiz ? quiz.questions.filter((x) => !x.hidden && x.round > 1 && x.chosen != null && x.chosen === x.correct_index).length : 0;

  const title = stage === "quiz" && quiz ? (quiz.kind === "lecture" ? `Lecture review · ${quiz.text}` : "Quiz on what you selected") : "Quiz me on this";
  const showResume = !open && (stage === "writing" || (quiz != null && !quiz.finished && quiz.left > 0));

  return {
    open,
    setOpen,
    close,
    stage,
    draft,
    size,
    setSize,
    writingSize,
    quiz,
    index,
    round,
    picked,
    setPicked,
    saving,
    error,
    shown,
    total,
    right,
    firstRound,
    firstRight,
    stillMissed,
    laterRight,
    nextRound,
    title,
    showResume,
    fromSelection,
    resume,
    start,
    check,
    next,
    back,
    startNextRound,
    lookBack,
    done,
    report,
  };
}

export type QuizMeState = ReturnType<typeof useQuizMe>;
