import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Student reports a wrong/unclear question. Flagged questions are hidden from review.
export async function POST(request: Request, ctx: RouteContext<"/api/questions/[id]/flag">) {
  const { note } = (await request.json().catch(() => ({}))) as { note?: string };
  db.prepare("UPDATE questions SET flagged = 1, flag_note = ? WHERE id = ?").run(note ?? null, Number((await ctx.params).id));
  return NextResponse.json({ ok: true });
}
