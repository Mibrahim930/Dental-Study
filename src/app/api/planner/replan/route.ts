import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { replanFromToday } from "@/lib/planner";

/** "Re-plan from today" after missed tasks. */
export async function POST() {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { message, topicsBack, warnings } = replanFromToday(user.id);
  return NextResponse.json({ message, topicsBack, warnings });
}
