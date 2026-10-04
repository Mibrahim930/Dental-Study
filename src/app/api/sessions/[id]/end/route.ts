import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { summarizeSession } from "@/lib/study";

export const maxDuration = 120;

export async function POST(_request: Request, ctx: RouteContext<"/api/sessions/[id]/end">) {
  const sessionId = Number((await ctx.params).id);
  try {
    await summarizeSession(sessionId);
  } catch (err) {
    db.prepare("UPDATE study_sessions SET ended_at = datetime('now') WHERE id = ?").run(sessionId);
    return NextResponse.json({ summary: null, error: String(err) });
  }
  const row = db.prepare("SELECT summary FROM study_sessions WHERE id = ?").get(sessionId) as { summary: string };
  return NextResponse.json({ summary: row.summary });
}
