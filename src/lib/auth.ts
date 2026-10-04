// Single-passcode access: the student types APP_PASSCODE once; we store a signed token in a cookie.
export const AUTH_COOKIE = "study_auth";

export async function passcodeToken(passcode: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("dental-study-session"));
  return Buffer.from(sig).toString("hex");
}
