"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SlideImage } from "./SlideImage";
import { Icon, ICONS, MasteryChip, optionClasses, Strip, type OptionState } from "./ui";

type TopicLite = { id: number; position: number; title: string; emphasized: boolean };
type ChatMsg = { id?: number; role: "user" | "assistant"; content: string };
type LessonData = {
  topic: { id: number; title: string; summary: string; emphasized: boolean };
  concepts: { id: number; name: string; mastery: number | null; earlier_exams: string[] }[];
  lesson: {
    explanation: string;
    key_points: string[];
    slides: { page_id: number; caption: string }[];
    connections: string | null;
  };
  aspects: Record<number, number>;
};
type QuizQ = { question: string; options: string[]; correct_index: number; explanation: string; concept: string };

export function StudySession(props: {
  examId: number;
  examName: string;
  sessionId: number;
  initialPosition: number;
  topics: TopicLite[];
  initialChat: ChatMsg[];
}) {
  const { examId, sessionId, topics } = props;
  const router = useRouter();
  const [position, setPosition] = useState(props.initialPosition);
  // Lesson results are tagged with their position so stale responses never show on the wrong topic.
  const [result, setResult] = useState<{ position: number; data?: LessonData; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [visited, setVisited] = useState<Set<number>>(new Set([props.initialPosition]));
  const [ending, setEnding] = useState(false);
  const [endSummary, setEndSummary] = useState<string | null | undefined>(undefined);
  const [chatOpen, setChatOpen] = useState(false);
  const closeChat = useCallback(() => setChatOpen(false), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/lesson?position=${position}`)
      .then(async (res) => {
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
    setEnding(true);
    const res = await fetch(`/api/sessions/${sessionId}/end`, { method: "POST" });
    const json = await res.json();
    setEndSummary(json.summary ?? null);
  }

  async function practiceCovered() {
    const topicIds = topics.filter((t) => visited.has(t.position)).map((t) => t.id);
    const res = await fetch(`/api/exams/${examId}/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: Math.min(25, Math.max(10, topicIds.length * 3)), mode: "tutor", style: "mixed", topicIds }),
    });
    const { id } = await res.json();
    router.push(`/attempts/${id}`);
  }

  const topic = topics[position];
  const isLast = position + 1 >= topics.length;

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
      <Strip total={topics.length} filled={position + 1} className="px-1 lg:hidden" />

      {endSummary !== undefined && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3.5 sm:items-center">
          <div className="card flex w-full max-w-md flex-col gap-3">
            <h2 className="section-title">Session saved</h2>
            {endSummary && <p className="text-[15px] leading-relaxed">{endSummary}</p>}
            <p className="text-[15px] text-muted-foreground">
              Want to lock it in? Take a short practice exam on the {visited.size} topic{visited.size === 1 ? "" : "s"} you covered.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button className="btn-primary btn-lg flex-1" onClick={practiceCovered}>Practice these topics</button>
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

      <div className="grid grid-cols-1 gap-2.5 sm:gap-4 lg:grid-cols-[240px_minmax(0,1fr)_380px]">
        <nav className="hidden lg:block" aria-label="Topics">
          <ol className="card sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col gap-1 overflow-y-auto p-2.5">
            {topics.map((t) => (
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
                  <span className="w-5 shrink-0 font-extrabold">{t.position + 1}</span>
                  <span>
                    {t.title}
                    {t.emphasized && " ★"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <article className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          <section className="card-hero flex flex-col gap-3">
            <div className="text-[13px] font-bold text-hero-muted">
              Topic {position + 1} of {topics.length}
              {topic.emphasized && " · ★ emphasized in lecture"}
            </div>
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
              <p className="text-[15px] font-semibold text-muted-foreground">Preparing this topic from your slides… (the first time takes about 30 seconds)</p>
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
              onNext={() => (isLast ? endSession() : go(position + 1))}
            />
          )}

          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <button className="btn-secondary btn-lg bg-card" disabled={position === 0} onClick={() => go(position - 1)}>← Back</button>
            {isLast ? (
              <button className="btn-primary btn-lg" onClick={endSession}>Finish session</button>
            ) : (
              <button className="btn-primary btn-lg" onClick={() => go(position + 1)}>Next topic →</button>
            )}
          </div>
        </article>

        <TutorChat sessionId={sessionId} position={position} initial={props.initialChat} open={chatOpen} onClose={closeChat} />
      </div>

      {/* Phone: floating button that opens the tutor as a bottom sheet. */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed right-4 bottom-[calc(100px+env(safe-area-inset-bottom))] z-30 flex h-14 items-center gap-2 rounded-full bg-hero px-5 text-[15px] font-extrabold text-hero-foreground shadow-[0_10px_30px_rgba(14,94,85,.35)] lg:hidden"
        >
          <Icon d={ICONS.chat} /> Tutor
        </button>
      )}
    </div>
  );
}

