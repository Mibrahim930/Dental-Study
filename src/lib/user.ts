import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db, type User } from "./db";
import { SESSION_COOKIE, sessionUserId } from "./auth";

export { credentials, claimLegacyData, type Credentials, type Provider } from "./credentials";

export async function currentUser(): Promise<User | null> {
  const id = sessionUserId((await cookies()).get(SESSION_COOKIE)?.value);
  if (!id) return null;
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined) ?? null;
}

/** For pages: the signed-in user with an API key set up, or a redirect to sign-in / key setup. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/account");
  if (!user.api_key_enc) redirect("/setup");
  return user;
}

/** For API routes: the signed-in user, or null (respond 401). */
export async function apiUser(): Promise<User | null> {
  const user = await currentUser();
  return user?.api_key_enc ? user : null;
}

export function unauthorized() {
  return Response.json({ error: "Please sign in again." }, { status: 401 });
}

export function notFound() {
  return Response.json({ error: "Not found" }, { status: 404 });
}

