import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { shareExam } from "@/lib/classes";

export async function POST(request: Request, ctx: RouteContext<"/api/classes/[id]/share">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { examId } = (await request.json()) as { examId?: number };
  const error = shareExam(user.id, Number((await ctx.params).id), Number(examId));
  return error ? NextResponse.json({ error }, { status: 400 }) : NextResponse.json({ ok: true });
}
