import { db, type Topic } from "@/lib/db";
import { tutorStream } from "@/lib/study";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

export const maxDuration = 300;

// Streams the tutor's reply as plain text, then saves both turns to the session.
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[id]/chat">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  if (!ownsSession(user.id, Number((await ctx.params).id))) return notFound();
  const sessionId = Number((await ctx.params).id);
  const { message, position } = (await request.json()) as { message: string; position: number };
  const session = db.prepare("SELECT exam_id FROM study_sessions WHERE id = ?").get(sessionId) as { exam_id: number } | undefined;
  if (!session || !message?.trim()) return new Response("Bad request", { status: 400 });
  const topic = db.prepare("SELECT * FROM topics WHERE exam_id = ? AND position = ?").get(session.exam_id, position) as Topic | undefined;

  const stream = tutorStream(sessionId, session.exam_id, topic, message.trim());
  const encoder = new TextEncoder();
  let full = "";
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const delta of stream) {
          full += delta;
          controller.enqueue(encoder.encode(delta));
        }
        const insert = db.prepare("INSERT INTO chat_messages (session_id, role, content, topic_position) VALUES (?, ?, ?, ?)");
        insert.run(sessionId, "user", message.trim(), position);
        insert.run(sessionId, "assistant", full, position);
      } catch (err) {
        controller.enqueue(encoder.encode(`\n\n_(Error: ${String(err)})_`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}
