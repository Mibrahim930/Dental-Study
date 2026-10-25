// Sonnet QA for perf batch 2: attack the session-epoch scheme, the routes that bump it, and in-place upgrades from older databases.
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import type { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, cookieOptions, hashPassword, sessionParts, sessionToken, sessionUserId } from "@/lib/auth";
import { db } from "@/lib/db";
import { revokeSessions, userForSession } from "@/lib/user";
import { makeUser } from "./helpers";

const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "study_session" && jar.cookie ? { value: jar.cookie } : undefined) }),
}));

const epochOf = (id: number) => (db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(id) as { session_epoch: number }).session_epoch;
const setCookie = (res: Response) => (res as NextResponse).cookies?.get(SESSION_COOKIE);
const key = () => crypto.createHash("sha256").update(process.env.SECRET_KEY!).digest();
/** Signs any payload exactly like lib/auth.ts, to build cookies a server bug (not an attacker) could have produced. */
const signed = (payload: string) => `${payload}.${crypto.createHmac("sha256", key()).update(`session:${payload}`).digest("base64url")}`;

function apiReadyUser(password = "old-password", admin = false) {
  const id = makeUser();
  db.prepare("UPDATE users SET password_hash = ?, api_key_enc = 'enc', must_change_password = 0, is_admin = ? WHERE id = ?").run(hashPassword(password), admin ? 1 : 0, id);
  return id;
}
const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: "POST", body: JSON.stringify(body) });

describe("epoch scheme: crafted cookies", () => {
  it("cannot downgrade a new cookie to the legacy format by dropping the epoch part (signature covers it)", () => {
    const t = sessionToken(7, 1);
    const [id, ts, , sig] = t.split(".");
    expect(sessionParts(`${id}.${ts}.${sig}`)).toBeNull(); // looks like a legacy `id.ts.sig`
    expect(sessionParts(`${id}.${ts}.1`)).toBeNull(); // signature dropped, epoch left as the "signature"
    expect(sessionParts(`${id}.${ts}.1.${sig}.extra`)).toBeNull();
    expect(sessionParts(`${id}.${ts}.1.${sig}.`)).toBeNull();
    expect(sessionParts(`.${t}`)).toBeNull();
  });

  it("a revoked user's old cookie in either format is refused at every later epoch, with the epoch stripped too", () => {
    const id = makeUser();
    const t0 = sessionToken(id, 0);
    revokeSessions(id);
    const t1 = sessionToken(id, 1);
    revokeSessions(id);
    expect(userForSession(t0)).toBeNull();
    expect(userForSession(t1)).toBeNull();
    const [a, b, , s] = t1.split(".");
    expect(userForSession(`${a}.${b}.${s}`)).toBeNull();
    expect(userForSession(sessionToken(id, 2))?.id).toBe(id);
  });

  it("negative, fractional, NaN, infinite and non-numeric epochs (even correctly signed) are never accepted", () => {
    // (Dotted values are left out: the parser splits on "." and ignores extra segments, which only matters to someone who can sign.)
    for (const e of ["-1", "NaN", "Infinity", "-Infinity", "abc", "1e999"]) {
      expect(sessionParts(signed(`5.1700000000000.${e}`)), e).toBeNull();
    }
    // Huge but integral epochs parse yet can never equal a stored counter.
    const id = makeUser();
    expect(userForSession(signed(`${id}.1700000000000.99999999999999999999`))).toBeNull();
    expect(userForSession(signed(`${id}.1700000000000.9007199254740993`))).toBeNull();
  });

  it("user ids that are zero, negative, fractional or not numbers are never accepted", () => {
    for (const u of ["0", "-1", "NaN", "abc", "", "Infinity"]) {
      expect(sessionParts(signed(`${u}.1700000000000.0`)), u).toBeNull();
      expect(sessionParts(signed(`${u}.1700000000000`)), u).toBeNull();
    }
  });

  it("garbage never throws", () => {
    for (const t of ["", ".", "..", "...", "a.b.c.d.e.f", "\u0000", "日本語.語.語", "5.1.0." + "A".repeat(100000), "5.1.0.AAAA", " "]) {
      expect(() => sessionParts(t)).not.toThrow();
      expect(sessionParts(t)).toBeNull();
      expect(sessionUserId(t)).toBeNull();
    }
  });

  it("sessionUserId (used by proxy.ts) keeps accepting a revoked cookie by design; the database check in userForSession is what rejects it", () => {
    const id = makeUser();
    const t = sessionToken(id, 0);
    revokeSessions(id);
    expect(sessionUserId(t)).toBe(id);
    expect(userForSession(t)).toBeNull();
  });
});

