// Stored error texts (a failed practice exam, section split or lecture upload) are often the raw text of a thrown
// error: "Error: 529 {"type":"overloaded_error"…}", a SQLite message, a stack line. This turns them into a plain
// sentence she can act on. Kept free of "use client" and of anything that touches the database, so pages, client
// components and tests can all use it.

/** Words that only appear in technical error text, never in a sentence the server wrote for the student. */
const TECHNICAL =
  /^\s*[A-Za-z]*Error\b|\bError:|SQLITE|\bat \/|node:internal|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|fetch failed|undefined|null\b|NaN|JSON|[{}[\]<>]|\bstatus\b|\b[45]\d\d\b|max_tokens|stop_reason|tool_use|stack|stream|request_id|https?:\/\//i;

const BILLING = /credit balance|billing|payment|insufficient.{0,20}(funds|credit)/i;
const REFUSED_KEY = /x-api-key|api[ _-]?key|authentication|unauthori[sz]ed|invalid.{0,10}key|\b401\b/i;
const NOT_ALLOWED = /permission|\b403\b/i;
/** A message from our own code or the file system, which may mention "permission" without being about her key. */
const INTERNAL = /SQLITE|\bat \/|node:internal|EACCES|EPERM/i;

/** True when the stored error is about her AI key or billing: something she fixes in Settings or her AI account. */
export function needsKeyFix(stored: string | null | undefined): boolean {
  const msg = stored ?? "";
  return !INTERNAL.test(msg) && (BILLING.test(msg) || REFUSED_KEY.test(msg) || NOT_ALLOWED.test(msg));
}

/**
 * A plain sentence for a stored error. Problems with her own AI key or billing are named (she can fix those);
 * a busy or rate-limited AI service says to wait; a sentence the server wrote on purpose is kept; anything else
 * technical becomes `fallback`.
 */
export function friendlyError(stored: string | null | undefined, fallback: string): string {
  const msg = (stored ?? "").trim();
  if (!msg) return fallback;
  // Same idea as isKeyProblem in lib/http.ts, split by what she has to do about it.
  if (!INTERNAL.test(msg)) {
    if (BILLING.test(msg)) return "Your AI account is out of credit. Add credit to your Anthropic account, then try again.";
    if (REFUSED_KEY.test(msg)) return "Your AI key was refused. Check it in Settings, then try again.";
    if (NOT_ALLOWED.test(msg)) return "Your AI key isn't allowed to do this. Check it in Settings, then try again.";
  }
  if (/quota|rate.?limit|\b429\b|too many requests/i.test(msg)) return "Your AI key hit its usage limit for now. Wait a minute, then try again.";
  if (/overloaded|\b529\b|\b503\b/i.test(msg)) return "The AI service is busy right now. Wait a few minutes, then try again.";
  // "Could not read this PDF: <library text>": keep her part, drop the library's.
  if (/^could not read this pdf/i.test(msg)) return "This PDF couldn't be read. Try exporting it again, or upload a different copy.";
  if (msg.length > 220 || TECHNICAL.test(msg)) return fallback;
  return msg;
}
