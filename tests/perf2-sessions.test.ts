// Perf batch 2, sign-in revocation: a password change (or an admin reset) signs out every other device.
// The session cookie carries the user's `session_epoch`; currentUser rejects a cookie whose epoch no longer matches.
import crypto from "crypto";
import type { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, hashPassword, sessionParts, sessionToken, sessionUserId } from "@/lib/auth";
import { db } from "@/lib/db";
import { revokeSessions, userForSession } from "@/lib/user";
import { makeUser } from "./helpers";

// The routes read the cookie through next/headers; tests set it here.
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }),
}));

/** The session cookie a route set on its answer, if any (routes may also answer with a plain Response). */
const setCookie = (res: Response) => (res as NextResponse).cookies?.get(SESSION_COOKIE)?.value;

const epochOf = (id: number) => (db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(id) as { session_epoch: number }).session_epoch;

function signedIn(userId: number) {
  const token = sessionToken(userId, epochOf(userId));
  jar.cookie = token;
  return token;
}

/** A user who can call API routes: has a key and no pending password change. */
function apiReadyUser(password = "old-password", admin = false) {
  const id = makeUser();
  db.prepare("UPDATE users SET password_hash = ?, api_key_enc = 'enc', must_change_password = 0, is_admin = ? WHERE id = ?").run(hashPassword(password), admin ? 1 : 0, id);
  return id;
}

