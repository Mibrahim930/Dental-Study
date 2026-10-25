// Release 3, Job F: "report a problem or idea" — stored on the site with screenshots, listed for the admin only.
import fs from "fs";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { createReport, listReports, markReportSeen, reportImagePath, unseenReportCount } from "@/lib/reports";
import { makeUser } from "./helpers";

const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }),
}));

function apiReadyUser(admin = false) {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc', is_admin = ? WHERE id = ?").run(admin ? 1 : 0, id);
  return id;
}
const signIn = (id: number) => (jar.cookie = sessionToken(id, 0));

// A real 1x1 PNG (MuPDF has to decode it).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function form(fields: Record<string, string>, files: { name: string; type: string; bytes: Buffer }[] = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files", new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
  return new Request("http://x/api/reports", { method: "POST", body: fd });
}

describe("lib/reports", () => {
  it("stores a report with its screenshots and lists it newest first", () => {
    const u = apiReadyUser();
    const a = createReport({ userId: u, kind: "problem", message: "The quiz froze", page: "/exams/3/study", meta: { viewport: "375x812", theme: "blocks" }, images: [new Uint8Array([1, 2, 3])] });
    const b = createReport({ userId: u, kind: "idea", message: "Dark mode toggle", page: null, meta: {}, images: [] });
    const rows = listReports().filter((r) => r.user_id === u);
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows[1]).toMatchObject({ kind: "problem", message: "The quiz froze", page: "/exams/3/study", images: 1, seen_at: null });
    expect(rows[1].meta).toEqual({ viewport: "375x812", theme: "blocks" });
    const file = reportImagePath(a, 1);
    expect(file && fs.existsSync(file)).toBe(true);
    expect(reportImagePath(a, 2)).toBeNull();
    expect(reportImagePath(99999, 1)).toBeNull();
    expect(reportImagePath(Number.NaN, 1)).toBeNull();
  });

  it("mark seen is idempotent and the unseen count follows", () => {
    const before = unseenReportCount();
    const id = createReport({ userId: apiReadyUser(), kind: "idea", message: "x", page: null, meta: {}, images: [] });
    expect(unseenReportCount()).toBe(before + 1);
    expect(markReportSeen(id)).toBe(true);
    expect(markReportSeen(id)).toBe(false);
    expect(unseenReportCount()).toBe(before);
  });

  it("a corrupt meta_json reads as empty meta instead of throwing", () => {
    const id = createReport({ userId: apiReadyUser(), kind: "idea", message: "x", page: null, meta: {}, images: [] });
    db.prepare("UPDATE reports SET meta_json = '{nope' WHERE id = ?").run(id);
    expect(listReports().find((r) => r.id === id)?.meta).toEqual({});
  });
});

describe("POST /api/reports", () => {
  it("saves text, page, meta and a re-encoded screenshot", async () => {
    const { POST } = await import("@/app/api/reports/route");
    const u = apiReadyUser();
    signIn(u);
    const res = await POST(
      form({ kind: "idea", message: "  Let me pick the quiz length  ", page: "/exams/1", meta: JSON.stringify({ viewport: "390x844", theme: "slate", userAgent: "UA" }) }, [
        { name: "shot.png", type: "image/png", bytes: PNG },
      ]),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    const row = listReports().find((r) => r.id === id)!;
    expect(row).toMatchObject({ user_id: u, kind: "idea", message: "Let me pick the quiz length", page: "/exams/1", images: 1 });
    expect(row.meta).toEqual({ viewport: "390x844", theme: "slate", userAgent: "UA" });
    const file = reportImagePath(id, 1)!;
    const bytes = fs.readFileSync(file);
    expect(bytes[0]).toBe(0xff); // JPEG, whatever came in
    expect(bytes[1]).toBe(0xd8);
  });

  it("rejects an empty message, an unknown kind falls back to problem, a non-site page is dropped", async () => {
    const { POST } = await import("@/app/api/reports/route");
    signIn(apiReadyUser());
    expect((await POST(form({ message: "   " }))).status).toBe(400);
    const res = await POST(form({ kind: "rant", message: "hi", page: "https://evil.example/x" }));
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    expect(listReports().find((r) => r.id === id)).toMatchObject({ kind: "problem", page: null });
  });

  it("rejects too many files, non-images and oversized claims; needs a signed-in user", async () => {
    const { POST } = await import("@/app/api/reports/route");
    signIn(apiReadyUser());
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}.png`, type: "image/png", bytes: PNG }));
    expect((await POST(form({ message: "x" }, six))).status).toBe(400);
    expect((await POST(form({ message: "x" }, [{ name: "notes.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4 nope") }]))).status).toBe(400);
    expect((await POST(form({ message: "x" }, [{ name: "a.txt", type: "text/plain", bytes: Buffer.from("hello") }]))).status).toBe(400);
    const big = new Request("http://x/api/reports", { method: "POST", headers: { "content-length": String(200 * 1024 * 1024) } });
    expect((await POST(big)).status).toBe(413);
    jar.cookie = undefined;
    expect((await POST(form({ message: "x" }))).status).toBe(401);
  });

  it("a very long message is refused", async () => {
    const { POST } = await import("@/app/api/reports/route");
    signIn(apiReadyUser());
    expect((await POST(form({ message: "a".repeat(4001) }))).status).toBe(400);
    expect((await POST(form({ message: "a".repeat(4000) }))).status).toBe(200);
  });
});

describe("admin report routes", () => {
  type ImgRoute = typeof import("@/app/api/admin/reports/[id]/image/[n]/route");
  type SeenRoute = typeof import("@/app/api/admin/reports/[id]/seen/route");

  it("screenshots and mark-seen are admin only; a student gets 401, a missing report 404", async () => {
    const img = await import("@/app/api/admin/reports/[id]/image/[n]/route");
    const seen = await import("@/app/api/admin/reports/[id]/seen/route");
    const student = apiReadyUser();
    const admin = apiReadyUser(true);
    const id = createReport({ userId: student, kind: "problem", message: "x", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff, 0x00])] });
    const imgCtx = (rid: number, n: number) => ({ params: Promise.resolve({ id: String(rid), n: String(n) }) }) as unknown as Parameters<ImgRoute["GET"]>[1];
    const seenCtx = (rid: number) => ({ params: Promise.resolve({ id: String(rid) }) }) as unknown as Parameters<SeenRoute["POST"]>[1];

    signIn(student);
    expect((await img.GET(new Request("http://x"), imgCtx(id, 1))).status).toBe(401);
    expect((await seen.POST(new Request("http://x", { method: "POST" }), seenCtx(id))).status).toBe(401);

    signIn(admin);
    const ok = await img.GET(new Request("http://x"), imgCtx(id, 1));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect((await img.GET(new Request("http://x"), imgCtx(id, 2))).status).toBe(404);
    expect((await img.GET(new Request("http://x"), imgCtx(id, Number.NaN))).status).toBe(404);
    expect((await seen.POST(new Request("http://x", { method: "POST" }), seenCtx(id))).status).toBe(200);
    expect((await seen.POST(new Request("http://x", { method: "POST" }), seenCtx(id))).status).toBe(404); // already seen
    expect((await seen.POST(new Request("http://x", { method: "POST" }), seenCtx(424242))).status).toBe(404);
  });
});
