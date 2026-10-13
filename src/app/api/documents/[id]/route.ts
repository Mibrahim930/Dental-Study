import { NextResponse } from "next/server";
import { removeDocument } from "@/lib/processing";
import { rebuildPlan } from "@/lib/planner";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsDocument } from "@/lib/owner";

/** Remove a lecture, or cancel one that is still being read. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const docId = Number((await ctx.params).id);
  if (!ownsDocument(user.id, docId)) return notFound();
  await removeDocument(docId);
  rebuildPlan(user.id); // drop study tasks for topics that no longer exist
  return NextResponse.json({ ok: true });
}
