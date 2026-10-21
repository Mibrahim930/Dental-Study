"use client";
import Link from "next/link";
import { useActionState } from "react";
import { setExamDate } from "@/app/actions";

type Undated = { id: number; name: string; kindLabel: string; course: string | null };

/** "Exams without a date (N)": each one gets a date picker; saving puts it on the calendar and into the plan. */
export function UndatedExams({ exams, today }: { exams: Undated[]; today: string }) {
  if (exams.length === 0) return null;
  return (
    <section className="tile cb-butter flex flex-col gap-3 rounded-[24px]" aria-labelledby="undated-title">
      <div>
        <h2 id="undated-title" className="text-[17px] font-extrabold">
          Exams without a date ({exams.length})
        </h2>
        <p className="text-[15px] font-medium">Add a date so your plan includes them.</p>
      </div>
      <ul className="flex flex-col gap-2">
        {exams.map((e) => (
          <UndatedRow key={e.id} exam={e} today={today} />
        ))}
      </ul>
    </section>
  );
}

function UndatedRow({ exam, today }: { exam: Undated; today: string }) {
  const [state, action, pending] = useActionState(setExamDate, null);
  return (
    <li className="rounded-[18px] bg-card p-3 text-foreground">
      <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="hidden" name="id" value={exam.id} />
        <div className="min-w-0 flex-1">
          <Link href={`/exams/${exam.id}`} className="block truncate text-[15px] font-bold hover:underline">
            {exam.name}
          </Link>
          <div className="truncate text-[13px] text-muted-foreground">
            {exam.kindLabel}
            {exam.course ? ` · ${exam.course}` : ""}
          </div>
        </div>
        <div className="flex gap-2">
          <label className="sr-only" htmlFor={`undated-${exam.id}`}>
            Date for {exam.name}
          </label>
          <input id={`undated-${exam.id}`} name="exam_date" type="date" min={today} className="input h-[42px] min-w-0 flex-1 sm:w-40" required />
          <button className="btn-primary btn-sm shrink-0" disabled={pending} aria-label={`Save the date for ${exam.name}`}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      {state?.error && (
        <p className="pt-1.5 text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}
    </li>
  );
}
