"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SlideImage, type CropBox } from "./SlideImage";
import { toast } from "./Toaster";
import { ServerMessage, failureText, jsonOf, signedOut } from "./clientFetch";
import { Icon, ICONS, MasteryChip, Strip, type OptionState } from "./ui";
import { OptionRow } from "./OptionRow";
import { Highlightable } from "./Highlightable";
import { useMarks } from "./useMarks";
import { QuizMe } from "./QuizMe";
import { ReportQuestion } from "./ReportQuestion";
import { LectureReviewCard } from "./LectureReviewCard";
import { MarkableText } from "./MarkableText";
import type { Range } from "@/lib/marks";

/**
 * A section of the topic map, with where it sits: its lecture (`lectureId` null for an old-style topic mapped across
 * lectures), the lecture's number and name, and the section's number among the lecture's `sections`.
 */
type TopicLite = {
  id: number;
  position: number;
  title: string;
  emphasized: boolean;
  lectureId: number | null;
  lectureNo: number | null;
  lecture: string;
  section: number;
  sections: number;
};
type LessonData = {
  topic: { id: number; title: string; summary: string; emphasized: boolean };
  concepts: { id: number; name: string; mastery: number | null; earlier_exams: string[] }[];
  lesson: {
    intro: string;
    slides: { page_id: number; explanation: string }[];
    key_points: string[];
    connections: string | null;
  };
  aspects: Record<number, number>;
  /** Every slide of the section: its number and lecture (shown above the picture) and whether she emphasized it in her notes. */
  slideInfo?: Record<number, { number: number; lecture: string; emphasized: boolean }>;
  stressed?: { page_id: number; where: string; point: string }[];
};
type QuizQ = {
  id?: string;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  /** One line per option (same order): why right / why wrong. Quizzes written before version 3 have none. */
  option_notes?: string[];
  concept: string;
  /** The picture the question is about, if any: shown cropped to the clinical image until answered, then whole. */
  image?: { page_id: number; aspect: number; crop: CropBox | null } | null;
  /** Reported earlier: skipped. Its place in the list (and the answer numbering) stays. */
  hidden?: boolean;
};

