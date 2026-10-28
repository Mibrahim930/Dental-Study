"use client";
import { useEffect, useState } from "react";
import type { QuizMeView } from "@/lib/quizMe";
import { Icon, ICONS } from "./ui";
import { failureText, jsonOf, ServerMessage, signedOut } from "./clientFetch";
import { toast } from "./Toaster";

type Status = { missed: number; open: QuizMeView | null };

/** Opens a quiz in the QuizMe panel (which listens for this on every page that mounts it). */
export function openQuizPanel(quiz: QuizMeView) {
  window.dispatchEvent(new CustomEvent("quizme-open", { detail: quiz }));
}

/**
 * At the end of a lecture: how many questions she got wrong in it (section quizzes and "quiz me" on its sections), and
 * a button that opens them as one quiz. Nothing new in it, nothing she got right. A question she then gets right drops
 * out of the next review of the lecture; a reported one is gone for good. Costs nothing: no AI call.
 */
export function LectureReviewCard({ examId, documentId, lecture, compact = false }: { examId: number; documentId: number; lecture: string; compact?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`/api/quizme/lecture?examId=${examId}&documentId=${documentId}`)
        .then(async (res) => {
          if (!alive || signedOut(res)) return;
          const json = await jsonOf<Status>(res);
          if (alive && res.ok && json) setStatus(json);
        })
        .catch(() => {
          // The card just stays quiet; the page works without it.
        });
    };
    load();
    // Answers given in the review panel change the count: refresh when it closes.
    window.addEventListener("quizme-closed", load);
    return () => {
      alive = false;
      window.removeEventListener("quizme-closed", load);
    };
  }, [examId, documentId]);

  async function start() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/quizme/lecture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ examId, documentId }) });
      if (signedOut(res)) return;
      const json = await jsonOf<QuizMeView & { error?: string }>(res);
      if (!res.ok || !json?.id) throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      openQuizPanel(json);
    } catch (err) {
      toast(failureText(err, "Couldn't open the review. Check your connection and try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const n = status.open ? status.open.left : status.missed;
  if (compact) {
    if (n === 0) return null;
    return (
      <button type="button" className="btn-secondary btn-sm bg-card" disabled={busy} onClick={start}>
        <Icon d={ICONS.review} size={15} /> {status.open ? "Continue the lecture review" : `Review ${n} missed question${n === 1 ? "" : "s"}`}
      </button>
    );
  }
  return (
    <section className="tile cb-lilac flex flex-col gap-3 rounded-[28px]" aria-label="Lecture review">
      <div>
        <div className="text-[13px] font-bold opacity-75">End of lecture · {lecture}</div>
        <div className="text-[22px] leading-tight font-extrabold tracking-tight">
          {n === 0 ? "No missed questions in this lecture. Nice." : status.open ? `${n} missed question${n === 1 ? "" : "s"} still to review.` : `You missed ${n} question${n === 1 ? "" : "s"} in this lecture.`}
        </div>
        {n > 0 && <p className="mt-1 text-[15px] font-medium opacity-85">One quiz of just those questions, nothing new. Get one right and it won&apos;t come back.</p>}
      </div>
      {n > 0 && (
        <div>
          <button type="button" className="btn-primary btn-lg" disabled={busy} onClick={start}>
            {busy ? "Opening…" : status.open ? "Continue the review" : "Review them"}
          </button>
        </div>
      )}
    </section>
  );
}
