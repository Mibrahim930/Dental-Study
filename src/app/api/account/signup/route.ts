import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cookieOptions, hashPassword, MAX_PASSWORD, PASSWORD_TOO_LONG, SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { claimLegacyData } from "@/lib/credentials";
import { readJson } from "@/lib/http";
import { limited } from "@/lib/rateLimit";

export async function POST(request: Request) {
  return limited("signup", request, async () => {
    const { email, password } = await readJson(request);
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    if (typeof password !== "string" || password.length < 8) return NextResponse.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
    if (password.length > MAX_PASSWORD) return NextResponse.json({ error: PASSWORD_TOO_LONG }, { status: 400 });
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(cleanEmail)) {
      return NextResponse.json({ error: "An account with that email already exists. Sign in instead." }, { status: 409 });
    }
    const hash = await hashPassword(password);
    // The first account is the site owner (admin) and inherits any data from before accounts existed. Checked after the
    // hash is ready, with no await in between, so two sign-ups at once can't both become the owner.
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(cleanEmail)) {
      return NextResponse.json({ error: "An account with that email already exists. Sign in instead." }, { status: 409 });
    }
    const isFirst = !db.prepare("SELECT 1 FROM users LIMIT 1").get();
    const id = Number(db.prepare("INSERT INTO users (email, password_hash, is_admin, theme) VALUES (?, ?, ?, 'blocks')").run(cleanEmail, hash, isFirst ? 1 : 0).lastInsertRowid);
    if (isFirst) claimLegacyData(id);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, sessionToken(id, 0), cookieOptions());
    return res;
  });
}
