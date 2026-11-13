"use client";
import Link from "next/link";
import { useState } from "react";
import { SETTINGS_WORD, completeLine, coverageLine, progressLine, smallerPlanLine, type PlanFields } from "@/components/examProgressText";

/**
 * Above the questions: how many are in while the rest are still being written, and why the exam is smaller than she
 * asked for (the lectures hold less, or some questions couldn't be written: one sentence, see smallerPlanLine). Shown
 * only for exams that need it, so old attempts look as before. Every field is read through planFields, so a view
 * without the newer ones (`dropped`) shows what it can.
 */
export function ExamProgress({ view, count }: { view: PlanFields | object; count: number }) {
  const line = progressLine(view);
  // The lectures hold less than asked, or questions were dropped (`dropped`), or both: one plain sentence.
  const smaller = smallerPlanLine(view);
  // Once shown, the box stays for the rest of the visit: when the last question arrives its text changes in place,
  // and the last progress sentence is kept (invisible) so the box keeps its height.
  const [last, setLast] = useState(line);
  if (line && (line.text !== last?.text || line.settings !== last.settings)) setLast(line);
  const kept = line ?? last;
  if (!kept && !smaller) return null;
  const done = completeLine(count);
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-card px-4 py-3">
      {kept && (
        // Both texts share one grid cell, the hidden one invisible, so the box is as tall as the longer of the two and
        // the questions below don't move when it switches.
        <p className="grid text-[15px] font-semibold">
          <span className={`col-start-1 row-start-1 ${line ? "" : "invisible"}`}>
            <WithSettings text={kept.text} link={kept.settings && !!line} />
          </span>
          <span className={`col-start-1 row-start-1 ${line ? "invisible" : ""}`}>{done}</span>
        </p>
      )}
      {smaller && <p className="text-[13px] font-medium text-muted-foreground">{smaller}</p>}
    </div>
  );
}

/** The key sentence with "Settings" as a link. */
function WithSettings({ text, link }: { text: string; link: boolean }) {
  const at = link ? text.indexOf(SETTINGS_WORD) : -1;
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <Link href="/settings" className="underline underline-offset-2">
        {SETTINGS_WORD}
      </Link>
      {text.slice(at + SETTINGS_WORD.length)}
    </>
  );
}

/** The coverage sentence, folded away under the title so it never pushes the question down. */
export function ExamCoverage({ view }: { view: PlanFields | object }) {
  const text = coverageLine(view);
  if (!text) return null;
  return (
    <details className="px-1 text-[13px] text-muted-foreground">
      <summary className="cursor-pointer font-bold">What this exam covers</summary>
      <p className="pt-1 font-medium">{text}</p>
    </details>
  );
}