function Lesson({ data }: { data: LessonData }) {
  const { lesson } = data;
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <>
      <section className="card">
        <div className="prose-study">
          <ReactMarkdown>{lesson.explanation}</ReactMarkdown>
        </div>
        {lesson.slides.length > 0 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {lesson.slides.map((s) => (
              <figure key={s.page_id} className="flex flex-col gap-2">
                <button onClick={() => setZoom(s.page_id)} className="group relative block w-full overflow-hidden rounded-[22px] bg-slide p-1.5" aria-label={`Zoom: ${s.caption}`}>
                  <SlideImage pageId={s.page_id} alt={s.caption} />
                  <span className="absolute right-3 bottom-3 flex h-9 w-9 items-center justify-center rounded-xl bg-black/50 text-white opacity-90 group-hover:opacity-100">
                    <Icon d={ICONS.zoom} size={18} />
                  </span>
                </button>
                <figcaption className="px-1.5 text-[13px] font-medium text-muted-foreground">{s.caption}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>
      {zoom != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(null)}>
          <div className="w-full max-w-5xl">
            <SlideImage pageId={zoom} alt="Slide" />
          </div>
        </div>
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
          <h2 className="mb-1.5 text-[18px] font-extrabold">↺ Connects to earlier exams</h2>
          <div className="text-[15px] leading-relaxed [&_p]:my-0 [&_strong]:font-extrabold">
            <ReactMarkdown>{lesson.connections}</ReactMarkdown>
          </div>
        </section>
      )}
    </>
  );
}

/** End-of-section quiz: one question at a time, with a way to skip ahead at any point. */
function SectionQuiz({ sessionId, position, isLast, onNext }: { sessionId: number; position: number; isLast: boolean; onNext: () => void }) {
  const [quiz, setQuiz] = useState<{ topicId: number; questions: QuizQ[] } | null>(null);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/quiz?position=${position}`)
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) return setError(json.error ?? "Couldn't load the quiz.");
        const answered = Object.fromEntries(Object.entries(json.answered as Record<string, number>).map(([k, v]) => [Number(k), v]));
        setQuiz({ topicId: json.topicId, questions: json.questions });
        setAnswers(answered);
        // Pick up where the student left off.
        const firstOpen = (json.questions as QuizQ[]).findIndex((_, i) => answered[i] == null);
        setIndex(firstOpen === -1 ? json.questions.length : firstOpen);
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, position, attempt]);

  const skip = (
    <button className="btn-ghost px-1" onClick={onNext}>
      {isLast ? "Skip & finish session" : "Skip to next section →"}
    </button>
  );

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
            {isLast ? "Skip & finish session" : "Skip to next section →"}
          </button>
        </div>
      </section>
    );
  }
  if (!quiz) {
    return (
      <section className="card flex flex-col gap-3" aria-busy>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[15px] font-semibold text-muted-foreground">Writing a quiz for this section… keep reading, it&apos;ll be ready in a moment.</span>
          {skip}
        </div>
        <div className="shimmer h-5 w-3/4" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
      </section>
    );
  }

  const total = quiz.questions.length;
  const right = quiz.questions.filter((q, i) => answers[i] === q.correct_index).length;
  const done = Object.keys(answers).length;

  function check() {
    if (picked == null || answers[index] != null) return;
    const at = index;
    const chosen = picked;
    setSaveError("");
    setAnswers((a) => ({ ...a, [at]: chosen }));
    fetch(`/api/sessions/${sessionId}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: quiz!.topicId, index: at, chosen }),
    })
      .then((res) => {
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
    setIndex(i);
  };

  const strip = (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
      {quiz.questions.map((q, i) => (
        <button
          key={i}
          onClick={() => goTo(i)}
          aria-label={`Question ${i + 1}${answers[i] == null ? "" : answers[i] === q.correct_index ? ", right" : ", wrong"}`}
          className={`h-1.5 rounded-full ${
            answers[i] == null ? (i === index ? "bg-foreground" : "bg-muted-strong") : answers[i] === q.correct_index ? "bg-hero" : "bg-coral"
          }`}
        />
      ))}
    </div>
  );

  // Finished: score and what to look at again.
  if (index >= total) {
    const missed = quiz.questions.filter((q, i) => answers[i] != null && answers[i] !== q.correct_index);
    const good = done > 0 && right / done >= 0.8;
    return (
      <section className={`tile flex flex-col gap-4 rounded-[28px] ${good ? "cb-mint" : "bg-card"}`}>
        {strip}
        <div>
          <div className="text-[13px] font-bold opacity-75">Section quiz</div>
          <div className="text-[30px] leading-tight font-extrabold tracking-[-0.03em]">
            {good ? `Topic ${position + 1}, done.` : done === 0 ? "No questions answered." : "Worth another look."}
          </div>
          {done > 0 && (
            <div className="mt-1 text-[17px] font-bold">
              {right}/{done} right{done < total && <span className="font-medium opacity-75"> · {total - done} skipped</span>}
            </div>
          )}
        </div>
        {!good && done > 0 && <p className="text-[15px] text-muted-foreground">Ask the tutor about anything that&apos;s unclear before moving on.</p>}
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
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <button className="btn-secondary btn-lg" onClick={() => goTo(0)}>Look back at the questions</button>
          <button className="btn-primary btn-lg" onClick={onNext}>{isLast ? "Finish session" : "Next section →"}</button>
        </div>
      </section>
    );
  }

  const q = quiz.questions[index];
  const chosen = answers[index];
  const answered = chosen != null;
  const stateOf = (i: number): OptionState =>
    answered ? (i === q.correct_index ? "correct" : i === chosen ? "wrong" : "dim") : i === picked ? "selected" : "default";

  return (
    <section className="card flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-bold text-muted-foreground">
          Section quiz · {index + 1} of {total}
        </div>
        {skip}
      </div>
      {strip}
      <p className="px-1 text-[18px] leading-snug font-bold">{q.question}</p>
      <div className="flex flex-col gap-2">
        {q.options.map((o, i) => {
          const s = optionClasses(stateOf(i));
          return (
            <button
              key={i}
              onClick={() => !answered && setPicked(i)}
              disabled={answered}
              aria-pressed={!answered ? i === picked : undefined}
              className={`flex min-h-[58px] items-center gap-3 rounded-[18px] border-2 px-3.5 py-3 text-left transition-colors disabled:cursor-default ${s.row}`}
            >
              <span className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] text-sm font-extrabold ${s.key}`}>
                {String.fromCharCode(65 + i)}
              </span>
              <span className="flex-1 text-base leading-snug font-semibold">{o}</span>
              {answered && i === q.correct_index && <span className="chip cb-mint shrink-0">✓ Correct</span>}
              {answered && i === chosen && i !== q.correct_index && <span className="chip cb-coral shrink-0">✗ Yours</span>}
            </button>
          );
        })}
      </div>
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
        <button className="btn-primary btn-lg" disabled={picked == null} onClick={check}>
          Check answer
        </button>
      )}
    </section>
  );
}

function TutorChat({
  sessionId,
  position,
  initial,
  open,
  onClose,
}: {
  sessionId: number;
  position: number;
  initial: ChatMsg[];
  open: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, open]);

  // On phones the tutor is a bottom sheet: closed means hidden from keyboard and screen readers; open is a dialog.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open || desktop) return;
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, desktop, onClose]);
  const sheet = !desktop;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    const res = await fetch(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, position }),
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      setMessages((m) => [...m.slice(0, -1), { role: "assistant", content: acc }]);
    }
    setBusy(false);
  }

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        aria-label="Ask the tutor"
        role={sheet && open ? "dialog" : undefined}
        aria-modal={sheet && open ? true : undefined}
        inert={sheet && !open}
        className={`fixed inset-x-0 bottom-0 z-50 flex h-[85vh] flex-col rounded-t-[32px] bg-nav text-white transition-transform duration-[280ms] ease-out lg:sticky lg:inset-auto lg:top-4 lg:z-auto lg:h-[calc(100vh-2rem)] lg:translate-y-0 lg:rounded-[28px] ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex items-start justify-between gap-2 px-5 pt-5 pb-3">
          <div>
            <h2 className="text-[20px] font-extrabold tracking-tight">Ask the tutor</h2>
            <p className="text-[13px] text-nav-foreground">Answers come from your lectures and remember your past sessions.</p>
          </div>
          <button onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-white/10 lg:hidden" aria-label="Close tutor">
            <Icon d={ICONS.close} />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-2">
          {messages.length === 0 && (
            <p className="px-1 text-[15px] text-nav-foreground">
              Try: &quot;What&apos;s the difference between SIP and SAP?&quot; or &quot;Quiz me on this topic.&quot;
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`rounded-[20px] px-4 py-3 text-[15px] leading-relaxed ${m.role === "user" ? "ml-8 bg-mint font-semibold text-on-mint" : "mr-4 bg-white/10"}`}
            >
              {m.role === "assistant" ? (
                <div className="[&_a]:text-hero-accent [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1.5 [&_strong]:font-extrabold [&_ul]:list-disc">
                  <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
                </div>
              ) : (
                m.content
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form onSubmit={send} className="flex gap-2 p-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <input
            ref={field}
            className="h-[50px] w-full rounded-2xl border-2 border-transparent bg-white/10 px-4 text-[15px] text-white outline-none placeholder:text-nav-foreground focus:border-hero-accent focus:bg-white/15"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything…"
            aria-label="Message the tutor"
          />
          <button className="btn bg-mint px-5 text-on-mint" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </aside>
    </>
  );
}
