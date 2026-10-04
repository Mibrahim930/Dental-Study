import { NextResponse } from "next/server";
import { processDocument } from "@/lib/processing";

export async function POST(_request: Request, ctx: RouteContext<"/api/documents/[id]/retry">) {
  void processDocument(Number((await ctx.params).id));
  return NextResponse.json({ ok: true });
}