/** A cookie exactly as the previous version wrote it: `id.timestamp.signature`, signed over `session:id.timestamp`. */
function legacyToken(userId: number): string {
  const payload = `${userId}.${Date.now()}`;
  // Same construction as lib/auth.ts sign(): HMAC-SHA256 over the payload with sha256(SECRET_KEY) as the key.
  const key = crypto.createHash("sha256").update(process.env.SECRET_KEY!).digest();
  const sig = crypto.createHmac("sha256", key).update(`session:${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

describe("session cookie carries an epoch", () => {
  it("round-trips the user id and epoch, and still accepts cookies from before epochs existed (as epoch 0)", () => {
    const t = sessionToken(42, 3);
    expect(sessionParts(t)).toEqual({ userId: 42, epoch: 3 });
    expect(sessionUserId(t)).toBe(42);
    // Cookies issued by the previous version have no epoch part. Nobody is signed out by the upgrade.
    expect(sessionParts(legacyToken(42))).toEqual({ userId: 42, epoch: 0 });
    expect(sessionUserId(legacyToken(42))).toBe(42);
  });

  it("rejects a tampered epoch, a tampered id and garbage", () => {
    const t = sessionToken(42, 1);
    const [id, ts, , sig] = t.split(".");
    expect(sessionParts(`${id}.${ts}.0.${sig}`)).toBeNull(); // epoch rolled back
    expect(sessionParts(`${id}.${ts}.2.${sig}`)).toBeNull(); // epoch rolled forward
    expect(sessionParts(`43.${ts}.1.${sig}`)).toBeNull();
    expect(sessionParts(`${id}.${ts}.1.AAAA`)).toBeNull();
    expect(sessionParts("x.y")).toBeNull();
    expect(sessionParts("")).toBeNull();
    expect(sessionParts(undefined)).toBeNull();
  });
});

describe("userForSession / revokeSessions", () => {
  it("accepts the current epoch only; a revocation signs older cookies out", () => {
    const id = makeUser();
    const t0 = sessionToken(id, 0);
    expect(userForSession(t0)?.id).toBe(id);
    expect(userForSession(legacyToken(id))?.id).toBe(id);

    expect(revokeSessions(id)).toBe(1);
    expect(userForSession(t0)).toBeNull();
    expect(userForSession(legacyToken(id))).toBeNull();
    expect(userForSession(sessionToken(id, 1))?.id).toBe(id);
    // A cookie claiming a *future* epoch doesn't work either.
    expect(userForSession(sessionToken(id, 2))).toBeNull();
  });

  it("revoking one user leaves everyone else signed in", () => {
    const a = makeUser();
    const b = makeUser();
    const tb = sessionToken(b, 0);
    revokeSessions(a);
    expect(userForSession(tb)?.id).toBe(b);
    expect(epochOf(b)).toBe(0);
  });

  it("a deleted user's cookie is just invalid", () => {
    const id = makeUser();
    const t = sessionToken(id, 0);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    expect(userForSession(t)).toBeNull();
  });
});

describe("POST /api/account/password", () => {
  it("bumps the epoch, keeps this device signed in with a fresh cookie, and signs the others out", async () => {
    const { POST } = await import("@/app/api/account/password/route");
    const id = apiReadyUser("old-password");
    const phone = signedIn(id); // the device making the change
    const laptop = sessionToken(id, 0); // another device, signed in earlier
    expect(userForSession(laptop)?.id).toBe(id);

    const res = await POST(new Request("http://x/api/account/password", { method: "POST", body: JSON.stringify({ current: "old-password", next: "new-password-1" }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, signedOutElsewhere: true });
    expect(epochOf(id)).toBe(1);

    const fresh = setCookie(res);
    expect(fresh).toBeTruthy();
    expect(sessionParts(fresh)).toEqual({ userId: id, epoch: 1 });
    expect(userForSession(fresh)?.id).toBe(id);
    expect(userForSession(phone)).toBeNull();
    expect(userForSession(laptop)).toBeNull();
  });

  it("a wrong current password changes nothing (no epoch bump, no cookie)", async () => {
    const { POST } = await import("@/app/api/account/password/route");
    const id = apiReadyUser("old-password");
    const phone = signedIn(id);
    const res = await POST(new Request("http://x/api/account/password", { method: "POST", body: JSON.stringify({ current: "nope", next: "new-password-1" }) }));
    expect(res.status).toBe(400);
    expect(epochOf(id)).toBe(0);
    expect(setCookie(res)).toBeUndefined();
    expect(userForSession(phone)?.id).toBe(id);
  });

  it("a cookie from before the last password change is refused by the route itself", async () => {
    const { POST } = await import("@/app/api/account/password/route");
    const id = apiReadyUser("old-password");
    jar.cookie = sessionToken(id, 0);
    revokeSessions(id);
    const res = await POST(new Request("http://x/api/account/password", { method: "POST", body: JSON.stringify({ current: "old-password", next: "new-password-1" }) }));
    expect(res.status).toBe(401);
    expect(epochOf(id)).toBe(1);
  });
});

describe("POST /api/account/signin issues a cookie with the user's current epoch", () => {
  it("signing in again after a change works, with the new epoch", async () => {
    const { POST } = await import("@/app/api/account/signin/route");
    const id = apiReadyUser("pass-word-1");
    revokeSessions(id);
    revokeSessions(id);
    const email = (db.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string }).email;
    const res = await POST(new Request("http://x/api/account/signin", { method: "POST", body: JSON.stringify({ email, password: "pass-word-1" }) }));
    expect(res.status).toBe(200);
    const cookie = setCookie(res);
    expect(sessionParts(cookie)).toEqual({ userId: id, epoch: 2 });
    expect(userForSession(cookie)?.id).toBe(id);
  });
});

describe("POST /api/admin/users/[id]/reset-password", () => {
  type Route = typeof import("@/app/api/admin/users/[id]/reset-password/route");
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as unknown as Parameters<Route["POST"]>[1];

  it("signs the reset user out everywhere; the admin's own cookie is untouched", async () => {
    const { POST } = await import("@/app/api/admin/users/[id]/reset-password/route");
    const admin = apiReadyUser("admin-pass", true);
    const student = apiReadyUser("student-pass");
    const studentPhone = sessionToken(student, 0);
    const adminCookie = signedIn(admin);

    const res = await POST(new Request("http://x/api/admin/users/reset", { method: "POST" }), ctx(student));
    expect(res.status).toBe(200);
    const { tempPassword } = (await res.json()) as { tempPassword: string };
    expect(tempPassword).toHaveLength(10);
    expect(epochOf(student)).toBe(1);
    expect(userForSession(studentPhone)).toBeNull();
    expect(setCookie(res)).toBeUndefined();
    expect(userForSession(adminCookie)?.id).toBe(admin);
    expect(epochOf(admin)).toBe(0);
  });

  it("resetting their own password keeps the admin signed in on this device", async () => {
    const { POST } = await import("@/app/api/admin/users/[id]/reset-password/route");
    const admin = apiReadyUser("admin-pass", true);
    const before = signedIn(admin);
    const res = await POST(new Request("http://x/api/admin/users/reset", { method: "POST" }), ctx(admin));
    expect(res.status).toBe(200);
    expect(epochOf(admin)).toBe(1);
    expect(userForSession(before)).toBeNull();
    const fresh = setCookie(res);
    expect(sessionParts(fresh)).toEqual({ userId: admin, epoch: 1 });
    expect(userForSession(fresh)?.must_change_password).toBe(1);
  });

  it("a non-admin gets 401 and nothing changes", async () => {
    const { POST } = await import("@/app/api/admin/users/[id]/reset-password/route");
    const student = apiReadyUser("student-pass");
    const other = apiReadyUser("other-pass");
    signedIn(student);
    const res = await POST(new Request("http://x/api/admin/users/reset", { method: "POST" }), ctx(other));
    expect(res.status).toBe(401);
    expect(epochOf(other)).toBe(0);
  });
});
