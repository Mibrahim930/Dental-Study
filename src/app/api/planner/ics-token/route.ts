import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { regenerateIcsToken } from "@/lib/planner";

// New subscription link; the old one stops working.
export async function POST() {
  const user = await apiUser();
  if (!user) return unauthorized();
  regenerateIcsToken(user.id);
  return NextResponse.json({ ok: true });
}
