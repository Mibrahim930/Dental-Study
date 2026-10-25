import crypto from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cookieOptions, hashPassword, SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { apiAdmin, notFound, revokeSessions, unauthorized } from "@/lib/user";

// Admin sets a temporary password; the user must choose a new one at next sign-in.
export async function POST(_request: Request, ctx: RouteContext<"/api/admin/users/[id]/reset-password">) {
  const admin = await apiAdmin();
  if (!admin) return unauthorized();
  const id = Number((await ctx.params).id);
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return notFound();
  // Readable temporary password (no look-alike characters).
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const temp = Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(hashPassword(temp), id);
  // Whoever is signed in as that user (a lost phone, say) is signed out everywhere.
  const epoch = revokeSessions(id);
  const res = NextResponse.json({ tempPassword: temp });
  // Resetting their own password keeps the admin signed in on this device (they're then sent to choose a new one).
  if (id === admin.id) res.cookies.set(SESSION_COOKIE, sessionToken(id, epoch), cookieOptions());
  return res;
}
