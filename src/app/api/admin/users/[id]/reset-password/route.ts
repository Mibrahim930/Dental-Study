import crypto from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { apiAdmin, notFound, unauthorized } from "@/lib/user";

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
  return NextResponse.json({ tempPassword: temp });
}
