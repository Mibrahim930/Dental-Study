import { db, type User } from "@/lib/db";
import { requireAdmin } from "@/lib/user";
import { backupConfigured, lastBackup } from "@/lib/backup";
import { AdminUserActions } from "@/components/AdminUserActions";
import { BackupNowButton } from "@/components/BackupNowButton";
import { ActionButton } from "@/components/ActionButton";
import { listReports, unseenReportCount } from "@/lib/reports";
import { listReportedQuestions } from "@/lib/reportedQuestions";
import { lastLessonScan } from "@/lib/study";

export const dynamic = "force-dynamic";

type Row = User & { exams: number; slides: number; month: number; total: number; last_active: string | null };
const usd = (n: number) => `$${n.toFixed(2)}`;

export default async function AdminPage() {
  const admin = await requireAdmin();
  const users = db
    .prepare(
      `SELECT u.*,
        (SELECT COUNT(*) FROM exams e WHERE e.user_id = u.id) exams,
        (SELECT COUNT(*) FROM pages p JOIN documents d ON d.id = p.document_id JOIN exams e ON e.id = d.exam_id WHERE e.user_id = u.id) slides,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage a WHERE a.user_id = u.id AND a.created_at >= date('now', 'start of month')) month,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage a WHERE a.user_id = u.id) total,
        (SELECT MAX(created_at) FROM ai_usage a WHERE a.user_id = u.id) last_active
       FROM users u ORDER BY u.id`,
    )
    .all() as Row[];
  const backup = lastBackup();
  const reports = listReports();
  const unseen = unseenReportCount();
  const reportedQuestions = listReportedQuestions(200);
  const lessonScan = lastLessonScan();
  const sourceLabel: Record<string, string> = { quiz: "Section quiz", practice: "Practice exam", review: "Daily review", quizme: "Quiz me", lecture_review: "Lecture review" };

  return (
    <div className="space-y-6">
      <h1 className="page-title">Admin</h1>

      <section className="card space-y-3">
        <h2 className="section-title ">Users ({users.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Email</th>
                <th className="py-2 pr-3 font-medium">AI</th>
                <th className="py-2 pr-3 font-medium">Exams</th>
                <th className="py-2 pr-3 font-medium">Slides</th>
                <th className="py-2 pr-3 font-medium">Spend (month / total)</th>
                <th className="py-2 pr-3 font-medium">Last AI use</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-2 pr-3">
                    {u.email}
                    {u.is_admin ? <span className="badge ml-2 bg-primary-soft text-primary">admin</span> : null}
                    {u.must_change_password ? <span className="badge ml-2 bg-warning-soft text-warning">temp password</span> : null}
                    <div className="text-xs text-subtle">joined {u.created_at.slice(0, 10)}</div>
                  </td>
                  <td className="py-2 pr-3">{u.provider === "openai" ? "ChatGPT" : u.provider === "anthropic" ? "Claude" : "—"}</td>
                  <td className="py-2 pr-3">{u.exams}</td>
                  <td className="py-2 pr-3">{u.slides}</td>
                  <td className="py-2 pr-3">{usd(u.month)} / {usd(u.total)}</td>
                  <td className="py-2 pr-3">{u.last_active?.slice(0, 10) ?? "—"}</td>
                  <td className="py-2">
                    <AdminUserActions userId={u.id} email={u.email} isSelf={u.id === admin.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Spending is billed to each user&apos;s own API key, not to you.</p>
      </section>

      <section className="card space-y-3">
        <h2 className="section-title ">
          Reports{unseen > 0 && <span className="chip cb-coral ml-2 align-middle">{unseen} new</span>}
        </h2>
        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports yet. Students send them with the flag button in the corner of every page.</p>
        ) : (
          <ul className="divide-y divide-border">
            {reports.map((r) => (
              <li key={r.id} className={`flex flex-col gap-2 py-3 ${r.seen_at ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                  <span className={`chip ${r.kind === "idea" ? "cb-lilac" : "cb-coral"}`}>{r.kind === "idea" ? "Idea" : "Problem"}</span>
                  <span className="font-semibold text-foreground">{r.email}</span>
                  <span>{r.created_at} UTC</span>
                  {r.page &&
                    (/^\/(?![/\\])/.test(r.page) ? (
                      <a href={r.page} className="truncate underline underline-offset-2">
                        {r.page}
                      </a>
                    ) : (
                      <span className="truncate">{r.page}</span>
                    ))}
                  {r.meta.viewport && (
                    <span>
                      {r.meta.viewport}
                      {r.meta.theme ? ` · ${r.meta.theme}` : ""}
                    </span>
                  )}
                </div>
                <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{r.message}</p>
                {r.images > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Array.from({ length: r.images }, (_, i) => (
                      <a key={i} href={`/api/admin/reports/${r.id}/image/${i + 1}`} target="_blank" rel="noreferrer" className="block">
                        {/* eslint-disable-next-line @next/next/no-img-element -- private, cookie-authenticated image */}
                        <img src={`/api/admin/reports/${r.id}/image/${i + 1}`} alt={`Screenshot ${i + 1}`} className="h-24 rounded-lg border border-border bg-muted" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
                {!r.seen_at && (
                  <div>
                    <ActionButton url={`/api/admin/reports/${r.id}/seen`} label="Mark seen" className="btn-secondary btn-sm" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title ">Lesson filler check</h2>
          <ActionButton url="/api/admin/lesson-scan" label="Check all lessons now" className="btn-secondary btn-sm" />
        </div>
        <p className="text-sm text-muted-foreground">
          Every stored lesson is checked for filler the writer drifted into at the end of a slide (&ldquo;Done. Ok. Stop. Bye.&rdquo;) at every start and
          whenever you press the button. Filler is cut and the lesson saved clean, with no AI call. Lessons found this way are listed here.
        </p>
        {!lessonScan ? (
          <p className="text-sm text-muted-foreground">Not checked yet.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Last check {lessonScan.at.slice(0, 16).replace("T", " ")} UTC · {lessonScan.checked} lesson(s) checked ·{" "}
              {lessonScan.found.length === 0 ? "nothing found, ever" : `${lessonScan.found.length} found so far (cleaned)`}
            </p>
            {lessonScan.found.length > 0 && (
              <ul className="divide-y divide-border text-sm">
                {lessonScan.found.map((h) => (
                  <li key={h.topicId} className="py-2">
                    <div className="font-semibold">{h.section}</div>
                    <div className="text-xs text-muted-foreground">
                      {h.exam}
                      {h.lecture ? ` · ${h.lecture}` : ""} · {h.trimmed} slide(s) trimmed{h.dropped ? `, ${h.dropped} dropped` : ""}
                      {h.intro ? ", intro trimmed" : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title ">Reported questions ({reportedQuestions.length})</h2>
          {reportedQuestions.length > 0 && (
            <a href="/api/admin/reported-questions" className="btn-secondary btn-sm" download>
              Download all (JSON)
            </a>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Questions students removed with the Report button. Each one also sits as a file under the data folder (files/reported-questions/). The writers are
          told to steer clear of a section&apos;s reported questions next time its quiz is written.
        </p>
        {reportedQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {reportedQuestions.map((r) => (
              <li key={r.id} className="space-y-1.5 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="chip bg-muted">{sourceLabel[r.source] ?? r.source}</span>
                  <span>{r.email}</span>
                  <span>· {r.created_at.slice(0, 16).replace("T", " ")}</span>
                  {r.question.exam && <span>· {r.question.exam}</span>}
                  {r.question.lecture && (
                    <span>
                      · {r.question.lecture}
                      {r.question.slide != null ? `, slide ${r.question.slide}` : ""}
                    </span>
                  )}
                  {r.question.section && <span>· {r.question.section}</span>}
                </div>
                <div className="font-semibold">{r.question.question}</div>
                <ol className="list-[upper-alpha] pl-6 text-muted-foreground">
                  {r.question.options.map((o, i) => (
                    <li key={i} className={i === r.question.correct_index ? "font-semibold text-foreground" : ""}>
                      {o}
                      {i === r.question.correct_index ? " (keyed answer)" : ""}
                    </li>
                  ))}
                </ol>
                {r.reason && <div className="text-foreground">Reason: &ldquo;{r.reason}&rdquo;</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="section-title ">Backups</h2>
        {!backupConfigured() ? (
          <p className="text-sm text-warning">Backups aren&apos;t configured on this server.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Every day the database and any new lecture PDFs are copied to a separate storage bucket. The last 14 days are kept.
            </p>
            <p className="text-sm">
              Last backup:{" "}
              {backup ? (
                <span className={backup.ok ? "text-success" : "text-danger"}>
                  {new Date(backup.at).toLocaleString()} · {backup.ok ? "OK" : "failed"}. {backup.message}
                </span>
              ) : (
                "none yet"
              )}
            </p>
            <BackupNowButton />
          </>
        )}
      </section>
    </div>
  );
}
