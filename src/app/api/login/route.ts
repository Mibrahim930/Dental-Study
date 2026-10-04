import { NextResponse } from "next/server";
import { cookieOptions, GATE_COOKIE, gateToken } from "@/lib/auth";

// Step 1: the site passcode.
export async function POST(request: Request) {
  const { passcode } = (await request.json()) as { passcode?: string };
  const expected = process.env.APP_PASSCODE;
  if (expected && passcode !== expected) return NextResponse.json({ error: "Wrong passcode" }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(GATE_COOKIE, gateToken(), cookieOptions());
  return res;
}