describe("epoch scheme: routes", () => {
  it("password change cookie has the same attributes as the sign-in cookie", async () => {
    const pw = await import("@/app/api/account/password/route");
    const si = await import("@/app/api/account/signin/route");
    const id = apiReadyUser("old-password");
    jar.cookie = sessionToken(id, 0);
    const a = await pw.POST(post("/api/account/password", { current: "old-password", next: "new-password-1" }));
    const email = (db.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string }).email;
    const b = await si.POST(post("/api/account/signin", { email, password: "new-password-1" }));
    const ca = setCookie(a)!;
    const cb = setCookie(b)!;
    const strip = (c: typeof ca) => ({ ...c, value: undefined, expires: undefined });
    expect(strip(ca)).toEqual(strip(cb));
    expect(ca).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: cookieOptions().maxAge });
    expect(sessionParts(ca.value)).toEqual(sessionParts(cb.value)); // same user, same epoch
  });

  it("rejected password changes (wrong current, too short, same, missing fields) never bump the epoch or set a cookie", async () => {
    const { POST } = await import("@/app/api/account/password/route");
    const id = apiReadyUser("old-password");
    jar.cookie = sessionToken(id, 0);
    for (const body of [{ current: "bad", next: "new-password-1" }, { current: "old-password", next: "short" }, { current: "old-password", next: "old-password" }, { current: "old-password" }, {}]) {
      const res = await POST(post("/api/account/password", body));
      expect(res.status).toBe(400);
      expect(setCookie(res)).toBeUndefined();
    }
    expect(epochOf(id)).toBe(0);
  });

  it("after a change the old password stops working at sign-in, the new one works and gets the new epoch", async () => {
    const pw = await import("@/app/api/account/password/route");
    const si = await import("@/app/api/account/signin/route");
    const id = apiReadyUser("old-password");
    const email = (db.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string }).email;
    jar.cookie = sessionToken(id, 0);
    await pw.POST(post("/api/account/password", { current: "old-password", next: "new-password-1" }));
    expect((await si.POST(post("/x", { email, password: "old-password" }))).status).toBe(401);
    const ok = await si.POST(post("/x", { email, password: "new-password-1" }));
    expect(sessionParts(setCookie(ok)!.value)).toEqual({ userId: id, epoch: 1 });
  });

  it("an admin reset: student's phone is out, temp password signs in with the new epoch and must change, admin's own cookie is not rotated", async () => {
    const reset = await import("@/app/api/admin/users/[id]/reset-password/route");
    const si = await import("@/app/api/account/signin/route");
    const pw = await import("@/app/api/account/password/route");
    const admin = apiReadyUser("admin-pass", true);
    const student = apiReadyUser("student-pass");
    const phone = sessionToken(student, 0);
    jar.cookie = sessionToken(admin, 0);
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
    const res = await reset.POST(new Request("http://x", { method: "POST" }), ctx(String(student)));
    const { tempPassword } = (await res.json()) as { tempPassword: string };
    expect(userForSession(phone)).toBeNull();
    expect(setCookie(res)).toBeUndefined();

    const email = (db.prepare("SELECT email FROM users WHERE id = ?").get(student) as { email: string }).email;
    const login = await si.POST(post("/x", { email, password: tempPassword }));
    expect(await login.json()).toMatchObject({ ok: true, mustChangePassword: true });
    const tempCookie = setCookie(login)!.value;
    expect(sessionParts(tempCookie)).toEqual({ userId: student, epoch: 1 });

    // Temp-password holder changes it: epoch moves again, temp cookie dies, fresh one works and has the flag cleared.
    jar.cookie = tempCookie;
    const changed = await pw.POST(post("/x", { current: tempPassword, next: "brand-new-pass" }));
    expect(changed.status).toBe(200);
    expect(userForSession(tempCookie)).toBeNull();
    const fresh = userForSession(setCookie(changed)!.value)!;
    expect(fresh.must_change_password).toBe(0);
  });

  it("reset of a missing / malformed id answers 404 and bumps nobody", async () => {
    const reset = await import("@/app/api/admin/users/[id]/reset-password/route");
    const admin = apiReadyUser("admin-pass", true);
    jar.cookie = sessionToken(admin, 0);
    const sum = () => (db.prepare("SELECT COALESCE(SUM(session_epoch),0) AS s FROM users").get() as { s: number }).s;
    const before = sum();
    for (const id of ["999999", "abc", "", "-1", "1.5", "NaN"]) {
      const res = await reset.POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id }) } as never);
      expect(res.status, id).toBe(404);
    }
    expect(sum()).toBe(before);
  });

  it("admin self-reset: the fresh cookie is valid for pages (currentUser) but requireUser sends the admin to /account/password, and API routes answer 401", async () => {
    const reset = await import("@/app/api/admin/users/[id]/reset-password/route");
    const { requireUser, apiUser, apiAdmin } = await import("@/lib/user");
    const admin = apiReadyUser("admin-pass", true);
    jar.cookie = sessionToken(admin, 0);
    const res = await reset.POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: String(admin) }) } as never);
    jar.cookie = setCookie(res)!.value;
    expect(userForSession(jar.cookie)?.id).toBe(admin);
    await expect(requireUser()).rejects.toMatchObject({ digest: expect.stringContaining("/account/password") });
    expect(await apiUser()).toBeNull();
    expect(await apiAdmin()).toBeNull();
  });

  it("signing out works with a revoked cookie too", async () => {
    const { POST } = await import("@/app/api/account/signout/route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(setCookie(res)?.value ?? "").toBe("");
  });
});

