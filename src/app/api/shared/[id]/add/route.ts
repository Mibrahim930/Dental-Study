import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { addSharedExam } from "@/lib/classes";

export async function POST(_request: Request, ctx: RouteContext<"/api/shared/[id]/add">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const result = addSharedExam(user.id, Number((await ctx.params).id));
  return "error" in result ? NextResponse.json(result, { status: 400 }) : NextResponse.json(result);
}
