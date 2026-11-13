"use client";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SlideImage } from "../SlideImage";
import { Icon, ICONS } from "../ui";
import { MarkableText } from "../MarkableText";
import { Dialog } from "../Dialog";
import type { LessonData } from "./types";

/**
 * A slide at full size (1280 px wide, the size it was rendered at), in a box she can scroll and pinch-zoom. Closes with
 * the button, Escape, or a tap beside the slide; the page behind stays put and focus goes back to the slide she tapped.
 */
export function SlideZoom({ pageId, aspect, number, onClose }: { pageId: number; aspect?: number; number?: number; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const label = number != null ? `Slide ${number}, full size` : "Slide, full size";
  return (
    <Dialog open onClose={onClose} label={label} variant="fullscreen" initialFocus={close}>
      <div
        className="h-full w-full overflow-auto overscroll-contain [touch-action:pan-x_pan-y_pinch-zoom]"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="flex min-h-full min-w-full p-4 pt-16" onClick={(e) => e.target === e.currentTarget && onClose()}>
          <div className="m-auto w-[1280px] max-w-none shrink-0">
            <SlideImage pageId={pageId} aspect={aspect} alt={number != null ? `Slide ${number}` : "Slide"} />
          </div>
        </div>
      </div>
      <button
        ref={close}
        type="button"
        onClick={onClose}
        aria-label="Close the slide"
        className="fixed top-[calc(12px+env(safe-area-inset-top))] right-3 z-10 flex h-11 w-11 items-center justify-center rounded-xl bg-white/90 text-black shadow-[0_4px_16px_rgba(0,0,0,.35)]"
      >
        <Icon d={ICONS.close} size={20} />
      </button>
    </Dialog>
  );
}
export function LessonView({ data }: { data: LessonData }) {
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
      {zoom != null && <SlideZoom pageId={zoom} aspect={data.aspects?.[zoom]} number={data.slideInfo?.[zoom]?.number} onClose={() => setZoom(null)} />}

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
            // Two key points can read the same: the place in the list keeps the keys apart.
            <li key={`${i}:${k}`} className="flex gap-3 text-[15px] leading-snug font-medium">
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
