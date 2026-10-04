import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cookieOptions, hashPassword, SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { claimLegacyData } from "@/lib/credentials";

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string };
  const cleanEmail = email?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  if (!password || password.length < 8) return NextResponse.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(cleanEmail)) {
    return NextResponse.json({ error: "An account with that email already exists. Sign in instead." }, { status: 409 });
  }
  const isFirst = !db.prepare("SELECT 1 FROM users LIMIT 1").get();
  const id = Number(db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(cleanEmail, hashPassword(password)).lastInsertRowid);
  if (isFirst) claimLegacyData(id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, sessionToken(id), cookieOptions());
  return res;
}
