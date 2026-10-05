import { db, type Exam } from "@/lib/db";
import { requireUser } from "@/lib/user";
import type { ClassRow } from "@/lib/classes";
import { formatDate } from "@/lib/format";
import { ClassForms, InviteCode, LeaveClassButton, ShareExamForm, SharedExamAction } from "@/components/ClassControls";

export const dynamic = "force-dynamic";

type Shared = { id: number; exam_id: number; shared_by: number; sharer: string; name: string; exam_date: string | null; course: string | null; slides: number; topics: number };

export default async function ClassesPage() {
  const user = await requireUser();
  const classes = db
    .prepare("SELECT c.* FROM classes c JOIN class_members m ON m.class_id = c.id WHERE m.user_id = ? ORDER BY c.created_at")
    .all(user.id) as ClassRow[];
  const shareable = db
    .prepare("SELECT id, name FROM exams WHERE user_id = ? AND topic_status = 'ready' AND status = 'active' ORDER BY exam_date")
    .all(user.id) as Pick<Exam, "id" | "name">[];
  const myCopies = new Map(
    (db.prepare("SELECT id, source_exam_id FROM exams WHERE user_id = ? AND source_exam_id IS NOT NULL").all(user.id) as { id: number; source_exam_id: number }[]).map(
      (r) => [r.source_exam_id, r.id],
    ),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Classes</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Study with classmates. When someone shares an exam, you can add it to your account with its lectures, topic map, lessons and
          question bank already done, so <strong>you pay nothing for slide reading</strong>. Your progress, scores and review stay private.
          Please keep lecture slides within your class.
        </p>
      </div>

      <ClassForms />

      {classes.map((c) => {
        const members = db
          .prepare("SELECT u.email FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? ORDER BY m.joined_at")
          .all(c.id) as { email: string }[];
        const shared = db
          .prepare(
            `SELECT s.id, s.exam_id, s.shared_by, u.email AS sharer, e.name, e.exam_date, e.course,
               (SELECT COUNT(*) FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = e.id) slides,
               (SELECT COUNT(*) FROM topics t WHERE t.exam_id = e.id) topics
             FROM shared_exams s JOIN exams e ON e.id = s.exam_id JOIN users u ON u.id = s.shared_by
             WHERE s.class_id = ? ORDER BY e.exam_date`,
          )
          .all(c.id) as Shared[];
        return (
          <section key={c.id} className="card space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="section-title">{c.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {members.length} member{members.length === 1 ? "" : "s"}: {members.map((m) => m.email.split("@")[0]).join(", ")}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Invite code</span>
                <InviteCode code={c.invite_code} />
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">Shared exams</h3>
              {shared.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing shared yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {shared.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div>
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.course ? `${s.course} · ` : ""}
                          {formatDate(s.exam_date)} · {s.slides} slides · {s.topics} topics · shared by {s.shared_by === user.id ? "you" : s.sharer.split("@")[0]}
                        </div>
                      </div>
                      <SharedExamAction
                        sharedId={s.id}
                        mine={s.shared_by === user.id}
                        addedExamId={s.shared_by === user.id ? s.exam_id : (myCopies.get(s.exam_id) ?? null)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-64 flex-1">
                <ShareExamForm classId={c.id} exams={shareable.filter((e) => !shared.some((s) => s.exam_id === e.id))} />
              </div>
              <LeaveClassButton classId={c.id} isOwner={c.owner_id === user.id} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
