import { NextResponse } from "next/server";
import { apiAdmin, notFound, unauthorized } from "@/lib/user";
import { markReportSeen } from "@/lib/reports";

/** The owner has read this report. */
export async function POST(_request: Request, ctx: RouteContext<"/api/admin/reports/[id]/seen">) {
  const admin = await apiAdmin();
  if (!admin) return unauthorized();
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || !markReportSeen(id)) return notFound();
  return NextResponse.json({ ok: true });
}
