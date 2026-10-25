import { cookies } from "next/headers";
import { notFound as notFoundPage, redirect } from "next/navigation";
import { db, type User } from "./db";
import { SESSION_COOKIE, sessionParts } from "./auth";

export { credentials, claimLegacyData, type Credentials, type Provider } from "./credentials";

export async function currentUser(): Promise<User | null> {
  return userForSession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** The user a session cookie belongs to, or null if it was forged or issued before the user's last password change. */
export function userForSession(token: string | undefined): User | null {
  const parts = sessionParts(token);
  if (!parts) return null;
  const user = (db.prepare("SELECT * FROM users WHERE id = ?").get(parts.userId) as User | undefined) ?? null;
  if (!user || (user.session_epoch ?? 0) !== parts.epoch) return null;
  return user;
}

/** Signs every other device out of this account: cookies issued so far no longer match. Returns the new epoch. */
export function revokeSessions(userId: number): number {
  db.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?").run(userId);
  return (db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(userId) as { session_epoch: number }).session_epoch;
}

/** For pages: the signed-in user with an API key set up, or a redirect to sign-in / key setup. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/account");
  if (user.must_change_password) redirect("/account/password");
  if (!user.api_key_enc) redirect("/setup");
  return user;
}

/** For admin pages: the site owner, or a 404. */
export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!user.is_admin) notFoundPage();
  return user;
}

/** For API routes: the signed-in user, or null (respond 401). */
export async function apiUser(): Promise<User | null> {
  const user = await currentUser();
  return user?.api_key_enc && !user.must_change_password ? user : null;
}

export async function apiAdmin(): Promise<User | null> {
  const user = await apiUser();
  return user?.is_admin ? user : null;
}

export function unauthorized() {
  return Response.json({ error: "Please sign in again." }, { status: 401 });
}

export function notFound() {
  return Response.json({ error: "Not found" }, { status: 404 });
}

