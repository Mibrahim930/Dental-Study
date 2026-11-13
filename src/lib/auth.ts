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

/**
 * Whether a typed passcode is the site passcode. Both sides are hashed first so the comparison takes the same time
 * whatever was typed (a plain !== stops at the first wrong character, which leaks how much of a guess was right).
 */
export function passcodeMatches(given: unknown): boolean {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return true;
  if (typeof given !== "string") return false;
  const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

// ---- Sessions ----

/**
 * Signed sign-in cookie: `userId.issuedAt.epoch.signature`. The epoch is the user's `session_epoch` at sign-in; a
 * password change bumps it, so cookies issued before (other phones, a shared laptop) stop matching and are signed out.
 * Cookies from before epochs existed have no epoch part and count as epoch 0, so nobody is signed out by the upgrade.
 */
export function sessionToken(userId: number, epoch = 0): string {
  const payload = `${userId}.${Date.now()}.${epoch}`;
  return `${payload}.${sign(`session:${payload}`)}`;
}

/**
 * The user id and epoch in a session cookie, if the signature is valid and the cookie is younger than COOKIE_MAX_AGE.
 * The browser drops the cookie at that age anyway; checking here too means a copied cookie can't be used for ever.
 */
export function sessionParts(token: string | undefined, now = Date.now()): { userId: number; epoch: number } | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), sign(`session:${payload}`))) return null;
  const [idPart, issuedPart, epochPart] = payload.split(".");
  const userId = Number(idPart);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const issuedAt = Number(issuedPart);
  if (!Number.isFinite(issuedAt) || now - issuedAt > COOKIE_MAX_AGE * 1000) return null;
  const epoch = epochPart === undefined ? 0 : Number(epochPart);
  if (!Number.isInteger(epoch) || epoch < 0) return null;
  return { userId, epoch };
}

/** The user id in a session cookie, if the signature is valid. (Epoch is checked against the database in currentUser.) */
export function sessionUserId(token: string | undefined): number | null {
  return sessionParts(token)?.userId ?? null;
}

// ---- Passwords ----

/** Longer passwords are refused: scrypt's work grows with the length, so a huge one would tie up the server. */
export const MAX_PASSWORD = 1000;
export const PASSWORD_TOO_LONG = "Use a password of at most 1,000 characters.";

// The async scrypt runs on Node's thread pool, so one sign-in doesn't freeze every other request meanwhile.
// Same default cost settings as the scryptSync used before, so every stored password still verifies.
function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * A well-formed hash no password matches. Sign-in checks the typed password against it when the email is unknown,
 * so a wrong email takes as long to answer as a wrong password and doesn't reveal which emails have accounts.
 */
export const DUMMY_PASSWORD_HASH = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`;

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
