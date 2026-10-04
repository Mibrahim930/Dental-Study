import Link from "next/link";
import { db } from "@/lib/db";
import { mastery, type ConceptRow } from "@/lib/memory";
import { masteryColor, pct } from "@/lib/format";
import { requireUser } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function ProgressPage() {
  const user = await requireUser();
  const concepts = (db.prepare("SELECT * FROM concepts WHERE user_id = ? AND attempts > 0").all(user.id) as ConceptRow[])
    .map((c) => ({ ...c, mastery: mastery(c)! }))
    .sort((a, b) => a.mastery - b.mastery);
  const untested = (db.prepare("SELECT COUNT(*) n FROM concepts WHERE user_id = ? AND attempts = 0").get(user.id) as { n: number }).n;
  const attempts = db
    .prepare(
      `SELECT a.id, a.score, a.finished_at, a.mode, e.name exam_name, COUNT(aq.question_id) n
       FROM attempts a JOIN exams e ON e.id = a.exam_id LEFT JOIN attempt_questions aq ON aq.attempt_id = a.id
       WHERE a.status = 'finished' AND e.user_id = ? GROUP BY a.id ORDER BY a.finished_at DESC LIMIT 20`,
    )
    .all(user.id) as { id: number; score: number; finished_at: string; mode: string; exam_name: string; n: number }[];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <section className="card">
        <h1 className="text-xl font-semibold">Concept mastery</h1>
        <p className="mb-3 text-sm text-slate-600">
          Across every exam. Built from practice exams and daily review. {untested > 0 && `${untested} concepts not tested yet.`}
        </p>
        {concepts.length === 0 ? (
          <p className="text-sm text-slate-500">Take a practice exam to start tracking mastery.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {concepts.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span>{c.name}</span>
                <span className={`badge ${masteryColor(c.mastery)}`}>
                  {pct(c.mastery)} · {c.correct}/{c.attempts}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2 className="mb-2 font-semibold">Practice exam history</h2>
        <ul className="divide-y divide-slate-100 text-sm">
          {attempts.map((a) => (
            <li key={a.id} className="flex justify-between py-2">
              <Link href={`/attempts/${a.id}`} className="hover:underline">
                {a.exam_name} · {a.n} Qs · {a.finished_at.slice(0, 10)}
              </Link>
              <span>{pct(a.score)}</span>
            </li>
          ))}
          {attempts.length === 0 && <li className="py-2 text-slate-500">None yet.</li>}
        </ul>
      </section>
    </div>
  );
}
