import { NextResponse } from "next/server";
import { attemptView } from "@/lib/attemptView";

export async function GET(_request: Request, ctx: RouteContext<"/api/attempts/[id]">) {
  const view = attemptView(Number((await ctx.params).id));
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view);
}
