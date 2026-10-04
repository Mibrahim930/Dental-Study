import { notFound, redirect } from "next/navigation";
import { db, getExam, type Topic } from "@/lib/db";
import { StudySession } from "@/components/StudySession";
import { requireUser } from "@/lib/user";

export const dynamic = "force-dynamic";

type SessionRow = { id: number; current_position: number; ended_at: string | null };

export default async function StudyPage(props: PageProps<"/exams/[id]/study">) {
  const examId = Number((await props.params).id);
  const search = await props.searchParams;
  const user = await requireUser();
  const exam = getExam(examId, user.id);
  if (!exam) notFound();
  const topics = db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
  if (topics.length === 0) redirect(`/exams/${examId}`);

  const last = db.prepare("SELECT * FROM study_sessions WHERE exam_id = ? ORDER BY id DESC LIMIT 1").get(examId) as
    | SessionRow
    | undefined;
  let position = search.restart ? 0 : (last?.current_position ?? 0);
  if (typeof search.topic === "string") position = Number(search.topic);
  position = Math.min(Math.max(position, 0), topics.length - 1);

  let sessionId: number;
  if (last && !last.ended_at) {
    sessionId = last.id;
    db.prepare("UPDATE study_sessions SET current_position = ? WHERE id = ?").run(position, sessionId);
  } else {
    sessionId = Number(
      db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, ?)").run(examId, position).lastInsertRowid,
    );
  }
  const chat = db
    .prepare("SELECT id, role, content FROM chat_messages WHERE session_id = ? ORDER BY id")
    .all(sessionId) as { id: number; role: "user" | "assistant"; content: string }[];

  return (
    <StudySession
      examId={examId}
      examName={exam.name}
      sessionId={sessionId}
      initialPosition={position}
      topics={topics.map((t) => ({ id: t.id, position: t.position, title: t.title, emphasized: !!t.emphasized }))}
      initialChat={chat}
    />
  );
}
