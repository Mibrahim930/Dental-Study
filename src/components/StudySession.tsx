"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SlideImage } from "./SlideImage";
import { masteryColor, pct } from "@/lib/format";

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/exams/${examId}`} className="text-sm text-muted-foreground hover:underline">← {props.examName}</Link>
          <h1 className="text-xl font-semibold">
            Topic {position + 1} of {topics.length}: {topic.title}
          </h1>
        </div>
        <button className="btn-secondary" onClick={endSession} disabled={ending}>
          End session
        </button>
      </div>

      {endSummary !== undefined && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
          <div className="card max-w-md space-y-3">
            <h2 className="section-title">Session saved</h2>
            {endSummary && <p className="text-sm text-foreground">{endSummary}</p>}
            <p className="text-sm text-muted-foreground">
              Want to lock it in? Take a short practice exam on the {visited.size} topic{visited.size === 1 ? "" : "s"} you covered.
            </p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" onClick={practiceCovered}>Practice exam on these topics</button>
              <Link className="btn-secondary" href={`/exams/${examId}`}>Not now</Link>
            </div>
          </div>
        </div>
      )}
      {ending && endSummary === undefined && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30">
          <div className="card text-sm">Saving session notes…</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[200px_1fr_360px]">
        <nav className="hidden max-h-[80vh] overflow-y-auto lg:block">
          <ol className="space-y-1 text-sm">
            {topics.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => go(t.position)}
                  className={`w-full rounded-md px-2 py-1 text-left ${
                    t.position === position ? "bg-primary text-primary-foreground" : visited.has(t.position) ? "text-foreground hover:bg-muted" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {t.position + 1}. {t.title} {t.emphasized && "★"}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <article className="min-w-0 space-y-4">
          {!data && !error && (
            <div className="card animate-pulse text-sm text-muted-foreground">Preparing this topic from your slides… (first time takes ~30s)</div>
          )}
          {error && (
            <div className="card text-sm text-danger">
              {error} <button className="btn-ghost" onClick={() => { setResult(null); setAttempt((a) => a + 1); }}>Try again</button>
            </div>
          )}
          {data && <Lesson key={data.topic.id} data={data} />}
          {data && (
            <SectionQuiz
              key={`quiz-${data.topic.id}`}
              sessionId={sessionId}
              position={position}
              isLast={position + 1 >= topics.length}
              onNext={() => (position + 1 < topics.length ? go(position + 1) : endSession())}
            />
          )}

          <div className="flex justify-between">
            <button className="btn-secondary" disabled={position === 0} onClick={() => go(position - 1)}>← Previous</button>
            {position + 1 < topics.length ? (
              <button className="btn-primary" onClick={() => go(position + 1)}>Next topic →</button>
            ) : (
              <button className="btn-primary" onClick={endSession}>Finish session</button>
            )}
          </div>
        </article>

        <TutorChat sessionId={sessionId} position={position} initial={props.initialChat} />
      </div>
    </div>
  );
}

function Lesson({ data }: { data: LessonData }) {
  const { lesson, concepts, topic } = data;
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <>
      <section className="card space-y-3">
        <div className="flex flex-wrap gap-1">
          {topic.emphasized && <span className="badge bg-warning-soft text-warning">★ Emphasized in lecture</span>}
          {concepts.map((c) => (
            <span key={c.id} className={`badge ${masteryColor(c.mastery)}`} title={c.earlier_exams.length ? `Also in: ${c.earlier_exams.join(", ")}` : ""}>
              {c.name}
              {c.mastery != null && ` · ${pct(c.mastery)}`}
              {c.earlier_exams.length > 0 && " ↺"}
            </span>
          ))}
        </div>
        <div className="prose-study">
          <ReactMarkdown>{lesson.explanation}</ReactMarkdown>
        </div>
      </section>

      {lesson.slides.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {lesson.slides.map((s) => (
            <figure key={s.page_id} className="card space-y-2 p-3">
              <button onClick={() => setZoom(s.page_id)} className="block w-full">
                <SlideImage pageId={s.page_id} alt={s.caption} />
              </button>
              <figcaption className="text-sm text-muted-foreground">{s.caption}</figcaption>
            </figure>
          ))}
        </section>
      )}
      {zoom != null && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(null)}>
          <div className="w-full max-w-5xl">
            <SlideImage pageId={zoom} alt="Slide" />
          </div>
        </div>
      )}

      <section className="card border-primary/30 bg-primary-soft/50">
        <h3 className="mb-2 font-semibold text-primary">Key points</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
          {lesson.key_points.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      </section>

      {lesson.connections && (
        <section className="card border-info/30 bg-info-soft/50 text-sm">
          <h3 className="mb-1 font-semibold text-info">↺ Connects to earlier exams</h3>
          <p className="text-foreground">{lesson.connections}</p>
        </section>
      )}

    </>
  );
}

