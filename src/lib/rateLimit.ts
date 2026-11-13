// Slows down guessing at the passcode and passwords: after 10 failed tries from one address in 15 minutes, that address
// is turned away until the 15 minutes are up. Successful tries never count. Kept in memory: the app is one process,
// and a restart forgetting the counts is harmless.

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
// Bounds the memory one attacker rotating addresses can take; the oldest entries go first.
const MAX_ENTRIES = 10_000;

type Entry = { failures: number; resetAt: number };
const entries = new Map<string, Entry>();

/** The visitor's address: the first entry of x-forwarded-for (set by Railway's edge), or one shared bucket without it. */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function prune(now: number) {
  for (const [key, e] of entries) if (e.resetAt <= now) entries.delete(key);
  for (const key of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    entries.delete(key);
  }
}

/** Whether this key has used up its failed tries for the current window. */
export function isLimited(key: string, now = Date.now()): boolean {
  const e = entries.get(key);
  if (!e) return false;
  if (e.resetAt <= now) {
    entries.delete(key);
    return false;
  }
  return e.failures >= MAX_FAILURES;
}

/** Counts one failed try. The window starts at the first failure and is not extended by later ones. */
export function recordFailure(key: string, now = Date.now()) {
  prune(now);
  const e = entries.get(key);
  if (e && e.resetAt > now) e.failures++;
  else entries.set(key, { failures: 1, resetAt: now + WINDOW_MS });
}

/** The answer for an address that has run out of tries. */
export function tooManyTries(): Response {
  return Response.json({ error: "Too many wrong tries. Please wait 15 minutes, then try again." }, { status: 429 });
}

/**
 * Runs a sign-in style handler under the limiter: refuses straight away when the address is over the limit, and counts
 * the answer as a failure when it isn't a success (2xx). `scope` keeps the passcode, sign-in and sign-up counts apart.
 */
export async function limited(scope: string, request: Request, handler: () => Promise<Response>): Promise<Response> {
  const key = `${scope}:${clientIp(request)}`;
  if (isLimited(key)) return tooManyTries();
  const res = await handler();
  if (!res.ok) recordFailure(key);
  return res;
}

/** For tests: forget every count. */
export function resetRateLimits() {
  entries.clear();
}

/** For tests: how many keys are held. */
export function rateLimitSize(): number {
  return entries.size;
}
