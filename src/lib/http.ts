// Small helpers every API route shares, so a bad body or an AI failure is handled the same way everywhere.

/**
 * The JSON object a request carries, or {} when the body is missing, isn't JSON, or isn't an object (null, an array,
 * a string). Routes read fields off the result and check their types; nothing throws on a malformed body.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A string field of a body, trimmed; "" when it is missing or not a string. */
export function str(v: unknown, max = 10_000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Error text from the AI provider that the student should see as-is (her key or her billing), as opposed to an
 * internal error, which must never reach her.
 */
export function isKeyProblem(msg: string): boolean {
  return /x-api-key|api[ _-]?key|authentication|unauthori[sz]ed|permission|\b401\b|\b403\b|credit balance|billing|quota/i.test(msg) && !/SQLITE|\bat \/|node:internal/i.test(msg);
}

/**
 * The answer for a failed AI call: the provider's own words when the problem is her key or billing, else `fallback`.
 * The technical detail goes to the server log under `what`. Status 502: the upstream failed, not this server.
 */
export function aiFailure(err: unknown, what: string, fallback: string): Response {
  console.error(`${what} failed`, err);
  const msg = err instanceof Error ? err.message : String(err);
  return Response.json({ error: isKeyProblem(msg) ? msg : fallback }, { status: 502 });
}
