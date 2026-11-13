// Wave 1, sign-in and the gate: the failed-try limiter (S1), the timing-safe passcode (S1), async password hashing with a
// length cap (S2), malformed bodies (S6), cookie expiry and the feed token rotated on an admin reset (S9), and the proxy
// matcher's exemptions (S13).
import crypto from "crypto";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_MAX_AGE, DUMMY_PASSWORD_HASH, hashPassword, passcodeMatches, SESSION_COOKIE, sessionParts, sessionToken, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { icsToken } from "@/lib/planner";
import { clientIp, isLimited, MAX_FAILURES, rateLimitSize, recordFailure, resetRateLimits, WINDOW_MS } from "@/lib/rateLimit";
import { userForSession } from "@/lib/user";
import { config } from "@/proxy";
import { POST as loginPOST } from "@/app/api/login/route";
import { POST as signinPOST } from "@/app/api/account/signin/route";
import { POST as signupPOST } from "@/app/api/account/signup/route";
import { POST as passwordPOST } from "@/app/api/account/password/route";
import { POST as keyPOST } from "@/app/api/account/key/route";
import { POST as resetPOST } from "@/app/api/admin/users/[id]/reset-password/route";
import { makeUser } from "./helpers";

// The routes read the session cookie through next/headers; tests set it here.
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }),
}));
// Never reached with the bodies used here, but a key check must never call out.
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), verifyKey: vi.fn(async () => "not checked in tests") }));

