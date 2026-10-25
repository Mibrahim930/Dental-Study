import { toast } from "./Toaster";

/** A message the server sent on purpose (the `error` field of its JSON answer), safe to show the student as-is. */
export class ServerMessage extends Error {}

/**
 * What to tell the student when a request failed. Only a message the server wrote on purpose is shown; a dropped
 * connection rejects with a TypeError whose text is the browser's ("Failed to fetch", "Load failed"), not hers.
 */
export function failureText(err: unknown, fallback: string): string {
  return err instanceof ServerMessage && err.message ? err.message : fallback;
}

/**
 * True when a request answered 401: the sign-in cookie is gone, or was signed out by a password change on another
 * device. The student is told and sent to sign in; callers return at once instead of showing "check your connection".
 */
export function signedOut(res: Response): boolean {
  if (res.status !== 401) return false;
  toast("You've been signed out. Sign in again.", "error");
  // A full page load on purpose: it drops every piece of client state that belonged to the old sign-in.
  window.location.assign(new URL("/account", window.location.origin).toString());
  return true;
}

/** The JSON body of an answer, or null when it isn't JSON (a proxy error page, an empty body). */
export async function jsonOf<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}