export function StudySession(props: {
  examId: number;
  examName: string;
  sessionId: number;
  initialPosition: number;
  topics: TopicLite[];
}) {
  const { examId, sessionId, topics } = props;
  const router = useRouter();
  const [position, setPosition] = useState(props.initialPosition);
  // Lesson results are tagged with their position so stale responses never show on the wrong topic.
  const [result, setResult] = useState<{ position: number; data?: LessonData; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [visited, setVisited] = useState<Set<number>>(new Set([props.initialPosition]));
  const [ending, setEnding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endSummary, setEndSummary] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/lesson?position=${position}`)
      .then(async (res) => {
        if (signedOut(res)) return;
        const json = await res.json();
        if (!cancelled) setResult(res.ok ? { position, data: json } : { position, error: json.error ?? "Could not load this topic." });
      })
      .catch((err) => !cancelled && setResult({ position, error: String(err) }));
    // Warm up the next topic so it's ready when the student gets there.
    if (position + 1 < topics.length) void fetch(`/api/sessions/${sessionId}/lesson?position=${position + 1}&prefetch=1`);
    return () => {
      cancelled = true;
    };
  }, [position, attempt, sessionId, topics.length]);

  const current = result?.position === position ? result : null;
  const data = current?.data ?? null;
  const error = current?.error ?? "";

  const go = (pos: number) => {
    setPosition(pos);
    setVisited((v) => new Set(v).add(pos));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  async function endSession() {
    if (ending) return;
    setEnding(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/end`, { method: "POST" });
      if (signedOut(res)) {
        setEnding(false);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      setEndSummary(json.summary ?? null);
    } catch {
      // Offline, or the server didn't answer: the "Saving…" overlay must not stay up forever. Answers are already saved one by one.
      setEnding(false);
      toast("Couldn't save the session notes. Check your connection and press End session again.", "error");
    }
  }

  async function practiceCovered() {
    if (starting) return;
    const topicIds = topics.filter((t) => visited.has(t.position)).map((t) => t.id);
    setStarting(true);
    try {
      const res = await fetch(`/api/exams/${examId}/attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: Math.min(25, Math.max(10, topicIds.length * 3)), mode: "tutor", style: "mixed", topicIds }),
      });
      if (signedOut(res)) return;
      const json = await jsonOf<{ id?: number; error?: string }>(res);
      if (!res.ok || !json?.id) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      router.push(`/attempts/${json.id}`);
    } catch (err) {
      setStarting(false);
      toast(failureText(err, "Couldn't start the practice exam. Check your connection and try again."), "error");
    }
  }

  const topic = topics[position];
  const isLast = position + 1 >= topics.length;
  const byLecture = topic.lectureId != null;
  // The last section of a lecture leads on to the next lecture; the very last one finishes the session.
  const lastInLecture = !isLast && topics[position + 1].lectureId !== topic.lectureId;
  const nextLabel = isLast ? "Finish session" : lastInLecture ? "Next lecture →" : "Next section →";
  const where = byLecture ? `Lecture ${topic.lectureNo ?? "?"} · Section ${topic.section} of ${topic.sections}` : `Topic ${position + 1} of ${topics.length}`;
  // Left column: sections under their lecture headers, in study order.
  const navGroups: { key: string; label: string | null; items: TopicLite[] }[] = [];
  for (const t of topics) {
    const key = String(t.lectureId);
    const last = navGroups.at(-1);
    if (last?.key === key) last.items.push(t);
    else navGroups.push({ key, label: t.lectureId != null ? `Lecture ${t.lectureNo ?? "?"} · ${t.lecture}` : null, items: [t] });
  }

  return (
    <div className="flex flex-col gap-2.5 sm:gap-4">
      <div className="flex items-center justify-between gap-3 px-1">
        <Link href={`/exams/${examId}`} className="flex min-w-0 items-center gap-1.5 text-[15px] font-bold text-muted-foreground hover:text-foreground">
          <Icon d={ICONS.arrowLeft} size={18} />
          <span className="truncate">{props.examName}</span>
        </Link>
        <div className="flex shrink-0 gap-1.5">
          <button className="btn-secondary btn-sm hidden lg:inline-flex" disabled={position === 0} onClick={() => go(position - 1)}>
            ← Previous
          </button>
          <button className="btn-secondary btn-sm hidden lg:inline-flex" disabled={isLast} onClick={() => go(position + 1)}>
            Next →
          </button>
          <button className="btn-primary btn-sm" onClick={endSession} disabled={ending}>
            End session
          </button>
        </div>
      </div>
      {/* Phone: this lecture's sections (the whole list for an old-style map). */}
      {byLecture ? (
        <Strip total={topic.sections} filled={topic.section} className="px-1 lg:hidden" />
      ) : (
        <Strip total={topics.length} filled={position + 1} className="px-1 lg:hidden" />
      )}

      {endSummary !== undefined && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3.5 sm:items-center">
          <div className="card flex w-full max-w-md flex-col gap-3">
            <h2 className="section-title">Session saved</h2>
            {endSummary && <p className="text-[15px] leading-relaxed">{endSummary}</p>}
            <p className="text-[15px] text-muted-foreground">
              Want to lock it in? Take a short practice exam on the {visited.size} section{visited.size === 1 ? "" : "s"} you covered.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button className="btn-primary btn-lg flex-1" disabled={starting} onClick={practiceCovered}>
                {starting ? "Starting…" : "Practice these topics"}
              </button>
              <Link className="btn-secondary btn-lg" href={`/exams/${examId}`}>Not now</Link>
            </div>
          </div>
        </div>
      )}
      {ending && endSummary === undefined && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="card text-[15px] font-semibold">Saving session notes…</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2.5 sm:gap-4 lg:grid-cols-[240px_minmax(0,860px)] lg:justify-center">
        <nav className="hidden lg:block" aria-label="Sections">
          <div className="card sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col gap-1 overflow-y-auto p-2.5">
            {navGroups.map((g) => (
              <div key={g.key} className="flex flex-col gap-1">
                {g.label && <div className="px-3 pt-2 pb-0.5 text-[12px] leading-snug font-extrabold text-muted-foreground">{g.label}</div>}
                <ol className="flex flex-col gap-1">
                  {g.items.map((t) => (
                    <li key={t.id}>
                      <button
                        onClick={() => go(t.position)}
                        aria-current={t.position === position ? "step" : undefined}
                        className={`flex w-full items-start gap-2 rounded-[16px] px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                          t.position === position
                            ? "bg-hero text-hero-foreground"
                            : visited.has(t.position)
                              ? "hover:bg-muted"
                              : "text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <span className="w-5 shrink-0 font-extrabold">{t.lectureId != null ? t.section : t.position + 1}</span>
                        <span>
                          {t.title}
                          {t.emphasized && " ★"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </nav>

        <article className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          <section className="card-hero flex flex-col gap-3">
            <div className="text-[13px] font-bold text-hero-muted">
              {where}
              {topic.emphasized && " · ★ you emphasized"}
            </div>
            {byLecture && <div className="-mt-2 text-[13px] font-semibold break-words text-hero-muted">{topic.lecture}</div>}
            <h1 className="text-[30px] leading-[1.05] font-extrabold tracking-[-0.03em] sm:text-[38px]">{topic.title}</h1>
            {data && data.concepts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {data.concepts.map((c) => (
                  <span
                    key={c.id}
                    className="inline-flex items-center gap-1.5 rounded-[10px] bg-white/10 py-0.5 pr-2 pl-0.5 text-[13px] font-semibold"
                    title={c.earlier_exams.length ? `Also in: ${c.earlier_exams.join(", ")}` : ""}
                  >
                    <MasteryChip value={c.mastery} className="px-1.5 py-0 text-[12px]" />
                    {c.name}
                    {c.earlier_exams.length > 0 && " ↺"}
                  </span>
                ))}
              </div>
            )}
          </section>

          {!data && !error && (
            <div className="card flex flex-col gap-3" aria-busy>
              <p className="text-[15px] font-semibold text-muted-foreground">Writing this section&apos;s lesson from every slide… the first time takes about a minute.</p>
              <div className="shimmer h-4 w-11/12" />
              <div className="shimmer h-4 w-10/12" />
              <div className="shimmer h-4 w-9/12" />
              <div className="shimmer h-40 w-full" />
            </div>
          )}
          {error && (
            <div className="tile cb-coral flex flex-wrap items-center justify-between gap-3 rounded-[28px]">
              <span className="text-[15px] font-semibold">{error}</span>
              <button className="btn-primary btn-sm" onClick={() => { setResult(null); setAttempt((a) => a + 1); }}>Try again</button>
            </div>
          )}
          {data && <Lesson key={data.topic.id} data={data} />}
          {data && (
            <SectionQuiz
              key={`quiz-${data.topic.id}`}
              sessionId={sessionId}
              position={position}
              isLast={isLast}
              label={byLecture ? `Section ${topic.section}` : `Topic ${position + 1}`}
              nextLabel={nextLabel}
              onNext={() => (isLast ? endSession() : go(position + 1))}
              lectureReview={(lastInLecture || isLast) && topic.lectureId != null ? { examId, documentId: topic.lectureId, lecture: topic.lecture ?? "" } : null}
            />
          )}

          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <button className="btn-secondary btn-lg bg-card" disabled={position === 0} onClick={() => go(position - 1)}>← Back</button>
            {isLast ? (
              <button className="btn-primary btn-lg" onClick={endSession}>Finish session</button>
            ) : (
              <button className="btn-primary btn-lg" onClick={() => go(position + 1)}>{nextLabel}</button>
            )}
          </div>
        </article>

        {/* Highlight any text in the lesson or quiz and get "Quiz me on this" (3 / 5 / 10 questions on that passage). */}
        <QuizMe examId={examId} topicId={topic?.id} />
      </div>

    </div>
  );
}

function Lesson({ data }: { data: LessonData }) {
  const { lesson } = data;
  const [zoom, setZoom] = useState<number | null>(null);
  const slides = lesson.slides ?? [];
  return (
    <>
      <section className="card">
        {lesson.intro && (
          <MarkableText marksKey={`lesson:${data.topic.id}:0:${lesson.intro.length}`}>
            <p className="prose-study text-[18px] font-semibold">{lesson.intro}</p>
          </MarkableText>
        )}
        {slides.length === 0 && <p className="prose-study text-muted-foreground">This section has no slides to walk through.</p>}
        {/* The lecture, one slide at a time: the slide's picture (tap to zoom) with its plain-words explanation under it. */}
        <ol className="mt-2 flex flex-col gap-8">
          {slides.map((s, i) => {
            const info = data.slideInfo?.[s.page_id];
            const number = info?.number ?? i + 1;
            return (
              <li key={s.page_id} className="flex flex-col gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[17px] font-extrabold tracking-tight">Slide {number}</span>
                  {info?.lecture && <span className="text-[13px] font-semibold text-muted-foreground">{info.lecture}</span>}
                  {info?.emphasized && <span className="chip cb-coral">★ You emphasized this</span>}
                </div>
                <button onClick={() => setZoom(s.page_id)} className="group relative block w-full overflow-hidden rounded-[22px] bg-slide p-1.5" aria-label={`Zoom slide ${number}`}>
                  <SlideImage pageId={s.page_id} aspect={data.aspects?.[s.page_id]} alt={`Slide ${number}`} />
                  <span className="absolute right-3 bottom-3 flex h-9 w-9 items-center justify-center rounded-xl bg-black/50 text-white opacity-90 group-hover:opacity-100">
                    <Icon d={ICONS.zoom} size={18} />
                  </span>
                </button>
                {/* Highlight / underline any of the explanation (saved to her account), and "Quiz me on this". */}
                <MarkableText marksKey={`lesson:${data.topic.id}:${s.page_id}:${s.explanation.length}`} className="prose-study">
                  <ReactMarkdown>{s.explanation}</ReactMarkdown>
                </MarkableText>
              </li>
            );
          })}
        </ol>
      </section>
      {zoom != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(null)}>
          <div className="w-full max-w-5xl">
            <SlideImage pageId={zoom} aspect={data.aspects?.[zoom]} alt="Slide" />
          </div>
        </div>
      )}

      {data.stressed && data.stressed.length > 0 && (
        <section className="tile cb-coral rounded-[28px]">
          <h2 className="mb-1 text-[22px] font-extrabold tracking-tight">★ You emphasized this</h2>
          <p className="mb-3 text-[13px] font-semibold opacity-80">Starred, highlighted or marked in your lecture notes. Expect it on the exam.</p>
          <ul className="flex flex-col gap-2">
            {data.stressed.map((s) => (
              <li key={s.page_id}>
                <button onClick={() => setZoom(s.page_id)} className="w-full rounded-[18px] bg-white/45 px-4 py-3 text-left transition-colors hover:bg-white/60">
                  <span className="block text-[15px] leading-snug font-bold">★ {s.point}</span>
                  <span className="mt-0.5 block text-[12px] font-semibold opacity-75">{s.where} · tap to see the slide</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tile cb-butter rounded-[28px]">
        <h2 className="mb-3 text-[22px] font-extrabold tracking-tight">Key points</h2>
        <ol className="flex flex-col gap-2.5">
          {lesson.key_points.map((k, i) => (
            <li key={k} className="flex gap-3 text-[15px] leading-snug font-medium">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-on-butter text-[12px] font-extrabold text-butter">{i + 1}</span>
              {k}
            </li>
          ))}
        </ol>
      </section>

      {lesson.connections && (
        <section className="tile cb-lilac rounded-[28px]">
          <h2 className="text-[18px] font-extrabold">↺ Also in your other lectures</h2>
          <p className="mb-2 text-[13px] font-semibold opacity-80">Where this topic shows up in lectures you uploaded for other exams. Just for context: quiz and exam questions come only from this topic&apos;s slides.</p>
          <div className="text-[15px] leading-relaxed [&_p]:my-0 [&_strong]:font-extrabold">
            <ReactMarkdown>{lesson.connections}</ReactMarkdown>
          </div>
        </section>
      )}
    </>
  );
}

/**
 * End-of-section quiz: one question at a time, with a way to skip ahead or stop and see the score at any point.
 * `index` counts the questions shown (reported ones are skipped); answers are keyed by the question's place in the quiz.
 */
function SectionQuiz({
  sessionId,
  position,
  isLast,
  label,
  nextLabel,
  onNext,
  lectureReview,
}: {
  sessionId: number;
  position: number;
  isLast: boolean;
  /** "Section 3" (or "Topic 3" on an old-style map), for the score line. */
  label: string;
  /** "Next section →", "Next lecture →" on a lecture's last section, "Finish session" on the very last. */
  nextLabel: string;
  onNext: () => void;
  /** Set on a lecture's last section: the end-of-lecture review card goes under the score. */
  lectureReview: { examId: number; documentId: number; lecture: string } | null;
}) {
  const [quiz, setQuiz] = useState<{ topicId: number; questions: QuizQ[]; slides: number } | null>(null);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // While "Write new questions" runs, answering is paused so no answer lands on a question that's about to be replaced.
  const [rewriting, setRewriting] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/quiz?position=${position}`)
      .then(async (res) => {
        if (signedOut(res)) return;
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) return setError(json.error ?? "Couldn't load the quiz.");
        const answered = Object.fromEntries(Object.entries(json.answered as Record<string, number>).map(([k, v]) => [Number(k), v]));
        setQuiz({ topicId: json.topicId, questions: json.questions, slides: Number(json.slides) || 0 });
        setAnswers(answered);
        // Pick up where the student left off.
        const shown = (json.questions as QuizQ[]).map((q, i) => ({ q, i })).filter((x) => !x.q.hidden);
        const firstOpen = shown.findIndex((x) => answered[x.i] == null);
        setIndex(firstOpen === -1 ? shown.length : firstOpen);
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, position, attempt]);

  const skipLabel = isLast ? "Skip & finish session" : nextLabel === "Next lecture →" ? "Skip to next lecture →" : "Skip to next section →";
  const skip = (
    <button className="btn-ghost px-1" onClick={onNext}>
      {skipLabel}
    </button>
  );
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
  /** "Retake this quiz": the same questions, her answers for this section cleared (asks first). */
  const [retaking, setRetaking] = useState(false);
  async function retake() {
    if (!quiz || retaking) return;
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

  if (error) {
    return (
      <section className="tile cb-coral flex flex-col gap-3 rounded-[28px]">
        <div>
          <div className="text-[17px] font-extrabold">Couldn&apos;t write the quiz for this section right now.</div>
          <div className="mt-1 text-[13px] font-medium opacity-80">{error}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary btn-sm" onClick={() => { setError(""); setAttempt((a) => a + 1); }}>Try again</button>
          <button className="btn-ghost btn-sm text-on-coral" onClick={onNext}>
            {skipLabel}
          </button>
        </div>
      </section>
    );
  }
  if (!quiz) {
    return (
      <section className="card flex flex-col gap-3" aria-busy>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[15px] font-semibold text-muted-foreground">
            Writing this section&apos;s quiz (one question per fact on its slides) and checking it against the slides… about 1–2 minutes. Keep reading; it&apos;ll appear here.
          </span>
          {skip}
        </div>
        <div className="shimmer h-5 w-3/4" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
      </section>
    );
  }

  // Reported questions are skipped; `at` is each one's place in the stored quiz (what answers are keyed by).
  const shown = quiz.questions.map((q, at) => ({ q, at })).filter((x) => !x.q.hidden);
  const total = shown.length;
  const right = shown.filter((x) => answers[x.at] === x.q.correct_index).length;
  const done = shown.filter((x) => answers[x.at] != null).length;

  function check() {
    const at = shown[index]?.at;
    if (at == null || picked == null || answers[at] != null) return;
    const chosen = picked;
    setSaveError("");
    setAnswers((a) => ({ ...a, [at]: chosen }));
    fetch(`/api/sessions/${sessionId}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: quiz!.topicId, index: at, chosen }),
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

  const strip = (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, total)}, minmax(0, 1fr))` }}>
      {shown.map(({ q, at }, i) => (
        <button
          key={q.id ?? at}
          onClick={() => goTo(i)}
          aria-label={`Question ${i + 1}${answers[at] == null ? "" : answers[at] === q.correct_index ? ", right" : ", wrong"}`}
          className={`h-1.5 rounded-full ${
            answers[at] == null ? (i === index ? "bg-foreground" : "bg-muted-strong") : answers[at] === q.correct_index ? "bg-hero" : "bg-coral"
          }`}
        />
      ))}
    </div>
  );

  // Finished (or stopped early): score and what to look at again.
  if (index >= total) {
    const missed = shown.filter((x) => answers[x.at] != null && answers[x.at] !== x.q.correct_index).map((x) => x.q);
    const good = done > 0 && right / done >= 0.8;
    return (
      <section ref={box} className={`tile scroll-mt-3 flex flex-col gap-4 rounded-[28px] ${good ? "cb-mint" : "bg-card"}`}>
        {strip}
        <div>
          <div ref={heading} tabIndex={-1} className="text-[13px] font-bold opacity-75 outline-none">Section quiz</div>
          <div className="text-[30px] leading-tight font-extrabold tracking-[-0.03em]">
            {good ? `${label}, done.` : done === 0 ? "No questions answered." : "Worth another look."}
          </div>
          {done > 0 && (
            <div className="mt-1 text-[17px] font-bold">
              {Math.round((right / done) * 100)}% · {right}/{done} right{done < total && <span className="font-medium opacity-75"> · {total - done} skipped</span>}
            </div>
          )}
        </div>
        {missed.length > 0 && (
          <div>
            <div className="mb-1.5 text-[13px] font-bold opacity-75">Look again at</div>
            <div className="flex flex-wrap gap-1.5">
              {[...new Set(missed.map((q) => q.concept))].map((c) => (
                <span key={c} className="chip cb-coral">{c}</span>
              ))}
            </div>
          </div>
        )}
        {lectureReview && <LectureReviewCard examId={lectureReview.examId} documentId={lectureReview.documentId} lecture={lectureReview.lecture} />}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            <button className="btn-secondary btn-lg" onClick={() => goTo(0)}>Look back at the questions</button>
            {done > 0 && (
              <button className="btn-ghost btn-lg" disabled={retaking} onClick={retake}>
                {retaking ? "Clearing…" : "Retake this quiz"}
              </button>
            )}
          </div>
          <button className="btn-primary btn-lg" onClick={onNext}>{nextLabel}</button>
        </div>
        <RegenerateQuiz sessionId={sessionId} topicId={quiz.topicId} onDone={reload} onWorking={setRewriting} />
      </section>
    );
  }

  const { q, at } = shown[index];
  const chosen = answers[at];
  const answered = chosen != null;
  const stateOf = (i: number): OptionState =>
    answered ? (i === q.correct_index ? "correct" : i === chosen ? "wrong" : "dim") : i === picked ? "selected" : "default";
  // Report: the question leaves this quiz (and its score) at once; the server hides it in every copy of the exam.
  const report = async (reason: string) => {
    const res = await fetch(`/api/sessions/${sessionId}/quiz/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: quiz.topicId, questionId: q.id, reason }),
    });
    if (signedOut(res)) return;
    if (!res.ok) throw new Error(String(res.status));
    setPicked(null);
    setQuiz((z) => (z ? { ...z, questions: z.questions.map((x) => (x.id === q.id ? { ...x, hidden: true } : x)) } : z));
  };

  return (
    <section ref={box} className="card scroll-mt-3 flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div ref={heading} tabIndex={-1} className="text-[13px] font-bold text-muted-foreground outline-none">
          Section quiz · {index + 1} of {total}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {q.id && <ReportQuestion onReport={report} />}
          {done > 0 && (
            <button className="btn-ghost px-1" onClick={() => goTo(total)}>
              I&apos;m done — see my score
            </button>
          )}
          {skip}
        </div>
      </div>
      {strip}
      {index === 0 && !answered && (
        <p className="px-1 text-[13px] font-semibold text-muted-foreground">
          {total === 1 ? "One question" : `${total} questions`} covering every fact on this section&apos;s {quiz.slides} {quiz.slides === 1 ? "slide" : "slides"}.
        </p>
      )}
      <QuizBody key={q.id ?? at} q={q} stateOf={stateOf} answered={answered || rewriting} chosen={chosen} picked={picked} onPick={setPicked} />
      {saveError && <p className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">{saveError}</p>}
      {answered && (
        <div className="rounded-[22px] bg-hero p-5 text-hero-foreground">
          <div className="mb-1 text-[13px] font-extrabold text-hero-accent">{chosen === q.correct_index ? "Correct" : `Why ${String.fromCharCode(65 + q.correct_index)}`}</div>
          <div className="text-base leading-relaxed [&_p]:my-1.5 [&_strong]:font-extrabold">
            <ReactMarkdown>{q.explanation}</ReactMarkdown>
          </div>
        </div>
      )}
      {answered ? (
        <button className="btn-primary btn-lg" onClick={() => goTo(index + 1)}>
          {index + 1 < total ? "Next question →" : "See my score"}
        </button>
      ) : (
        <button className="btn-primary btn-lg" disabled={picked == null || rewriting} onClick={check}>
          Check answer
        </button>
      )}
      <RegenerateQuiz sessionId={sessionId} topicId={quiz.topicId} onDone={reload} onWorking={setRewriting} />
    </section>
  );
}

