import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiUser, unauthorized } from "@/lib/user";

// Stop sharing (only the person who shared it). Copies classmates already added stay theirs.
export async function POST(_request: Request, ctx: RouteContext<"/api/shared/[id]/unshare">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  db.prepare("DELETE FROM shared_exams WHERE id = ? AND shared_by = ?").run(Number((await ctx.params).id), user.id);
  return NextResponse.json({ ok: true });
}
