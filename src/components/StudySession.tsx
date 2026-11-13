"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "./Toaster";
import { ServerMessage, failureText, jsonOf, signedOut } from "./clientFetch";
import { Icon, ICONS, MasteryChip, Strip } from "./ui";
import { QuizMe } from "./QuizMe";
import { SectionNav } from "./study/SectionNav";
import { LessonView } from "./study/LessonView";
import { SectionQuiz } from "./study/SectionQuiz";
import { EndSession } from "./study/EndSession";
import type { LessonData, TopicLite } from "./study/types";

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
  // The section whose lesson has come back (written or failed): its quiz shows from then on, and stays through a "Try again".
  const [settled, setSettled] = useState<number | null>(null);
  const [visited, setVisited] = useState<Set<number>>(new Set([props.initialPosition]));
  const [ending, setEnding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endSummary, setEndSummary] = useState<string | null | undefined>(undefined);
  // Concept chip whose "Also in: …" line is open (a tap shows it; there is no hover on a phone).
  const [conceptOpen, setConceptOpen] = useState<number | null>(null);
  // The last position a lesson was asked for: a new position waits a moment to settle, a "Try again" goes at once.
  const asked = useRef(props.initialPosition);
  // Lessons already on their way or loaded: never prefetched (again).
  const prefetched = useRef(new Set<number>());

  // Tapping "Next section" five times must not write five lessons: wait ~400 ms for the position to settle, and drop
  // the request for a section she has already left. The header and section list follow `position` at once.
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => {
        asked.current = position;
        prefetched.current.add(position);
        fetch(`/api/sessions/${sessionId}/lesson?position=${position}`, { signal: ctrl.signal })
          .then(async (res) => {
            if (signedOut(res)) return;
            const json = await jsonOf<LessonData & { error?: unknown }>(res);
            if (!res.ok || !json?.lesson) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
            if (ctrl.signal.aborted) return;
            setResult({ position, data: json });
            setSettled(position);
          })
          .catch((err) => {
            if (ctrl.signal.aborted) return;
            setResult({ position, error: failureText(err, "Couldn't load this section. Check your connection and try again.") });
            setSettled(position);
          });
      },
      asked.current === position ? 0 : 400,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [position, attempt, sessionId]);

  const current = result?.position === position ? result : null;
  const data = current?.data ?? null;
  const error = current?.error ?? "";

  // Once the lesson is on screen, the section counts as studied and its quiz is started (server side). Once per
  // lesson shown; silent if it fails (one retry), since nothing on screen depends on it.
  const shownFor = useRef<LessonData | null>(null);
  useEffect(() => {
    if (!data || shownFor.current === data) return;
    shownFor.current = data;
    void markShown(sessionId, position);
  }, [data, sessionId, position]);

  // The next section's lesson is written ahead only once she reaches this section's quiz (it scrolls into view).
  const quizBlock = useRef<HTMLDivElement>(null);
  const hasLesson = data != null;
  useEffect(() => {
    const next = position + 1;
    const el = quizBlock.current;
    if (!hasLesson || !el || next >= topics.length || prefetched.current.has(next) || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || prefetched.current.has(next)) return;
      prefetched.current.add(next);
      seen.disconnect();
      // 204 (nothing to write ahead) or a failure: nothing to do; the lesson loads normally when she gets there.
      fetch(`/api/sessions/${sessionId}/lesson?position=${next}&prefetch=1`).catch(() => {});
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [hasLesson, position, sessionId, topics.length]);

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
      const json = await jsonOf<{ summary?: unknown }>(res);
      if (!res.ok || !json) throw new Error(String(res.status));
      setEndSummary(typeof json.summary === "string" ? json.summary : null);
    } catch {
      // Offline, or the server didn't answer. Her answers are already saved one by one; only the session note is missing.
      setEnding(false);
      toast("Couldn't end the session. Check your connection and try again.", "error");
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
          <button className="btn-primary btn-sm" onClick={endSession} disabled={ending} aria-busy={ending}>
            {ending && endSummary === undefined ? "Ending…" : "End session"}
          </button>
        </div>
      </div>
      {/* Phone: this lecture's sections (the whole list for an old-style map). */}
      {byLecture ? (
        <Strip total={topic.sections} filled={topic.section} className="px-1 lg:hidden" />
      ) : (
        <Strip total={topics.length} filled={position + 1} className="px-1 lg:hidden" />
      )}

      <EndSession summary={endSummary} covered={visited.size} starting={starting} onPractice={practiceCovered} examId={examId} />

      <div className="grid grid-cols-1 gap-2.5 sm:gap-4 lg:grid-cols-[240px_minmax(0,860px)] lg:justify-center">
        <SectionNav topics={topics} position={position} visited={visited} onGo={go} />

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
                {data.concepts.map((c) => {
                  const chip = "inline-flex items-center gap-1.5 rounded-[10px] bg-white/10 py-0.5 pr-2 pl-0.5 text-[13px] font-semibold";
                  const inner = (
                    <>
                      <MasteryChip value={c.mastery} className="px-1.5 py-0 text-[12px]" />
                      {c.name}
                      {c.earlier_exams.length > 0 && " ↺"}
                    </>
                  );
                  if (c.earlier_exams.length === 0) return <span key={c.id} className={chip}>{inner}</span>;
                  // Seen in other exams: a tap shows where (the hit area is 44 px tall; the chip looks the same).
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`${chip} relative text-left after:absolute after:inset-x-0 after:-inset-y-2.5 ${conceptOpen === c.id ? "ring-2 ring-white/40" : ""}`}
                      aria-expanded={conceptOpen === c.id}
                      title={`Also in: ${c.earlier_exams.join(", ")}`}
                      onClick={() => setConceptOpen((o) => (o === c.id ? null : c.id))}
                    >
                      {inner}
                    </button>
                  );
                })}
              </div>
            )}
            {data && conceptOpen != null && data.concepts.some((c) => c.id === conceptOpen) && (
              <p id="concept-also-in" className="text-[13px] font-semibold text-hero-muted">
                {(() => {
                  const c = data.concepts.find((x) => x.id === conceptOpen)!;
                  return `↺ ${c.name} is also in: ${c.earlier_exams.join(", ")}`;
                })()}
              </p>
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
          {data && <LessonView key={data.topic.id} data={data} />}
          {/* The quiz shows once this section has settled, even when its lesson failed (it doesn't need the lesson). */}
          {settled === position && (
            <div ref={quizBlock} className="flex flex-col">
              <SectionQuiz
                key={`quiz-${topic.id}`}
                sessionId={sessionId}
                position={position}
                isLast={isLast}
                label={byLecture ? `Section ${topic.section}` : `Topic ${position + 1}`}
                nextLabel={nextLabel}
                onNext={() => (isLast ? endSession() : go(position + 1))}
                lectureReview={(lastInLecture || isLast) && topic.lectureId != null ? { examId, documentId: topic.lectureId, lecture: topic.lecture ?? "" } : null}
              />
            </div>
          )}

          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <button className="btn-secondary btn-lg bg-card" disabled={position === 0} onClick={() => go(position - 1)}>← Back</button>
            {isLast ? (
              <button className="btn-primary btn-lg" onClick={endSession} disabled={ending}>
                {ending && endSummary === undefined ? "Ending…" : "Finish session"}
              </button>
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

/** Tells the server the section's lesson is on screen (marks it studied, starts its quiz). Silent: one retry, then gives up. */
async function markShown(sessionId: number, position: number) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/shown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position }),
      });
      // Done, or a refusal that a second try won't change (signed out, gone): nothing to show either way.
      if (res.status < 500) return;
    } catch {
      // Dropped connection: try once more.
    }
  }
}