/** A quiz question's text and options, with the student's highlights and cross-outs (saved per question id). */
function QuizBody({
  q,
  stateOf,
  answered,
  chosen,
  picked,
  onPick,
}: {
  q: QuizQ;
  stateOf: (i: number) => OptionState;
  answered: boolean;
  chosen: number | undefined;
  picked: number | null;
  onPick: (i: number) => void;
}) {
  const [marks, setMarks] = useMarks(q.id ? `quiz:${q.id}` : null);
  const setHl = (field: string) => (r: Range[]) => setMarks((m) => ({ ...m, hl: { ...m.hl, [field]: r } }));
  const toggleCross = (i: number) =>
    setMarks((m) => ({ ...m, crossed: m.crossed.includes(i) ? m.crossed.filter((x) => x !== i) : [...m.crossed, i].sort() }));
  return (
    <>
      {q.image && (
        <figure className="overflow-hidden rounded-[22px] bg-slide p-1.5">
          <SlideImage pageId={q.image.page_id} aspect={q.image.aspect} crop={answered ? null : q.image.crop} alt="Picture for this question" />
        </figure>
      )}
      <p className="px-1 text-[18px] leading-snug font-bold">
        <Highlightable text={q.question} ranges={marks.hl.stem ?? []} onChange={setHl("stem")} />
      </p>
      <div role="radiogroup" aria-label="Answer choices" className="flex flex-col gap-2">
        {q.options.map((o, i) => (
          <OptionRow
            key={i}
            index={i}
            text={o}
            state={stateOf(i)}
            checked={answered ? i === chosen : i === picked}
            onSelect={
              answered
                ? undefined
                : () => {
                    if (marks.crossed.includes(i)) toggleCross(i);
                    onPick(i);
                  }
            }
            crossed={marks.crossed.includes(i)}
            // The option she has picked can't also be crossed out.
            onToggleCross={!answered && i === picked ? undefined : () => toggleCross(i)}
            note={answered ? q.option_notes?.[i] : undefined}
            ranges={marks.hl[`opt${i}`] ?? []}
            onRanges={setHl(`opt${i}`)}
            chips={
              <>
                {answered && i === q.correct_index && <span className="chip cb-mint shrink-0">✓ Correct</span>}
                {answered && i === chosen && i !== q.correct_index && <span className="chip cb-coral shrink-0">✗ Yours</span>}
              </>
            }
          />
        ))}
      </div>
    </>
  );
}