const post = (url: string, body: string, ip = "203.0.113.1") =>
  new Request(`http://x${url}`, { method: "POST", body, headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` } });
const json = (v: unknown) => JSON.stringify(v);

/** A password hash exactly as the old synchronous hashPassword wrote it. */
function oldFormatHash(password: string): string {
  const salt = crypto.randomBytes(16);
  return ["scrypt", salt.toString("base64"), crypto.scryptSync(password, salt, 64).toString("base64")].join("$");
}

let n = 0;
function account(password: string, opts: { admin?: boolean } = {}) {
  const email = `w1-${++n}-${Date.now()}@test.dev`;
  const id = makeUser();
  db.prepare("UPDATE users SET email = ?, password_hash = ?, api_key_enc = 'enc', must_change_password = 0, is_admin = ? WHERE id = ?").run(
    email,
    oldFormatHash(password),
    opts.admin ? 1 : 0,
    id,
  );
  return { id, email };
}

beforeEach(() => {
  resetRateLimits();
  jar.cookie = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe("S1 limiter", () => {
  it("allows 10 failures, refuses the 11th, per key, and forgets them after the window", () => {
    const t = 1_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(isLimited("a", t)).toBe(false);
      recordFailure("a", t + i);
    }
    expect(isLimited("a", t + 20)).toBe(true);
    expect(isLimited("b", t + 20)).toBe(false); // another address is untouched
    expect(isLimited("a", t + WINDOW_MS - 1)).toBe(true);
    expect(isLimited("a", t + WINDOW_MS + 1)).toBe(false);
  });

  it("does not grow without bound: expired entries are dropped", () => {
    for (let i = 0; i < 500; i++) recordFailure(`old-${i}`, 0);
    expect(rateLimitSize()).toBe(500);
    recordFailure("new", WINDOW_MS + 1);
    expect(rateLimitSize()).toBe(1);
  });

  it("reads the first x-forwarded-for entry, with one shared bucket when it's missing", () => {
    expect(clientIp(post("/", "{}", "198.51.100.7"))).toBe("198.51.100.7");
    expect(clientIp(new Request("http://x/"))).toBe("unknown");
  });

  it("passcode: 10 wrong tries from one address give 429 with a plain message; right tries don't count; other addresses still work", async () => {
    for (let i = 0; i < 9; i++) expect((await loginPOST(post("/api/login", json({ passcode: "nope" })))).status).toBe(401);
    // Successes in between don't count and don't reset anything.
    for (let i = 0; i < 5; i++) expect((await loginPOST(post("/api/login", json({ passcode: "test" })))).status).toBe(200);
    expect((await loginPOST(post("/api/login", json({ passcode: "nope" })))).status).toBe(401);
    const res = await loginPOST(post("/api/login", json({ passcode: "test" })));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/wait/i);
    expect((await loginPOST(post("/api/login", json({ passcode: "test" }), "198.51.100.9"))).status).toBe(200);
  });

  it("sign-in and sign-up are limited the same way", async () => {
    const { email } = account("right-password");
    for (let i = 0; i < MAX_FAILURES; i++) expect((await signinPOST(post("/api/account/signin", json({ email, password: "wrong-pass" })))).status).toBe(401);
    expect((await signinPOST(post("/api/account/signin", json({ email, password: "right-password" })))).status).toBe(429);
    expect((await signinPOST(post("/api/account/signin", json({ email, password: "right-password" }), "198.51.100.10"))).status).toBe(200);

    for (let i = 0; i < MAX_FAILURES; i++) expect((await signupPOST(post("/api/account/signup", json({ email, password: "whatever-1" })))).status).toBe(409);
    expect((await signupPOST(post("/api/account/signup", json({ email: `fresh-${Date.now()}@test.dev`, password: "whatever-1" })))).status).toBe(429);
  });

  it("sign-in runs the password check for an unknown email too (no faster answer)", async () => {
    const spy = vi.spyOn(crypto, "scrypt");
    const res = await signinPOST(post("/api/account/signin", json({ email: "nobody@test.dev", password: "some-password" })));
    expect(res.status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await verifyPassword("anything", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe("S1 passcode comparison", () => {
  it("accepts exactly the passcode and nothing else", () => {
    expect(passcodeMatches("test")).toBe(true);
    for (const wrong of ["", "tes", "test ", "TEST", "testtest", 1234, null, undefined, ["test"]]) expect(passcodeMatches(wrong), String(wrong)).toBe(false);
  });
  it("uses timingSafeEqual over equal-length digests", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    passcodeMatches("a much longer guess than the passcode");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as Buffer).length).toBe(32);
  });
});

describe("S2 async passwords", () => {
  it("hash round-trips, is salted, and an old-format hash still verifies", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
    const old = oldFormatHash("from before");
    expect(await verifyPassword("from before", old)).toBe(true);
    expect(await verifyPassword("from after", old)).toBe(false);
    expect(await verifyPassword("x", "x")).toBe(false);
    expect(await verifyPassword("x", "scrypt$AAAA$AAAA")).toBe(false); // wrong-length hash: false, not a throw
  });

  it("refuses passwords over 1,000 characters at sign-in, sign-up and password change", async () => {
    const long = "a".repeat(1001);
    const { id, email } = account("right-password");
    for (const res of [
      await signinPOST(post("/api/account/signin", json({ email, password: long }))),
      await signupPOST(post("/api/account/signup", json({ email: `long-${Date.now()}@test.dev`, password: long }))),
    ]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/1,000/);
    }
    jar.cookie = sessionToken(id, 0);
    const res = await passwordPOST(post("/api/account/password", json({ current: "right-password", next: long })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/1,000/);
    // Exactly 1,000 is fine.
    const ok = await passwordPOST(post("/api/account/password", json({ current: "right-password", next: "b".repeat(1000) })));
    expect(ok.status).toBe(200);
  });
});

describe("S9 session expiry and feed token", () => {
  it("a cookie older than the cookie max age is refused; a fresh one is accepted", () => {
    const now = Date.now();
    const t = sessionToken(7, 0);
    expect(sessionParts(t, now)).toEqual({ userId: 7, epoch: 0 });
    expect(sessionParts(t, now + COOKIE_MAX_AGE * 1000 - 60_000)).toEqual({ userId: 7, epoch: 0 });
    expect(sessionParts(t, now + COOKIE_MAX_AGE * 1000 + 60_000)).toBeNull();
  });

  it("currentUser's lookup refuses a cookie issued 181 days ago", () => {
    const { id } = account("pw-12345678");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 181 * 24 * 3600 * 1000);
    const old = sessionToken(id, 0);
    vi.restoreAllMocks();
    expect(userForSession(old)).toBeNull();
    expect(userForSession(sessionToken(id, 0))?.id).toBe(id);
  });

  it("an admin password reset gives the user a new calendar feed link", async () => {
    const admin = account("admin-pass", { admin: true });
    const student = account("student-pass");
    const before = icsToken(student.id);
    jar.cookie = sessionToken(admin.id, 0);
    const res = await resetPOST(new Request("http://x/", { method: "POST" }), { params: Promise.resolve({ id: String(student.id) }) } as never);
    expect(res.status).toBe(200);
    const after = icsToken(student.id);
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(20);
  });
});

describe("S13 proxy matcher", () => {
  // The matcher as Next compiles it (with its .rsc/.json transport endings), plus the plain form other tests use.
  const require = createRequire(import.meta.url);
  const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js") as {
    getMiddlewareMatchers: (m: string[], cfg: object) => { regexp: string }[];
  };
  const compiled = new RegExp(getMiddlewareMatchers(config.matcher, {})[0].regexp);
  const plain = new RegExp("^" + config.matcher[0] + "$");
  const exempt = ["/login", "/login.rsc", "/api/login", "/api/ics/abc123", "/api/ics/abc123.ics", "/_next/static/chunks/a.js", "/favicon.ico", "/icon.svg", "/apple-icon", "/manifest.webmanifest"];
  const guarded = ["/", "/account", "/exams/1", "/api/review", "/loginfoo", "/api/loginx", "/api/icsfoo/bar", "/api/ics/a/b", "/icon.svg.bak", "/apple-icon-evil", "/manifest.webmanifest/x", "/_next/image"];
  it.each(exempt)("%s skips the proxy", (p) => {
    expect(compiled.test(p)).toBe(false);
    expect(plain.test(p)).toBe(false);
  });
  it.each(guarded)("%s goes through the proxy", (p) => {
    expect(compiled.test(p)).toBe(true);
    expect(plain.test(p)).toBe(true);
  });
});

describe("S6 malformed bodies", () => {
  const bodies = ["", "not json", "null", "[]", '"a string"', "42", json({ email: 5, password: {}, passcode: [], current: 1, next: null, provider: {}, apiKey: 9 })];
  const routes: [string, (r: Request) => Promise<Response>, boolean][] = [
    ["/api/login", loginPOST, false],
    ["/api/account/signin", signinPOST, false],
    ["/api/account/signup", signupPOST, false],
    ["/api/account/password", passwordPOST, true],
    ["/api/account/key", keyPOST, true],
  ];
  it.each(routes)("%s answers 4xx JSON and never throws", async (url, handler, needsUser) => {
    const { id } = account("right-password");
    for (const body of bodies) {
      resetRateLimits();
      if (needsUser) jar.cookie = sessionToken(id, 0);
      const res = await handler(post(url, body));
      expect(res.status, `${url} ${body}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${url} ${body}`).toBeLessThan(500);
      expect(typeof (await res.json()).error).toBe("string");
    }
  });
});
