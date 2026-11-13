import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { shareExam } from "@/lib/classes";
import { readJson } from "@/lib/http";

export async function POST(request: Request, ctx: RouteContext<"/api/classes/[id]/share">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { examId } = await readJson(request);
  const error = Number.isInteger(examId) ? shareExam(user.id, Number((await ctx.params).id), examId as number) : "Exam not found.";
  return error ? NextResponse.json({ error }, { status: 400 }) : NextResponse.json({ ok: true });
}