/**
 * "Write new questions": the one way a section's quiz changes. Asks first (it takes a minute or two and costs a
 * little), then has the server write a fresh 20 (the old ones stay until the new ones are ready), and reloads the quiz.
 */
function RegenerateQuiz({
  sessionId,
  topicId,
  onDone,
  onWorking,
}: {
  sessionId: number;
  topicId: number;
  onDone: () => void;
  /** Told when the rewrite starts and stops, so the quiz can lock its answer buttons meanwhile. */
  onWorking?: (working: boolean) => void;
}) {
  const [state, setState] = useState<"idle" | "confirm" | "working" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => () => onWorking?.(false), [onWorking]);

  async function run() {
    setState("working");
    onWorking?.(true);
    setError("");
    const res = await fetch(`/api/sessions/${sessionId}/quiz/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId }),
    }).catch(() => null);
    onWorking?.(false);
    if (res?.ok) return onDone();
    const json = res ? await res.json().catch(() => ({})) : {};
    setError((json as { error?: string }).error ?? "Couldn't reach the server. Check your connection and try again.");
    setState("error");
  }

  if (state === "idle") {
    return (
      <div className="flex justify-end">
        <button className="btn-ghost px-1 text-[13px]" onClick={() => setState("confirm")}>
          Write new questions for this section
        </button>
      </div>
    );
  }
  if (state === "working") {
    return (
      <div className="rounded-[20px] bg-muted px-4 py-3 text-[14px] font-semibold text-muted-foreground" aria-busy>
        Writing a new set of questions (one per fact on these slides) and checking them against your slides… about 1–2 minutes. Keep this page open.
      </div>
    );
  }
  return (
    <div role="alertdialog" aria-label="Write new questions?" className="tile cb-butter flex flex-col gap-2.5 rounded-[22px]">
      <p className="text-[15px] font-bold">Replace this section&apos;s questions with 20 new ones?</p>
      <p className="text-[13px] font-medium opacity-80">
        Takes 1–2 minutes and uses a little AI credit. Your answers to the current questions stay in your history but won&apos;t show here any more.
      </p>
      {state === "error" && <p className="text-[13px] font-bold">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary btn-sm" onClick={run}>
          {state === "error" ? "Try again" : "Yes, write new questions"}
        </button>
        <button type="button" className="btn-secondary btn-sm bg-card" autoFocus onClick={() => setState("idle")}>
          Keep these
        </button>
      </div>
    </div>
  );
}
