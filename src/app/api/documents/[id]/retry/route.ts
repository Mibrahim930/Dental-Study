import { NextResponse } from "next/server";
import { processDocument } from "@/lib/processing";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsDocument } from "@/lib/owner";

export async function POST(_request: Request, ctx: RouteContext<"/api/documents/[id]/retry">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const docId = Number((await ctx.params).id);
  if (!ownsDocument(user.id, docId)) return notFound();
  void processDocument(docId);
  return NextResponse.json({ ok: true });
}