/** End-of-section quiz: one question at a time, with a way to skip ahead at any point. */
function SectionQuiz({ sessionId, position, isLast, onNext }: { sessionId: number; position: number; isLast: boolean; onNext: () => void }) {
  const [quiz, setQuiz] = useState<{ topicId: number; questions: QuizQ[] } | null>(null);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
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

  const nextLabel = isLast ? "Finish session" : "Next section →";
  const skip = (
    <button className="btn-ghost" onClick={onNext}>
      {isLast ? "Skip & finish session" : "Skip to next section →"}
    </button>
  );

  if (error) {
    return (
      <section className="card flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          <span className="block text-danger">Couldn&apos;t write the quiz for this section right now.</span>
          <span className="block text-xs text-muted-foreground">{error}</span>
        </span>
        <span className="flex gap-2">
          <button className="btn-secondary" onClick={() => { setError(""); setAttempt((a) => a + 1); }}>Try again</button>
          {skip}
        </span>
      </section>
    );
  }
  if (!quiz) {
    return (
      <section className="card flex flex-wrap items-center justify-between gap-2">
        <span className="animate-pulse text-sm text-muted-foreground">Writing a 10-question quiz for this section… keep reading, it&apos;ll be ready in a moment.</span>
        {skip}
      </section>
    );
  }

  const total = quiz.questions.length;
  const right = quiz.questions.filter((q, i) => answers[i] === q.correct_index).length;
  const done = Object.keys(answers).length;

  function choose(i: number) {
    if (answers[index] != null) return;
    setAnswers((a) => ({ ...a, [index]: i }));
    void fetch(`/api/sessions/${sessionId}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: quiz!.topicId, index, chosen: i }),
    });
  }

  const dots = (
    <div className="flex flex-wrap gap-1" aria-hidden>
      {quiz.questions.map((q, i) => (
        <button
          key={i}
          onClick={() => setIndex(i)}
          className={`h-2 w-6 rounded-full ${
            answers[i] == null ? (i === index ? "bg-primary/50" : "bg-muted-strong") : answers[i] === q.correct_index ? "bg-success" : "bg-danger"
          }`}
        />
      ))}
    </div>
  );

  // Finished: score and what to look at again.
  if (index >= total) {
    const missed = quiz.questions.filter((q, i) => answers[i] != null && answers[i] !== q.correct_index);
    return (
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="section-title">Section quiz done</h3>
          {dots}
        </div>
        <p className="text-2xl font-semibold tracking-tight">
          {right}/{done} correct{done < total && <span className="ml-2 text-sm font-normal text-muted-foreground">({total - done} skipped)</span>}
        </p>
        <p className="text-sm text-muted-foreground">
          {done === 0
            ? "No questions answered."
            : right / done >= 0.8
              ? "Nice work. You've got this section."
              : "Worth another look before moving on. Ask the tutor about anything that's unclear."}
        </p>
        {missed.length > 0 && (
          <div className="text-sm">
            <div className="mb-1 font-medium">Review:</div>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {[...new Set(missed.map((q) => q.concept))].map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <button className="btn-secondary" onClick={() => setIndex(0)}>Look back at the questions</button>
          <button className="btn-primary" onClick={onNext}>{nextLabel}</button>
        </div>
      </section>
    );
  }

  const q = quiz.questions[index];
  const chosen = answers[index];
  const answered = chosen != null;
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Section quiz · Question {index + 1} of {total}
        </div>
        {dots}
      </div>
      <p className="font-medium">{q.question}</p>
      <div className="grid gap-2">
        {q.options.map((o, i) => (
          <button
            key={i}
            onClick={() => choose(i)}
            disabled={answered}
            className={`rounded-lg border px-3 py-2 text-left text-sm disabled:cursor-default ${
              !answered
                ? "border-input hover:bg-muted"
                : i === q.correct_index
                  ? "border-success bg-success-soft"
                  : i === chosen
                    ? "border-danger bg-danger-soft"
                    : "border-border text-muted-foreground"
            }`}
          >
            <span className="mr-2 font-medium">{String.fromCharCode(65 + i)}.</span>
            {o}
          </button>
        ))}
      </div>
      {answered && (
        <div className="prose-study rounded-lg bg-muted p-3 text-sm">
          <strong>{chosen === q.correct_index ? "Correct. " : "Not quite. "}</strong>
          <ReactMarkdown>{q.explanation}</ReactMarkdown>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        {skip}
        <button className="btn-primary" disabled={!answered} onClick={() => setIndex(index + 1)}>
          {index + 1 < total ? "Next question →" : "See my score"}
        </button>
      </div>
    </section>
  );
}

function TutorChat({ sessionId, position, initial }: { sessionId: number; position: number; initial: ChatMsg[] }) {
  const [messages, setMessages] = useState<ChatMsg[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

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
    <aside className="card flex h-[80vh] flex-col p-0 lg:sticky lg:top-4">
      <div className="border-b border-border px-4 py-3">
        <h2 className="font-semibold tracking-tight">Ask the tutor</h2>
        <p className="text-xs text-muted-foreground">Answers come from your lectures and remember your past sessions.</p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Try: &quot;What&apos;s the difference between SIP and SAP?&quot; or &quot;Quiz me on this topic.&quot;
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "ml-6 bg-primary text-primary-foreground" : "mr-2 bg-muted text-foreground"}`}
          >
            {m.role === "assistant" ? (
              <div className="prose-study text-sm">
                <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
              </div>
            ) : (
              m.content
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything…" />
        <button className="btn-primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </aside>
  );
}
