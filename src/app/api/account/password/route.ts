import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cookieOptions, hashPassword, SESSION_COOKIE, sessionToken, verifyPassword } from "@/lib/auth";
import { currentUser, revokeSessions, unauthorized } from "@/lib/user";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { current, next } = (await request.json()) as { current?: string; next?: string };
  if (!current || !verifyPassword(current, user.password_hash)) return NextResponse.json({ error: "Your current password is wrong." }, { status: 400 });
  if (!next || next.length < 8) return NextResponse.json({ error: "Use a new password of at least 8 characters." }, { status: 400 });
  if (next === current) return NextResponse.json({ error: "Pick a password different from the current one." }, { status: 400 });
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(next), user.id);
  // Every other device is signed out; this one gets a fresh cookie so the student stays signed in here.
  const epoch = revokeSessions(user.id);
  const res = NextResponse.json({ ok: true, hasKey: !!user.api_key_enc, signedOutElsewhere: true });
  res.cookies.set(SESSION_COOKIE, sessionToken(user.id, epoch), cookieOptions());
  return res;
}
