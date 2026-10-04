import { NextResponse } from "next/server";
import { db, type User } from "@/lib/db";
import { cookieOptions, SESSION_COOKIE, sessionToken, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string };
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email?.trim().toLowerCase() ?? "") as User | undefined;
  if (!user || !password || !verifyPassword(password, user.password_hash)) {
    return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, hasKey: !!user.api_key_enc, mustChangePassword: !!user.must_change_password });
  res.cookies.set(SESSION_COOKIE, sessionToken(user.id), cookieOptions());
  return res;
}
