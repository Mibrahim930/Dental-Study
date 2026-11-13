import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { endSession } from "@/lib/study";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsSession } from "@/lib/owner";

/** "End session": the note about what she did is built from her answers (no AI call), so this answers at once. */
export async function POST(_request: Request, ctx: RouteContext<"/api/sessions/[id]/end">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const sessionId = Number((await ctx.params).id);
  if (!ownsSession(user.id, sessionId)) return notFound();
  try {
    return NextResponse.json({ summary: endSession(sessionId) || null });
  } catch (err) {
    // The session still ends; the page shows it ended without a note.
    console.error(`Ending study session ${sessionId} failed`, err);
    db.prepare("UPDATE study_sessions SET ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?").run(sessionId);
    return NextResponse.json({ summary: null });
  }
}
