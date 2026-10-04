// Access control in two layers:
//   1. Site passcode (APP_PASSCODE) — keeps strangers out; stored as a signed "gate" cookie.
//   2. User accounts (email + password) — each user's data and API key are separate; signed "session" cookie.
// Cookie signing and API-key encryption both derive from SECRET_KEY.
import crypto from "crypto";

export const GATE_COOKIE = "study_gate";
export const SESSION_COOKIE = "study_session";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 180;

export function cookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: COOKIE_MAX_AGE, path: "/" };
}

function secret(): Buffer {
  const s = process.env.SECRET_KEY;
  if (!s) throw new Error("SECRET_KEY is not set. Add a long random value to the environment.");
  return crypto.createHash("sha256").update(s).digest();
}

function sign(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- Passcode gate ----

/** Token proving the visitor typed the current passcode (changes if the passcode changes). */
export function gateToken(): string {
  return sign(`gate:${process.env.APP_PASSCODE ?? ""}`);
}

export function gateOk(token: string | undefined): boolean {
  if (!process.env.APP_PASSCODE) return true;
  return !!token && safeEqual(token, gateToken());
}

// ---- Sessions ----

export function sessionToken(userId: number): string {
  const payload = `${userId}.${Date.now()}`;
  return `${payload}.${sign(`session:${payload}`)}`;
}

/** The user id in a session cookie, if the signature is valid. */
export function sessionUserId(token: string | undefined): number | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), sign(`session:${payload}`))) return null;
  const id = Number(payload.split(".")[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---- Passwords ----

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "base64"));
}

// ---- API key encryption (AES-256-GCM) ----

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(enc: string): string {
  const [iv, tag, data] = enc.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", secret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
