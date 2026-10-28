"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import type { QuizMeAnswer, QuizMeView } from "@/lib/quizMe";
import { OptionRow } from "./OptionRow";
import { SlideImage } from "./SlideImage";
import { Icon, ICONS, type OptionState } from "./ui";
import { failureText, jsonOf, ServerMessage, signedOut } from "./clientFetch";
import { toast } from "./Toaster";
import { ReportQuestion } from "./ReportQuestion";

/** Keep in step with lib/quizMe.ts. */
const SIZES = [3, 5, 10] as const;
const MIN_CHARS = 20;
const MAX_CHARS = 2000;
const MIN_WORDS = 3;

type Pill = { left: number; top: number; text: string };
type Stage = "choose" | "writing" | "quiz";

/** A JSON request through the shared helpers: null when signed out (already handled), ServerMessage on a refusal. */
async function call<T>(url: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(url, init);
  if (signedOut(res)) return null;
  const json = await jsonOf<T & { error?: unknown }>(res);
  if (!res.ok || !json) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
  return json;
}

/** The selection's text, tidied, and cut at a word near MAX_CHARS when she selected a lot. */
function tidy(raw: string): { text: string; cut: boolean } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_CHARS) return { text, cut: false };
  const head = text.slice(0, MAX_CHARS);
  const space = head.lastIndexOf(" ");
  return { text: (space > MAX_CHARS * 0.8 ? head.slice(0, space) : head).trim(), cut: true };
}

