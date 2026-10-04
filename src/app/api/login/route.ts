import { NextResponse } from "next/server";
import { AUTH_COOKIE, passcodeToken } from "@/lib/auth";

export async function POST(request: Request) {
  const { passcode } = (await request.json()) as { passcode?: string };
  const expected = process.env.APP_PASSCODE;
  if (!expected || passcode !== expected) {
    return NextResponse.json({ error: "Wrong passcode" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await passcodeToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 180,
    path: "/",
  });
  return res;
}