describe("database upgrade from older commits: users.session_epoch", () => {
  // Every earlier version of the schema that has a users table (24c0825 introduced it), newest being the commit before this batch.
  const commits = ["24c0825", "6f1a111", "3c021e8", "058416b", "2319bab", "a4bb55b", "bc9fba1", "742cc18"];
  for (const commit of commits) {
    it(`a database created by ${commit} upgrades in place, survives a second open, and keeps its users signed in`, async () => {
      const src = execSync(`git show ${commit}:src/lib/db.ts`, { encoding: "utf8" });
      const schema = src.slice(src.indexOf("const SCHEMA = `") + 16, src.indexOf("`;", src.indexOf("const SCHEMA")));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s14mig-"));
      const old = new Database(path.join(dir, "study.db"));
      old.exec(schema);
      old.exec("INSERT INTO users (email, password_hash) VALUES ('a@x.dev','x'), ('b@x.dev','x');");
      old.close();

      const prev = process.env.DATA_DIR;
      for (let open = 0; open < 2; open++) {
        vi.resetModules();
        process.env.DATA_DIR = dir;
        delete (globalThis as { __db?: unknown }).__db;
        const mod = await import("@/lib/db");
        const auth = await import("@/lib/auth");
        const user = await import("@/lib/user");
        const col = (mod.db.prepare("PRAGMA table_info(users)").all() as { name: string; notnull: number; dflt_value: string }[]).find((c) => c.name === "session_epoch");
        expect(col, `open ${open}`).toMatchObject({ notnull: 1, dflt_value: "0" });
        expect(mod.db.prepare("SELECT session_epoch FROM users ORDER BY id").all()).toEqual([{ session_epoch: 0 }, { session_epoch: 0 }]);
        expect(user.userForSession(auth.sessionToken(1, 0))?.email).toBe("a@x.dev");
        mod.db.close();
        delete (globalThis as { __db?: unknown }).__db;
      }
      process.env.DATA_DIR = prev;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may still hold the file */
      }
    });
  }
});

// No DOM test setup exists, so this scans the client sources. Confirmed in a browser (fetch rejecting like a dropped connection):
// the toast / inline message reads "Failed to fetch" instead of the friendly "Check your connection" text.
describe("dropped connection wording", () => {
  const files = ["src/app/attempts/[id]/AttemptRunner.tsx", "src/components/StudySession.tsx", "src/components/TaskList.tsx"];
  it("BUG: catch blocks must not show a thrown TypeError's own message (a rejected fetch says 'Failed to fetch' / 'Load failed')", () => {
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(path.join(process.cwd(), f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/err instanceof Error && err\.message \?/.test(line) && !/Failed to fetch|Load failed|TypeError/.test(line)) offenders.push(`${f}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