const firstOpen = (q: QuizMeView) => {
  const shown = q.questions.filter((x) => !x.hidden);
  const i = shown.findIndex((x) => x.chosen == null);
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

/**
 * "Quiz me on this": select three or more words anywhere in the page's <main> (lesson, key points, explanations,
 * explanations) and a pill offers a short quiz on exactly that: 3, 5 or 10 questions written from the matching
 * slides, answered one at a time with a note on every option. Answers count toward mastery. An unfinished quiz is
 * kept and offered again ("Resume your quiz") the next time this exam's pages open.
 */
export function QuizMe({ examId, topicId, selection = true }: { examId: number; topicId?: number; /** Offer "Quiz me on this" on a text selection (off on pages with nothing to quiz on). */ selection?: boolean }) {
  const [pill, setPill] = useState<Pill | null>(null);
  const onPill = useRef(false);

  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [stage, setStage] = useState<Stage>("choose");
  const [draft, setDraft] = useState<{ text: string; cut: boolean } | null>(null);
  const [size, setSize] = useState<(typeof SIZES)[number]>(5);
  const [writingSize, setWritingSize] = useState(5);
  const [quiz, setQuiz] = useState<QuizMeView | null>(null);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Another part of the page (the lecture review card) hands over a quiz to run here.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const q = (e as CustomEvent<QuizMeView>).detail;
      if (!q || q.examId !== examId) return;
      setQuiz(q);
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

  // The pill: shown under a selection of three or more words inside the page's <main>.
  useEffect(() => {
    if (!selection) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (onPill.current) return; // tapping the pill can clear the selection first on phones
      const sel = window.getSelection();
      const r = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      const node = r?.commonAncestorContainer;
      const el = node ? (node instanceof Element ? node : node.parentElement) : null;
      if (!r || !el || !el.closest("main") || el.closest("input, textarea, [contenteditable='true'], [data-quizme]")) return setPill(null);
      const { text } = tidy(sel!.toString());
      if (text.split(" ").filter(Boolean).length < MIN_WORDS || text.length < MIN_CHARS) return setPill(null);
      const rect = r.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return setPill(null);
      // Below the selection (the Highlight pill sits above it, or below it when there's no room at the top: then
      // this one goes a row further down), kept on screen.
      const below = rect.bottom + 14 + (rect.top <= 64 ? 48 : 0);
      const top = Math.max(8, Math.min(below, window.innerHeight - 60));
      const left = Math.min(Math.max(rect.left + rect.width / 2, 92), window.innerWidth - 92);
      setPill({ left, top, text: sel!.toString() });
    };
    const onSel = () => {
      clearTimeout(t);
      t = setTimeout(update, 150);
    };
    const hide = () => setPill(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-quizme-pill]")) return;
      onPill.current = false;
      hide();
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
  }, [selection]);

  // The panel closes on Escape and takes focus when it opens.
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      window.dispatchEvent(new Event("quizme-closed"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function fromPill() {
    const text = pill?.text ?? "";
    onPill.current = false;
    setPill(null);
    window.getSelection()?.removeAllRanges();
    setOpen(true);
    if (stage === "writing") return; // one quiz at a time: the panel shows the one being written
    setDraft(tidy(text));
    setError("");
    setStage("choose");
  }

  function resume() {
    if (!quiz) return;
    setIndex(firstOpen(quiz));
    setPicked(null);
    setError("");
    setStage("quiz");
    setOpen(true);
  }

  async function start() {
    if (!draft || stage === "writing") return;
    setWritingSize(size);
    setStage("writing");
    setError("");
    try {
      const q = await call<QuizMeView>("/api/quizme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId, text: draft.text, size, ...(topicId != null ? { topicId } : {}) }),
      });
      if (!q) return;
      setQuiz(q);
      setIndex(firstOpen(q));
      setPicked(null);
      setStage("quiz");
      if (!openRef.current) toast("Your quiz is ready. Tap “Resume your quiz”.");
    } catch (err) {
      setError(failureText(err, "Couldn't write the quiz. Check your connection and try again."));
      setStage("choose");
      if (!openRef.current) toast("Couldn't write that quiz. Try again.", "error");
    }
  }

  const shown = quiz ? quiz.questions.map((q, at) => ({ q, at })).filter((x) => !x.q.hidden) : [];

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

  function done() {
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
  }

  const total = shown.length;
  const right = shown.filter((x) => x.q.chosen != null && x.q.chosen === x.q.correct_index).length;

  let body: React.ReactNode = null;
  if (stage === "writing") {
    body = (
      <div className="flex flex-col gap-3" aria-busy>
        <p className="text-[15px] font-semibold text-muted-foreground" role="status">
          Writing {writingSize} questions about this… about a minute.
        </p>
        <div className="shimmer h-5 w-3/4" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
      </div>
    );
  } else if (stage === "quiz" && quiz && index >= total) {
    body = (
      <div className="flex flex-col gap-4">
        <div className="rounded-[22px] bg-hero p-5 text-hero-foreground">
          <div className="text-[13px] font-extrabold text-hero-accent">Your score</div>
          <div className="mt-1 text-[22px] font-extrabold tracking-tight">
            {total > 0 ? `${Math.round((right / total) * 100)}% · ${right}/${total} right.` : "Nothing to score."}
          </div>
          <p className="mt-1 text-[14px] font-medium opacity-85">
            {quiz.kind === "lecture"
              ? "These answers count toward your mastery. What you got right won't come back; what you missed will be in this lecture's next review."
              : "These answers count toward your mastery."}
          </p>
        </div>
        <button type="button" className="btn-primary btn-lg" onClick={done}>
          Done
        </button>
      </div>
    );
  } else if (stage === "quiz" && quiz && shown[index]) {
    const { q } = shown[index];
    const answered = q.chosen != null;
    const stateOf = (i: number): OptionState =>
      answered ? (i === q.correct_index ? "correct" : i === q.chosen ? "wrong" : "dim") : i === picked ? "selected" : "default";
    const noteClass = (i: number) =>
      i === q.correct_index
        ? "rounded-[14px] bg-mint px-3 py-2 text-on-mint"
        : i === q.chosen
          ? "rounded-[14px] bg-coral px-3 py-2 text-on-coral"
          : "px-3 text-muted-foreground";
    body = (
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-bold text-muted-foreground">
            Question {index + 1} of {total}
          </div>
          <ReportQuestion onReport={report} />
        </div>
        {q.image && (
          <figure className="overflow-hidden rounded-[22px] bg-slide p-1.5">
            <SlideImage pageId={q.image.page_id} aspect={q.image.aspect} crop={answered ? null : q.image.crop} alt="Picture for this question" />
          </figure>
        )}
        <p className="px-1 text-[18px] leading-snug font-bold break-words">{q.question}</p>
        <div role="radiogroup" aria-label="Answer choices" className="flex flex-col gap-2">
          {q.options.map((o, i) => (
            <Fragment key={i}>
              <OptionRow
                index={i}
                text={o}
                state={stateOf(i)}
                checked={answered ? i === q.chosen : i === picked}
                onSelect={answered || saving ? undefined : () => setPicked(i)}
                crossed={false}
                ranges={[]}
                chips={
                  <>
                    {answered && i === q.correct_index && <span className="chip cb-mint shrink-0">✓ Correct</span>}
                    {answered && i === q.chosen && i !== q.correct_index && <span className="chip cb-coral shrink-0">✗ Yours</span>}
                  </>
                }
              />
              {answered && q.option_notes?.[i] && (
                <p className={`-mt-0.5 mb-1 ml-3 text-[14px] leading-snug font-semibold break-words ${noteClass(i)}`}>
                  <span className="sr-only">Option {String.fromCharCode(65 + i)}: </span>
                  {q.option_notes[i]}
                </p>
              )}
            </Fragment>
          ))}
        </div>
        {error && (
          <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
            {error}
          </p>
        )}
        {answered && q.explanation && (
          <div className="rounded-[22px] bg-hero p-5 text-hero-foreground">
            <div className="mb-1 text-[13px] font-extrabold text-hero-accent">
              {q.chosen === q.correct_index ? "Correct" : `Why ${String.fromCharCode(65 + (q.correct_index ?? 0))}`}
            </div>
            <div className="text-base leading-relaxed break-words [&_p]:my-1.5 [&_strong]:font-extrabold">
              <ReactMarkdown>{q.explanation}</ReactMarkdown>
            </div>
          </div>
        )}
        {answered ? (
          <button type="button" className="btn-primary btn-lg" onClick={next}>
            {index + 1 < total ? "Next →" : "See my score"}
          </button>
        ) : (
          <button type="button" className="btn-primary btn-lg" disabled={picked == null || saving} onClick={check}>
            {saving ? "Checking…" : "Check answer"}
          </button>
        )}
      </div>
    );
  } else {
    // Choosing: the highlighted text and how many questions.
    const text = draft?.text ?? "";
    body = (
      <div className="flex flex-col gap-4">
        <blockquote className="line-clamp-5 rounded-[18px] bg-muted px-4 py-3 text-[15px] leading-snug font-medium break-words text-foreground">
          “{text.length > 320 ? `${text.slice(0, 320).trimEnd()}…` : text}”
        </blockquote>
        {draft?.cut && <p className="text-[13px] font-semibold text-muted-foreground">That&apos;s a long passage: the first part of it will be used.</p>}
        <div>
          <div className="label" id="quizme-size">
            How many questions?
          </div>
          <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="quizme-size">
            {SIZES.map((n) => (
              <button key={n} type="button" className="seg" aria-pressed={size === n} onClick={() => setSize(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
            {error}
          </p>
        )}
        <button type="button" className="btn-primary btn-lg" disabled={!text} onClick={start}>
          Start
        </button>
      </div>
    );
  }

  const title = stage === "quiz" && quiz ? (quiz.kind === "lecture" ? `Lecture review · ${quiz.text}` : "Quiz on what you highlighted") : "Quiz me on this";
  const showResume = !open && (stage === "writing" || (quiz != null && !quiz.finished && quiz.left > 0));

  return (
    <>
      {pill &&
        !open &&
        createPortal(
          <div data-quizme-pill className="fixed z-50 -translate-x-1/2" style={{ left: pill.left, top: pill.top }}>
            <button
              type="button"
              onPointerDown={(e) => {
                onPill.current = true;
                e.preventDefault(); // keep the selection
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                fromPill();
              }}
              className="flex h-11 items-center gap-1.5 rounded-full bg-hero px-4 text-[14px] font-extrabold whitespace-nowrap text-hero-foreground shadow-[0_8px_24px_rgba(0,0,0,.25)]"
            >
              <Icon d={ICONS.check} size={16} />
              Quiz me on this
            </button>
          </div>,
          document.body,
        )}
      {showResume &&
        createPortal(
          <button
            type="button"
            data-quizme
            onClick={() => (stage === "writing" ? setOpen(true) : resume())}
            className="fixed left-3.5 bottom-[calc(168px+env(safe-area-inset-bottom))] z-30 flex h-11 max-w-[calc(100vw-28px)] items-center gap-2 rounded-full bg-hero px-4 text-[14px] font-extrabold text-hero-foreground shadow-[0_8px_24px_rgba(22,22,22,.18)] sm:left-[80px] sm:bottom-6"
          >
            <Icon d={ICONS.review} size={16} />
            <span className="truncate">
              {stage === "writing" ? "Writing your quiz…" : `Resume your ${quiz!.kind === "lecture" ? "lecture review" : "quiz"} (${quiz!.left} of ${quiz!.questions.filter((x) => !x.hidden).length} left)`}
            </span>
          </button>,
          document.body,
        )}
      {open &&
        createPortal(
          <div data-quizme>
            <div className="fixed inset-0 z-40 bg-black/30 sm:bg-black/10" onClick={close} aria-hidden />
            <div
              ref={panel}
              role="dialog"
              aria-modal="true"
              aria-labelledby="quizme-title"
              tabIndex={-1}
              className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-t-[28px] bg-card p-5 pb-[calc(20px+env(safe-area-inset-bottom))] shadow-[0_-12px_36px_rgba(22,22,22,.18)] outline-none sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-h-[calc(100vh-48px)] sm:w-[440px] sm:rounded-[24px] sm:pb-5 sm:shadow-[0_16px_48px_rgba(22,22,22,.22)]"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 id="quizme-title" className="text-[18px] font-extrabold tracking-tight">
                  {title}
                </h2>
                <button type="button" onClick={close} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted" aria-label="Close">
                  <Icon d={ICONS.close} size={18} />
                </button>
              </div>
              {body}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
