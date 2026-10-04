import Link from "next/link";
import { db, type Exam } from "@/lib/db";
import { countDue } from "@/lib/practice";
import { weakConcepts } from "@/lib/memory";
import { daysUntil, formatDate, pct } from "@/lib/format";
import { createExam } from "./actions";

export const dynamic = "force-dynamic";

type ExamWithCounts = Exam & { docs: number; pages: number; done_pages: number };

export default function Home() {
  const exams = db
    .prepare(
      `SELECT e.*, COUNT(DISTINCT d.id) docs, COUNT(p.id) pages, SUM(p.status = 'done') done_pages
       FROM exams e LEFT JOIN documents d ON d.exam_id = e.id LEFT JOIN pages p ON p.document_id = d.id
       GROUP BY e.id ORDER BY COALESCE(e.exam_date, '9999') ASC, e.id DESC`,
    )
    .all() as ExamWithCounts[];
  const isPast = (e: Exam) => e.status === "archived" || (daysUntil(e.exam_date) ?? 0) < 0;
  const upcoming = exams.filter((e) => !isPast(e));
  const past = exams.filter(isPast);
  const due = countDue();
  const weak = weakConcepts(6);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Your exams</h1>
        {upcoming.length === 0 && (
          <div className="card text-slate-600">No upcoming exams yet. Create one to start uploading lectures.</div>
        )}
        {upcoming.map((e) => (
          <ExamCard key={e.id} exam={e} />
        ))}
        {past.length > 0 && (
          <>
            <h2 className="pt-4 text-lg font-semibold text-slate-700">Past exams</h2>
            <p className="-mt-2 text-sm text-slate-500">
              Their lectures, scores and review cards stay in memory and feed into new exams.
            </p>
            {past.map((e) => (
              <ExamCard key={e.id} exam={e} />
            ))}
          </>
        )}
      </section>

      <aside className="space-y-4">
        <form action={createExam} className="card space-y-3">
          <h2 className="font-semibold">New exam</h2>
          <div>
            <label className="label" htmlFor="name">Exam name</label>
            <input id="name" name="name" className="input" placeholder="Endo Block Exam" required />
          </div>
          <div>
            <label className="label" htmlFor="course">Course (optional)</label>
            <input id="course" name="course" className="input" placeholder="Endodontics D2" />
          </div>
          <div>
            <label className="label" htmlFor="exam_date">Exam date</label>
            <input id="exam_date" name="exam_date" type="date" className="input" />
          </div>
          <button className="btn-primary w-full">Create exam</button>
        </form>

        <Link href="/review" className="card block hover:border-teal-400">
          <div className="text-sm text-slate-500">Daily review</div>
          <div className="text-2xl font-semibold">{due} due</div>
          <div className="text-sm text-slate-500">Questions you missed, scheduled so you don&apos;t forget them.</div>
        </Link>

        {weak.length > 0 && (
          <div className="card">
            <h2 className="mb-2 font-semibold">Weakest concepts</h2>
            <ul className="space-y-1 text-sm">
              {weak.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span>{c.name}</span>
                  <span className="text-rose-700">{pct(c.mastery)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

function ExamCard({ exam }: { exam: ExamWithCounts }) {
  const days = daysUntil(exam.exam_date);
  const processing = exam.pages > 0 && exam.done_pages < exam.pages;
  return (
    <Link href={`/exams/${exam.id}`} className="card block hover:border-teal-400">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">{exam.name}</div>
          <div className="text-sm text-slate-500">
            {exam.course ? `${exam.course} · ` : ""}
            {formatDate(exam.exam_date)}
          </div>
        </div>
        {days != null && days >= 0 && (
          <span className="badge bg-teal-50 text-teal-800">{days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"} left`}</span>
        )}
      </div>
      <div className="mt-3 text-sm text-slate-600">
        {exam.docs} lecture{exam.docs === 1 ? "" : "s"} · {exam.pages} slides
        {processing && <span className="ml-2 text-amber-700">Processing {exam.done_pages}/{exam.pages}…</span>}
      </div>
    </Link>
  );
}
