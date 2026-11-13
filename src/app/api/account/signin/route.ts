import { NextResponse } from "next/server";
import { db, type User } from "@/lib/db";
import { cookieOptions, DUMMY_PASSWORD_HASH, MAX_PASSWORD, PASSWORD_TOO_LONG, SESSION_COOKIE, sessionToken, verifyPassword } from "@/lib/auth";
import { readJson } from "@/lib/http";
import { limited } from "@/lib/rateLimit";

export async function POST(request: Request) {
  return limited("signin", request, async () => {
    const { email, password } = await readJson(request);
    if (typeof password === "string" && password.length > MAX_PASSWORD) return NextResponse.json({ error: PASSWORD_TOO_LONG }, { status: 400 });
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail) as User | undefined;
    // An unknown email still costs one password check, so it answers no faster than a known one.
    const ok = typeof password === "string" && !!password && (await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH));
    if (!user || !ok) return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    const res = NextResponse.json({ ok: true, hasKey: !!user.api_key_enc, mustChangePassword: !!user.must_change_password });
    res.cookies.set(SESSION_COOKIE, sessionToken(user.id, user.session_epoch ?? 0), cookieOptions());
    return res;
  });
}
