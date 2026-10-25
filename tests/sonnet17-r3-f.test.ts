// Sonnet QA 17 — Release 3 Job F attack tests: the report button's API ("Tell the site owner") and "Quiz me on this".
// Tests named "BUG: ..." fail on purpose until the bug is fixed.
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type GenOpts = { purpose: string; tier?: string; content: string; system: string };
type Q = {
  question: string;
  options: string[];
  correct_index: number;
  correct_answer?: string;
  explanation: string;
  option_notes: string[];
  concept: string;
  source_page_id: number | null;
  image_page_id: number | null;
};
const gen = vi.hoisted(() => ({
  calls: [] as { purpose: string; tier?: string; content: string; system: string }[],
  questions: (() => []) as (opts: GenOpts) => unknown[],
  fail: null as Error | null,
  gate: null as Promise<void> | null,
}));
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: GenOpts) => {
    gen.calls.push({ purpose: opts.purpose, tier: opts.tier, content: opts.content, system: opts.system });
    if (gen.gate) await gen.gate;
    if (gen.fail) throw gen.fail;
    return { questions: gen.questions(opts) };
  }),
}));
const credState = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => {
    if (credState.fail) throw new Error("No API key on file");
    return { userId, provider: "anthropic", apiKey: "k" };
  },
}));
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});

import { sessionToken } from "@/lib/auth";
import { db, FILES_DIR } from "@/lib/db";
import { answerQuizMe, createQuizMe, getQuizMe, openQuizMe, QuizMeError, searchExamPages, type QuizMeQuestion } from "@/lib/quizMe";
import { createReport, listReports, markReportSeen, reportImagePath, unseenReportCount } from "@/lib/reports";
import { POST as createPOST } from "@/app/api/quizme/route";
import { GET as quizGET } from "@/app/api/quizme/[id]/route";
import { POST as answerPOST } from "@/app/api/quizme/[id]/answer/route";
import { GET as openGET } from "@/app/api/quizme/open/route";
import { POST as reportPOST } from "@/app/api/reports/route";
import { GET as imageGET } from "@/app/api/admin/reports/[id]/image/[n]/route";
import { POST as seenPOST } from "@/app/api/admin/reports/[id]/seen/route";
import { POST as deleteUserPOST } from "@/app/api/admin/users/[id]/delete/route";
import { makeUser } from "./helpers";

function apiReadyUser(admin = false): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc', must_change_password = 0, is_admin = ? WHERE id = ?").run(admin ? 1 : 0, id);
  return id;
}
function signIn(userId: number | null) {
  if (userId == null) return void (jar.cookie = undefined);
  const { session_epoch } = db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(userId) as { session_epoch: number };
  jar.cookie = sessionToken(userId, session_epoch);
}

// ---------------------------------------------------------------------------------------------------------------------
// Image fixtures. PNG: a real 1x1. GIF: a real 1x1. BMP and TIFF are built by hand (1x1, uncompressed, one red pixel).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
function bmp(): Buffer {
  const b = Buffer.alloc(58);
  b.write("BM", 0);
  b.writeUInt32LE(58, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(1, 18);
  b.writeInt32LE(1, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(4, 34);
  b[56] = 0xff; // red (BGR)
  return b;
}
function tiff(): Buffer {
  const b = Buffer.alloc(131);
  b.write("II", 0);
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(8, 4);
  b.writeUInt16LE(9, 8);
  const entries: [number, number, number, number][] = [
    [256, 3, 1, 1],
    [257, 3, 1, 1],
    [258, 3, 3, 122],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 128],
    [277, 3, 1, 3],
    [278, 3, 1, 1],
    [279, 4, 1, 3],
  ];
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    b.writeUInt16LE(tag, o);
    b.writeUInt16LE(type, o + 2);
    b.writeUInt32LE(count, o + 4);
    if (type === 3 && count === 1) b.writeUInt16LE(value, o + 8);
    else b.writeUInt32LE(value, o + 8);
  });
  b.writeUInt32LE(0, 10 + 9 * 12);
  b.writeUInt16LE(8, 122);
  b.writeUInt16LE(8, 124);
  b.writeUInt16LE(8, 126);
  b[128] = 0xff;
  return b;
}

type F = { name: string; type: string; bytes: Buffer | Uint8Array };
function form(fields: Record<string, string | Blob>, files: F[] = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files", new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
  return new Request("http://x/api/reports", { method: "POST", body: fd });
}
const png = (name = "s.png"): F => ({ name, type: "image/png", bytes: PNG });
const imgCtx = (id: string | number, n: string | number) => ({ params: Promise.resolve({ id: String(id), n: String(n) }) }) as never;
const idCtx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const isJpeg = (file: string) => {
  const b = fs.readFileSync(file);
  return b[0] === 0xff && b[1] === 0xd8;
};

beforeEach(() => {
  gen.calls.length = 0;
  gen.fail = null;
  gen.gate = null;
  credState.fail = false;
  signIn(null);
});

// =====================================================================================================================
describe("reports: who can read a screenshot", () => {
  it("a student, a signed-out visitor and a bad session get 401; the admin gets the JPEG; another user's report is the admin's to read", async () => {
    const student = apiReadyUser();
    const other = apiReadyUser();
    const admin = apiReadyUser(true);
    const id = createReport({ userId: student, kind: "problem", message: "x", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff, 0xe0])] });
    signIn(student);
    expect((await imageGET(new Request("http://x"), imgCtx(id, 1))).status).toBe(401); // her own report: still admin-only
    signIn(other);
    expect((await imageGET(new Request("http://x"), imgCtx(id, 1))).status).toBe(401);
    expect((await seenPOST(new Request("http://x", { method: "POST" }), idCtx(id))).status).toBe(401);
    signIn(null);
    expect((await imageGET(new Request("http://x"), imgCtx(id, 1))).status).toBe(401);
    jar.cookie = "forged.token.value";
    expect((await imageGET(new Request("http://x"), imgCtx(id, 1))).status).toBe(401);
    // Admin whose password was changed elsewhere (old epoch) is signed out.
    signIn(admin);
    const old = jar.cookie;
    db.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?").run(admin);
    jar.cookie = old;
    expect((await imageGET(new Request("http://x"), imgCtx(id, 1))).status).toBe(401);
    signIn(admin);
    const ok = await imageGET(new Request("http://x"), imgCtx(id, 1));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(ok.headers.get("cache-control")).toMatch(/private/);
  });

  it("an admin without a finished API key setup is refused (apiUser rules)", async () => {
    const admin = apiReadyUser(true);
    const id = createReport({ userId: admin, kind: "idea", message: "x", page: null, meta: {}, images: [new Uint8Array([1])] });
    db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(admin);
    signIn(admin);
    expect((await imageGET(new Request("http://x"), imgCtx(id, 1))).status).toBe(401);
  });

  it("path traversal and odd numbers in id / n never reach another file", async () => {
    const admin = apiReadyUser(true);
    const id = createReport({ userId: admin, kind: "idea", message: "x", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff, 0xe0])] });
    // A secret outside the reports folder that a traversal would love to reach.
    fs.writeFileSync(path.join(FILES_DIR, "secret.txt"), "TOP SECRET");
    signIn(admin);
    const bad: [string, string][] = [
      ["../secret.txt", "1"],
      ["..%2Fsecret.txt", "1"],
      [`${id}/../../secret.txt`, "1"],
      [String(id), "../1"],
      [String(id), "..\\..\\secret.txt"],
      [String(id), "1/../../../secret.txt"],
      [String(id), "-1"],
      [String(id), "0"],
      [String(id), "2"],
      [String(id), "99999999999999999999"],
      [String(id), "1.5"],
      [String(id), "NaN"],
      [String(id), "Infinity"],
      [String(id), "abc"],
      ["-1", "1"],
      ["0", "1"],
      ["99999999999999999999", "1"],
      ["", ""],
    ];
    for (const [i, n] of bad) {
      const res = await imageGET(new Request("http://x"), imgCtx(i, n));
      expect([404], `id=${i} n=${n}`).toContain(res.status);
      expect(await res.text()).not.toContain("TOP SECRET");
    }
    // Numeric spellings of 1 resolve to the same image (harmless: still the admin's own id/n).
    for (const n of ["1", "01", "1e0", "+1", " 1"]) expect((await imageGET(new Request("http://x"), imgCtx(id, n))).status, `n=${n}`).toBe(200);
  });

  it("a report that exists but has no n-th image, or whose file is gone, is a 404 (not a 500)", async () => {
    const admin = apiReadyUser(true);
    const none = createReport({ userId: admin, kind: "idea", message: "no pics", page: null, meta: {}, images: [] });
    const one = createReport({ userId: admin, kind: "idea", message: "pic", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff, 0xe0])] });
    signIn(admin);
    expect((await imageGET(new Request("http://x"), imgCtx(none, 1))).status).toBe(404);
    expect((await imageGET(new Request("http://x"), imgCtx(one, 2))).status).toBe(404);
    fs.rmSync(reportImagePath(one, 1)!);
    expect((await imageGET(new Request("http://x"), imgCtx(one, 1))).status).toBe(404);
    // The admin page's list still renders for a report whose image row is dangling.
    expect(listReports().find((r) => r.id === one)?.images).toBe(1);
  });

  it("mark-seen: non-numeric ids are 404, repeated marking is a 404 the second time but the stored time never changes", async () => {
    const admin = apiReadyUser(true);
    const id = createReport({ userId: admin, kind: "idea", message: "x", page: null, meta: {}, images: [] });
    signIn(admin);
    for (const bad of ["abc", "1.5", "-5", "", "NaN", "../1"]) expect((await seenPOST(new Request("http://x", { method: "POST" }), idCtx(bad))).status, bad).toBe(404);
    const before = unseenReportCount();
    expect((await seenPOST(new Request("http://x", { method: "POST" }), idCtx(id))).status).toBe(200);
    const t1 = (db.prepare("SELECT seen_at FROM reports WHERE id = ?").get(id) as { seen_at: string }).seen_at;
    expect((await seenPOST(new Request("http://x", { method: "POST" }), idCtx(id))).status).toBe(404);
    expect((db.prepare("SELECT seen_at FROM reports WHERE id = ?").get(id) as { seen_at: string }).seen_at).toBe(t1);
    expect(unseenReportCount()).toBe(before - 1);
    expect(markReportSeen(id)).toBe(false);
  });
});

// =====================================================================================================================
describe("reports: what a student can send", () => {
  it("six files are refused; five are kept in order as 1.jpg..5.jpg under FILES_DIR/reports/<id>/ only", async () => {
    signIn(apiReadyUser());
    const six = Array.from({ length: 6 }, (_, i) => png(`s${i}.png`));
    const before = listReports().length;
    expect((await reportPOST(form({ message: "x" }, six))).status).toBe(400);
    expect(listReports().length).toBe(before);
    const res = await reportPOST(form({ message: "five" }, six.slice(0, 5)));
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    expect(listReports().find((r) => r.id === id)?.images).toBe(5);
    const dir = path.join(FILES_DIR, "reports", String(id));
    expect(fs.readdirSync(dir).sort()).toEqual(["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg"]);
    for (const n of [1, 2, 3, 4, 5]) {
      const file = reportImagePath(id, n)!;
      expect(path.dirname(file)).toBe(dir);
      expect(isJpeg(file)).toBe(true);
    }
    // The client's file names never reach the disk.
    const weird = await reportPOST(form({ message: "name" }, [{ name: "../../evil.png", type: "image/png", bytes: PNG }]));
    expect(weird.status).toBe(200);
    const wid = ((await weird.json()) as { id: number }).id;
    expect(fs.readdirSync(path.join(FILES_DIR, "reports", String(wid)))).toEqual(["1.jpg"]);
    expect(fs.existsSync(path.join(FILES_DIR, "evil.png"))).toBe(false);
  });

  it("a 0-byte file is skipped (no image row) rather than failing the whole report", async () => {
    signIn(apiReadyUser());
    const res = await reportPOST(form({ message: "empty attachment" }, [{ name: "empty.png", type: "image/png", bytes: Buffer.alloc(0) }]));
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    expect(listReports().find((r) => r.id === id)?.images).toBe(0);
  });

  it("sniffFile decides: a PDF or text file renamed .png is refused, HEIC and WebP get their own plain messages", async () => {
    signIn(apiReadyUser());
    const pdf = await reportPOST(form({ message: "refuse-me" }, [{ name: "shot.png", type: "image/png", bytes: Buffer.from("%PDF-1.7\n1 0 obj") }]));
    expect(pdf.status).toBe(400);
    expect(((await pdf.json()) as { error: string }).error).toMatch(/isn't a picture/);
    const txt = await reportPOST(form({ message: "refuse-me" }, [{ name: "shot.png", type: "image/png", bytes: Buffer.from("just some text, not an image") }]));
    expect(txt.status).toBe(400);
    const zip = await reportPOST(form({ message: "refuse-me" }, [{ name: "shot.jpg", type: "image/jpeg", bytes: Buffer.from("PK\x03\x04 pretend zip") }]));
    expect(zip.status).toBe(400);
    const html = await reportPOST(form({ message: "refuse-me" }, [{ name: "a.png", type: "image/png", bytes: Buffer.from("<script>alert(1)</script>") }]));
    expect(html.status).toBe(400);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
    const h = await reportPOST(form({ message: "refuse-me" }, [{ name: "IMG_1.HEIC", type: "image/heic", bytes: heic }]));
    expect(h.status).toBe(400);
    expect(((await h.json()) as { error: string }).error).toMatch(/HEIC/);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
    const w = await reportPOST(form({ message: "refuse-me" }, [{ name: "a.webp", type: "image/webp", bytes: webp }]));
    expect(w.status).toBe(400);
    expect(((await w.json()) as { error: string }).error).toMatch(/WebP/);
    // A real PNG whose declared type lies (text/plain) is still accepted: the bytes decide.
    expect((await reportPOST(form({ message: "lying type" }, [{ name: "a.txt", type: "text/plain", bytes: PNG }]))).status).toBe(200);
    // Nothing was stored by the refused ones: only the one accepted report exists for this message set.
    expect(listReports().filter((r) => r.message === "refuse-me")).toHaveLength(0);
  });

  it("a PNG header followed by garbage is a plain 400, not a 500", async () => {
    signIn(apiReadyUser());
    const broken = Buffer.concat([PNG.subarray(0, 40), Buffer.from("garbage")]);
    const res = await reportPOST(form({ message: "x" }, [{ name: "broken.png", type: "image/png", bytes: broken }]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/couldn't be read/);
    const truncated = await reportPOST(form({ message: "x" }, [{ name: "t.png", type: "image/png", bytes: PNG.subarray(0, 8) }]));
    expect(truncated.status).toBe(400);
  });

  it("GIF, BMP and TIFF are accepted and stored as JPEG", async () => {
    signIn(apiReadyUser());
    for (const [name, type, bytes] of [
      ["a.gif", "image/gif", GIF],
      ["a.bmp", "image/bmp", bmp()],
      ["a.tif", "image/tiff", tiff()],
    ] as [string, string, Buffer][]) {
      const res = await reportPOST(form({ message: `format ${name}` }, [{ name, type, bytes }]));
      const body = (await res.json()) as { id?: number; error?: string };
      expect(res.status, `${name}: ${body.error}`).toBe(200);
      expect(isJpeg(reportImagePath(body.id!, 1)!)).toBe(true);
    }
  });

  it("an oversize content-length is a 413 before reading; a file over 8 MB is a 413; exactly 8 MB of a real PNG is fine", async () => {
    signIn(apiReadyUser());
    const huge = new Request("http://x/api/reports", { method: "POST", headers: { "content-length": String(41 * 1024 * 1024 + 1) } });
    expect((await reportPOST(huge)).status).toBe(413);
    const edge = new Request("http://x/api/reports", { method: "POST", headers: { "content-length": String(41 * 1024 * 1024) } });
    expect((await reportPOST(edge)).status).toBe(400); // allowed through, then no readable body
    const big = await reportPOST(form({ message: "x" }, [{ name: "big.png", type: "image/png", bytes: Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]) }]));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/over 8 MB/);
    // Garbage content-length values don't throw.
    const nan = new Request("http://x/api/reports", { method: "POST", headers: { "content-length": "abc" }, body: new FormData() });
    expect([400, 413]).toContain((await reportPOST(nan)).status);
  });

  it("a body that is not multipart is a plain 400", async () => {
    signIn(apiReadyUser());
    const res = await reportPOST(new Request("http://x/api/reports", { method: "POST", body: JSON.stringify({ message: "hi" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/didn't arrive/);
  });

  it("message: trimmed, 4000 characters kept, 4001 refused, empty or file-valued refused; kind falls back to problem", async () => {
    const u = apiReadyUser();
    signIn(u);
    const ok = await reportPOST(form({ message: `\n\t  ${"a".repeat(4000)}  \n`, kind: "idea" }));
    expect(ok.status).toBe(200);
    const id = ((await ok.json()) as { id: number }).id;
    expect(listReports().find((r) => r.id === id)).toMatchObject({ message: "a".repeat(4000), kind: "idea" });
    expect((await reportPOST(form({ message: "a".repeat(4001) }))).status).toBe(400);
    expect((await reportPOST(form({ message: "" }))).status).toBe(400);
    expect([200, 400]).toContain((await reportPOST(form({ message: "\u00a0\u200b \n" }))).status); // must not 500
    expect((await reportPOST(form({}))).status).toBe(400);
    const asFile = new FormData();
    asFile.append("message", new File(["hello"], "m.txt"));
    expect((await reportPOST(new Request("http://x/api/reports", { method: "POST", body: asFile }))).status).toBe(400);
    for (const [kind, want] of [
      ["problem", "problem"],
      ["idea", "idea"],
      ["IDEA", "problem"],
      ["", "problem"],
      ["idea ", "problem"],
      ["'; DROP TABLE reports;--", "problem"],
    ] as const) {
      const r = await reportPOST(form({ message: `kind ${kind}`, kind }));
      const rid = ((await r.json()) as { id: number }).id;
      expect(listReports().find((x) => x.id === rid)?.kind, `kind=${JSON.stringify(kind)}`).toBe(want);
    }
    expect(db.prepare("SELECT COUNT(*) n FROM reports").get()).toBeTruthy(); // table still there
  });

  it("page must start with '/', is cut to 500 characters; meta is truncated, ignores wrong types and non-JSON", async () => {
    signIn(apiReadyUser());
    const idOf = async (fields: Record<string, string>) => ((await (await reportPOST(form({ message: "m", ...fields }))).json()) as { id: number }).id;
    const get = (id: number) => listReports().find((r) => r.id === id)!;
    expect(get(await idOf({ page: "/exams/4/study?x=1" })).page).toBe("/exams/4/study?x=1");
    expect(get(await idOf({ page: "exams/4" })).page).toBeNull();
    expect(get(await idOf({ page: "javascript:alert(1)" })).page).toBeNull();
    expect(get(await idOf({ page: "https://evil.example/" })).page).toBeNull();
    expect(get(await idOf({ page: "" })).page).toBeNull();
    expect(get(await idOf({ page: "/" + "p".repeat(900) })).page).toHaveLength(500);
    const m = get(await idOf({ meta: JSON.stringify({ viewport: "v".repeat(100), theme: "t".repeat(100), userAgent: "u".repeat(900), extra: "<script>" }) }));
    expect(m.meta.viewport).toHaveLength(40);
    expect(m.meta.theme).toHaveLength(40);
    expect(m.meta.userAgent).toHaveLength(400);
    expect(Object.keys(m.meta).sort()).toEqual(["theme", "userAgent", "viewport"].sort());
    for (const meta of ["not json", "null", "[]", "5", '"str"', "{", JSON.stringify({ viewport: { a: 1 }, theme: 5, userAgent: ["x"] })]) {
      const r = get(await idOf({ meta }));
      expect(r.meta.viewport ?? "").not.toBeInstanceOf(Object);
      expect(typeof (r.meta.viewport ?? "")).toBe("string");
      expect(typeof (r.meta.theme ?? "")).toBe("string");
      expect(typeof (r.meta.userAgent ?? "")).toBe("string");
    }
  });

  it("BUG: a page value like //evil.example/x (protocol-relative) is stored, and the admin page renders it as a clickable link", async () => {
    signIn(apiReadyUser());
    for (const page of ["//evil.example/phish", "/\\evil.example/phish", "/\t/evil.example"]) {
      const res = await reportPOST(form({ message: "link", page }));
      const id = ((await res.json()) as { id: number }).id;
      const stored = listReports().find((r) => r.id === id)!.page;
      // src/app/admin/page.tsx renders <a href={r.page}>: "//host" navigates to another site when the owner clicks it.
      expect(stored === null || !/^\/[\\/\t\r\n]/.test(stored), `stored page ${JSON.stringify(stored)}`).toBe(true);
    }
  });

  it("listReports is newest first, the unseen count follows, and the Admin list is capped at 100 (older unseen ones can't be reached)", () => {
    const u = apiReadyUser();
    const ids = Array.from({ length: 105 }, (_, i) => createReport({ userId: u, kind: "idea", message: `r${i}`, page: null, meta: {}, images: [] }));
    const rows = listReports();
    expect(rows.length).toBe(100);
    expect(rows[0].id).toBe(ids[104]);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => b - a));
    const unseenAll = unseenReportCount();
    expect(unseenAll).toBeGreaterThanOrEqual(105);
    expect(rows.filter((r) => !r.seen_at).length).toBe(100); // the chip says "N new" but only 100 are listed; there is no paging
  });

  it("deleting a user cascades their reports and report_images rows (foreign keys are on)", () => {
    const u = apiReadyUser();
    const id = createReport({ userId: u, kind: "problem", message: "bye", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff, 1])] });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.prepare("DELETE FROM users WHERE id = ?").run(u);
    expect(db.prepare("SELECT COUNT(*) n FROM reports WHERE id = ?").get(id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM report_images WHERE report_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("BUG: removing a user from the Admin page leaves their report screenshots on disk (FILES_DIR/reports/<id>/)", async () => {
    const admin = apiReadyUser(true);
    const u = apiReadyUser();
    const id = createReport({ userId: u, kind: "problem", message: "private screenshot", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff, 1])] });
    const dir = path.join(FILES_DIR, "reports", String(id));
    expect(fs.existsSync(dir)).toBe(true);
    signIn(admin);
    const res = await deleteUserPOST(new Request("http://x", { method: "POST" }), idCtx(u));
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM reports WHERE id = ?").get(id)).toEqual({ n: 0 });
    // "Permanently removes an account and everything it owns (… files)" — the screenshots may show private things.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a failed image write rolls the report row back (no half-saved report)", () => {
    const u = apiReadyUser();
    const before = (db.prepare("SELECT COUNT(*) n FROM reports").get() as { n: number }).n;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => createReport({ userId: u, kind: "idea", message: "x", page: null, meta: {}, images: [new Uint8Array([1])] })).toThrow(/disk full/);
    } finally {
      spy.mockRestore();
    }
    expect((db.prepare("SELECT COUNT(*) n FROM reports").get() as { n: number }).n).toBe(before);
  });
});

// =====================================================================================================================
// Quiz me
const notes = (i: number, image = false) =>
  JSON.stringify({
    title: `slide ${i}`,
    summary: "s",
    image_description: image ? "a periapical radiograph" : null,
    key_facts: ["a", "b"],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: [],
    is_filler: false,
  });
function addPage(docId: number, n: number, fts: string | null, image = false): number {
  const id = Number(
    db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(docId, n, notes(n, image)).lastInsertRowid,
  );
  if (fts) db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)").run(id, `slide ${n}`, fts);
  return id;
}
/** An exam with a topic of 3 slides that ALSO mention the searched words (so search hits overlap the section), 8 more hits, one picture slide. */
function world(userId = apiReadyUser()) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'Endo')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const topicPages = [1, 2, 3].map((n) => addPage(doc, n, `sodium hypochlorite irrigation protocol ${n}`));
  const hits = Array.from({ length: 8 }, (_, i) => addPage(doc, 10 + i, `sodium hypochlorite irrigant concentration ${i}`));
  const pic = addPage(doc, 40, "radiograph of the file in the canal", true);
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'Irrigation', 's', ?)").run(examId, JSON.stringify([...topicPages, pic])).lastInsertRowid);
  return { userId, examId, topicId, topicPages, hits, pic, doc };
}
const TEXT = "Sodium hypochlorite is the main irrigant used in root canal treatment.";
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const get = (url = "http://x/api") => new Request(url);
function q(n: number, o: Partial<Q> = {}): Q {
  const options = [`right ${n}`, `wrong ${n}a`, `wrong ${n}b`, `wrong ${n}c`];
  return {
    question: `Question number ${n} about hypochlorite?`,
    options,
    correct_index: 0,
    correct_answer: options[0],
    explanation: `because ${n}`,
    option_notes: options.map((x) => `note for ${x}`),
    concept: "Irrigants",
    source_page_id: null,
    image_page_id: null,
    ...o,
  };
}
const nQ = (opts: GenOpts) => Number(/Write exactly (\d+) questions/.exec(opts.content)?.[1] ?? 3);
const standard = () => (gen.questions = (opts) => Array.from({ length: nQ(opts) }, (_, i) => q(i + 1)));
const stored = (id: number) => JSON.parse((db.prepare("SELECT questions_json FROM quizme WHERE id = ?").get(id) as { questions_json: string }).questions_json) as QuizMeQuestion[];
const concept = (userId: number, name = "Irrigants") => db.prepare("SELECT attempts, correct FROM concepts WHERE user_id = ? AND name = ?").get(userId, name) as { attempts: number; correct: number } | undefined;
const count = () => (db.prepare("SELECT COUNT(*) n FROM quizme").get() as { n: number }).n;

describe("quiz me: input and slide choice", () => {
  beforeEach(() => void standard());

  it("text length is judged after collapsing whitespace: 19 refused, 20 and 2000 accepted, 2001 refused, a padded 5 KB blank refused", async () => {
    const w = world();
    const t = (s: string) => createQuizMe({ userId: w.userId, examId: w.examId, text: s, size: 3 });
    await expect(t("a".repeat(19))).rejects.toBeInstanceOf(QuizMeError);
    await expect(t("a".repeat(2001))).rejects.toBeInstanceOf(QuizMeError);
    await expect(t(" ".repeat(5000) + "short")).rejects.toBeInstanceOf(QuizMeError);
    await expect(t("a  b\n\n\t".repeat(10) + "x")).resolves.toBeTruthy(); // collapses to <= 2000
    await expect(t("a".repeat(20))).resolves.toBeTruthy();
    await expect(t("a".repeat(2000))).resolves.toBeTruthy();
  });

  it("the request body is checked with plain 400 messages (bad JSON, wrong types, floats, negative ids)", async () => {
    const w = world();
    const countBefore = count();
    signIn(w.userId);
    const raw = (body: string) => new Request("http://x/api", { method: "POST", body });
    expect((await createPOST(raw("{nope"))).status).toBe(400);
    expect((await createPOST(raw("null"))).status).toBe(400);
    expect((await createPOST(raw("[]"))).status).toBe(400);
    for (const b of [
      { examId: String(w.examId), text: TEXT, size: 3 },
      { examId: w.examId + 0.5, text: TEXT, size: 3 },
      { examId: w.examId, text: ["a"], size: 3 },
      { examId: w.examId, text: TEXT, size: "3" },
      { examId: w.examId, text: TEXT, size: 3, topicId: "x" },
      { examId: w.examId, text: TEXT, size: 3, topicId: 1.5 },
      { examId: w.examId, text: TEXT, size: 3, topicId: -1 },
      { examId: w.examId, text: TEXT, size: 3, topicId: 0 },
      { examId: w.examId, text: TEXT, size: 3, topicId: 99999999 },
      { examId: w.examId, text: TEXT, size: Number.MAX_SAFE_INTEGER },
    ]) {
      const res = await createPOST(post(b));
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
    // An exam that isn't hers, or doesn't exist: 404, nothing written, AI never called.
    const other = world();
    expect((await createPOST(post({ examId: other.examId, text: TEXT, size: 3 }))).status).toBe(404);
    expect((await createPOST(post({ examId: 987654, text: TEXT, size: 3 }))).status).toBe(404);
    expect((await createPOST(post({ examId: other.examId, text: TEXT, size: 3, topicId: other.topicId }))).status).toBe(404);
    expect(gen.calls).toHaveLength(0);
    expect(count()).toBe(countBefore);
  });

  it("the slides sent are the section's plus up to 6 hits, with no slide listed twice even when a hit is also in the section", async () => {
    const w = world();
    await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 3 });
    const ids = [...gen.calls[0].content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of [...w.topicPages, w.pic]) expect(ids).toContain(p);
    // topic slides 1-3 are also the best FTS matches; the other hits fill the 6 slots after dedupe, never more than 4 + 6.
    expect(ids.length).toBeLessThanOrEqual(4 + 6);
    expect(ids.filter((p) => w.hits.includes(p)).length).toBeGreaterThanOrEqual(1);
  });

  it("hostile selections never break the full-text query: quotes, asterisks, hyphens, NEAR/AND/OR/NOT, SQL, unicode, only stopwords, very long", () => {
    const w = world();
    const texts = [
      `"sodium" "hypochlorite" *irrigant* -canal`,
      `sodium* hypochlorite* ^irrigant NEAR(sodium canal) AND OR NOT`,
      `x-ray, root-canal; pulp-capping: (hypochlorite) {irrigant} [canal]`,
      `'; DROP TABLE pages; -- hypochlorite" OR 1=1`,
      `col:sodium title:hypochlorite {title content}: irrigant`,
      `naïve café résumé ünïcödé hypochlorite 次亜塩素酸 هيبوكلوريت`,
      `the and for with that this what why how are was were from have has`,
      `ا ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ`,
      Array.from({ length: 400 }, (_, i) => `term${i}abc`).join(" "),
      `"`.repeat(50),
      "\u0000\u0001 hypochlorite \u0000",
      "OR OR OR",
      "NOT hypochlorite",
    ];
    for (const t of texts) {
      expect(() => searchExamPages(w.userId, w.examId, t), t.slice(0, 40)).not.toThrow();
      expect(searchExamPages(w.userId, w.examId, t).length).toBeLessThanOrEqual(6);
    }
    expect(searchExamPages(w.userId, w.examId, `"sodium" "hypochlorite" *irrigant*`).length).toBe(6);
    expect(searchExamPages(w.userId, w.examId, "NOT hypochlorite").length).toBe(6); // a word, not the operator
    expect(db.prepare("SELECT COUNT(*) n FROM pages").get()).toBeTruthy(); // DROP TABLE didn't run
  });

  it("each hostile selection also produces a quiz end-to-end (the stored text is the collapsed selection)", async () => {
    const w = world();
    for (const t of [`"quoted" *star* -dash- NEAR(a b) hypochlorite irrigant`, `café ünïcödé 次亜塩素酸 hypochlorite and the root`, `the and for with that this what why how are was were`]) {
      const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: t, size: 3 });
      expect(quiz.questions).toHaveLength(3);
      expect(quiz.text).toBe(t.replace(/\s+/g, " ").trim());
    }
  });

  it("a stopwords-only selection still works: the section's slides alone, or the 'no slides match' instruction", async () => {
    const w = world();
    await createQuizMe({ userId: w.userId, examId: w.examId, text: "the and for with that this what why how", size: 3 });
    expect(gen.calls[0].content).toContain("No slides match");
    await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: "the and for with that this what why how", size: 3 });
    expect(gen.calls[1].content).not.toContain("No slides match");
    expect(gen.calls[1].content).toContain(`[P${w.topicPages[0]}]`);
  });

  it("requests the quality tier with purpose 'quiz me'", async () => {
    const w = world();
    await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 10 });
    expect(gen.calls[0]).toMatchObject({ purpose: "quiz me", tier: "quality" });
    expect(gen.calls[0].content).toContain("Write exactly 10 questions");
  });
});

describe("quiz me: what the writer may return", () => {
  it("drops bad keys, duplicate stems, blank/duplicate options and out-of-range keys; keeps unusual-but-valid ones", async () => {
    const w = world();
    gen.questions = () => [
      q(1),
      q(2, { correct_index: 3 }), // key says option 3, text says option 0: contradiction -> dropped
      q(3, { question: "Question number 1 about hypochlorite!" }), // same stem as #1 after normalising
      q(4, { options: ["a", "A ", "b", "c"], correct_answer: "b" }), // duplicate options
      q(5, { options: ["a", "", "b", "c"], correct_answer: "a" }), // blank option
      q(6, { correct_index: 9, correct_answer: undefined }), // out of range, no text to cross-check
      q(7, { correct_index: -1, correct_answer: undefined }),
      q(8, { correct_index: 1.5, correct_answer: undefined }),
      q(9, { correct_index: Number.NaN, correct_answer: undefined }),
      q(10, { question: "   " }), // blank stem
      q(11, { options: ["only one"], correct_index: 0, correct_answer: "only one" }), // one option
      q(12),
    ];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 10 });
    expect(stored(quiz.id).map((s) => s.question)).toEqual(["Question number 1 about hypochlorite?", "Question number 12 about hypochlorite?"]);
  });

  it("questions with 2 or 6 options are kept (the section quiz uses 4): noted, not a failure", async () => {
    const w = world();
    gen.questions = () => [q(1, { options: ["yes", "no"], correct_answer: "yes", option_notes: ["a", "b"] }), q(2, { options: ["a1", "b2", "c3", "d4", "e5", "f6"], correct_answer: "a1", option_notes: ["1", "2", "3", "4", "5", "6"] })];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    expect(stored(quiz.id).map((s) => s.options.length)).toEqual([2, 6]);
  });

  it("source_page_id outside the sent slides is nulled but the question stays; notes of the wrong length or with a blank are nulled, question stays", async () => {
    const w = world();
    const foreign = world();
    gen.questions = () => [
      q(1, { source_page_id: foreign.topicPages[0] }),
      q(2, { option_notes: ["only", "two"] }),
      q(3, { option_notes: ["a", "b", " ", "d"] }),
      q(4, { option_notes: undefined as unknown as string[] }),
      q(5, { source_page_id: w.topicPages[0] }),
    ];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 5 });
    const s = stored(quiz.id);
    expect(s).toHaveLength(5);
    expect(s[0].source_page_id).toBeNull();
    expect([s[1].option_notes, s[2].option_notes, s[3].option_notes]).toEqual([null, null, null]);
    expect(s[4].source_page_id).toBe(w.topicPages[0]);
    // The browser still gets no notes before answering, and a question without notes answers fine.
    const r = answerQuizMe({ userId: w.userId, id: quiz.id, index: 1, chosen: 0 })!;
    expect(r.option_notes).toBeNull();
  });

  it("picture talk without a picture is dropped; with image_page_id it gets the picture; a foreign slide id is not attached", async () => {
    const w = world();
    const foreign = world();
    gen.questions = () => [
      q(1, { question: "What does the radiograph shown below reveal?" }), // no image id, no source: dropped (no pic to show)
      q(2, { question: "What does the radiograph shown below reveal about the file?", image_page_id: w.pic, source_page_id: w.pic }),
      q(3, { question: "Which finding is seen in the picture below?", image_page_id: foreign.pic }), // foreign slide never attached
      q(4, { question: "What does the radiograph shown here suggest?", source_page_id: w.topicPages[0] }), // generous: falls back to the source slide
    ];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 5 });
    const s = stored(quiz.id);
    for (const x of s) expect(x.image_page_id === null || [w.pic, ...w.topicPages, ...w.hits].includes(x.image_page_id), `image ${x.image_page_id}`).toBe(true);
    expect(s.find((x) => x.question.includes("reveal about the file"))?.image_page_id).toBe(w.pic);
    expect(s.some((x) => x.question === "What does the radiograph shown below reveal?")).toBe(false);
    const view = getQuizMe(w.userId, quiz.id)!;
    const pictured = view.questions.find((x) => x.question.includes("reveal about the file"))!;
    expect(pictured.image?.page_id).toBe(w.pic);
  });

  it("a picture whose slide is later deleted hides that question: it isn't counted, and the quiz can still finish", async () => {
    const w = world();
    gen.questions = () => [q(1), q(2), q(3, { question: "What does the radiograph shown below reveal?", image_page_id: w.pic })];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 3 });
    expect(quiz.questions.filter((x) => x.image).length).toBe(1);
    db.prepare("DELETE FROM pages WHERE id = ?").run(w.pic);
    const v = getQuizMe(w.userId, quiz.id)!;
    expect(v.questions.filter((x) => x.hidden)).toHaveLength(1);
    expect(v.left).toBe(2);
    const idx = v.questions.map((x, i) => (x.hidden ? -1 : i)).filter((i) => i >= 0);
    expect(answerQuizMe({ userId: w.userId, id: quiz.id, index: idx[0], chosen: 0 })!.finished).toBe(false);
    expect(answerQuizMe({ userId: w.userId, id: quiz.id, index: idx[1], chosen: 0 })!.finished).toBe(true);
    expect(db.prepare("SELECT finished_at FROM quizme WHERE id = ?").get(quiz.id)).not.toEqual({ finished_at: null });
  });

  it("zero usable questions is a 500 with a plain message and nothing stored; the in-flight guard is released after every kind of failure", async () => {
    const w = world();
    signIn(w.userId);
    gen.questions = () => [q(1, { correct_index: 2 }), q(2, { options: ["a", "a", "b", "c"] })];
    const before = count();
    const bad = await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }));
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as { error: string }).error).toMatch(/didn't answer in time/);
    expect(count()).toBe(before);
    // Writer throws; credentials throw; empty list.
    gen.fail = new Error("overloaded_error 529");
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).status).toBe(500);
    gen.fail = null;
    credState.fail = true;
    const nokey = await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }));
    expect(nokey.status).toBe(500);
    credState.fail = false;
    gen.questions = () => [];
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).status).toBe(500);
    standard();
    const ok = await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }));
    expect(ok.status).toBe(200); // guard was released each time
    expect(count()).toBe(before + 1);
  });

  it("technical writer errors are not shown to the student except key problems", async () => {
    const w = world();
    signIn(w.userId);
    gen.fail = new Error("Anthropic 500: internal at /var/app/node_modules/x.js:12 stack…");
    const a = (await (await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).json()) as { error: string };
    expect(a.error).toBe("The AI didn't answer in time. Try again in a moment.");
    gen.fail = new Error("Claude returned output that didn't match the expected format.");
    const b = (await (await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).json()) as { error: string };
    expect(b.error).not.toMatch(/format|schema|zod/i);
    gen.fail = new Error("401 invalid x-api-key");
    const c = (await (await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).json()) as { error: string };
    expect(c.error).toMatch(/key/);
  });

  it("'already writing': a second POST while the first is in flight is 400; another student isn't blocked; released after success", async () => {
    standard();
    const w = world();
    const w2 = world();
    signIn(w.userId);
    let release!: () => void;
    gen.gate = new Promise<void>((r) => (release = r));
    const first = createPOST(post({ examId: w.examId, text: TEXT, size: 3 }));
    await new Promise((r) => setTimeout(r, 20));
    const second = await createPOST(post({ examId: w.examId, text: TEXT, size: 5 }));
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toMatch(/Already writing/);
    // Different exam, same student: also blocked (one at a time per student).
    const w1b = world(w.userId);
    expect((await createPOST(post({ examId: w1b.examId, text: TEXT, size: 3 }))).status).toBe(400);
    // Another student: not blocked.
    signIn(w2.userId);
    const third = createPOST(post({ examId: w2.examId, text: TEXT, size: 3 }));
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await first).status).toBe(200);
    expect((await third).status).toBe(200);
    gen.gate = null;
    signIn(w.userId);
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).status).toBe(200);
    expect(gen.calls.length).toBe(3); // the refused ones never reach the writer
  });

  it("two simultaneous POSTs: exactly one writes", async () => {
    standard();
    const w = world();
    signIn(w.userId);
    let release!: () => void;
    gen.gate = new Promise<void>((r) => (release = r));
    const both = [createPOST(post({ examId: w.examId, text: TEXT, size: 3 })), createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))];
    await new Promise((r) => setTimeout(r, 20));
    release();
    const codes = (await Promise.all(both)).map((r) => r.status).sort();
    expect(codes).toEqual([200, 400]);
    expect(gen.calls).toHaveLength(1);
  });

  it("the exam is deleted while the quiz is being written: a plain failure, nothing stored, guard released", async () => {
    standard();
    const w = world();
    signIn(w.userId);
    let release!: () => void;
    gen.gate = new Promise<void>((r) => (release = r));
    const before = count();
    const pending = createPOST(post({ examId: w.examId, text: TEXT, size: 3 }));
    await new Promise((r) => setTimeout(r, 20));
    db.prepare("DELETE FROM exams WHERE id = ?").run(w.examId);
    release();
    const res = await pending;
    expect(res.status).toBe(500);
    expect(count()).toBe(before);
    gen.gate = null;
    const w2 = world(w.userId);
    expect((await createPOST(post({ examId: w2.examId, text: TEXT, size: 3 }))).status).toBe(200);
  });
});

describe("quiz me: answers, leaks, resume, mastery", () => {
  beforeEach(() => void standard());

  it("the whole stored JSON of an unanswered quiz carries no key, explanation or note text (create, GET, open)", async () => {
    const w = world();
    signIn(w.userId);
    const created = await createPOST(post({ examId: w.examId, text: TEXT, size: 5 }));
    const text = await created.text();
    const id = (JSON.parse(text) as { id: number }).id;
    const bodies = [text, await (await quizGET(get(), idCtx(id))).text(), await (await openGET(get(`http://x/api/quizme/open?examId=${w.examId}`))).text()];
    for (const b of bodies) {
      expect(b).not.toMatch(/correct_index|explanation|option_notes|because \d|note for/);
    }
    // After answering question 0 only that question carries them.
    await answerPOST(post({ index: 0, chosen: 1 }), idCtx(id));
    const after = (await (await quizGET(get(), idCtx(id))).json()) as { questions: { correct_index?: number; explanation?: string }[] };
    expect(after.questions.map((x) => x.correct_index !== undefined)).toEqual([true, false, false, false, false]);
    expect(after.questions.map((x) => x.explanation !== undefined)).toEqual([true, false, false, false, false]);
  });

  it("answer validation: index/chosen out of range, negative, float, string, missing; nothing is recorded; a stranger gets 404", async () => {
    const w = world();
    signIn(w.userId);
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    for (const b of [{ index: 3, chosen: 0 }, { index: -1, chosen: 0 }, { index: 0, chosen: 4 }, { index: 0, chosen: -1 }, { index: 0.5, chosen: 0 }, { index: 0, chosen: 1.5 }, { index: "0", chosen: 0 }, { index: 0, chosen: "1" }, { index: 0 }, {}, null, { index: 1e21, chosen: 0 }, { index: 0, chosen: true }]) {
      const res = await answerPOST(post(b), idCtx(quiz.id));
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    expect((await answerPOST(new Request("http://x", { method: "POST", body: "{bad" }), idCtx(quiz.id))).status).toBe(400);
    expect(getQuizMe(w.userId, quiz.id)!.left).toBe(3);
    expect(concept(w.userId)).toBeUndefined();
    for (const id of ["abc", "-1", "0", "1.5", "99999", ""]) expect((await answerPOST(post({ index: 0, chosen: 0 }), idCtx(id))).status, id).toBe(404);
    const stranger = apiReadyUser();
    signIn(stranger);
    expect((await answerPOST(post({ index: 0, chosen: 0 }), idCtx(quiz.id))).status).toBe(404);
    expect((await quizGET(get(), idCtx(quiz.id))).status).toBe(404);
    expect(concept(stranger)).toBeUndefined();
  });

  it("a second answer (even a different one, even concurrent) returns the first with already:true and counts mastery once per question", async () => {
    const w = world();
    signIn(w.userId);
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    const key = stored(quiz.id).map((s) => s.correct_index);
    const wrong = (k: number) => (k + 1) % 4;
    const a = await (await answerPOST(post({ index: 0, chosen: wrong(key[0]) }), idCtx(quiz.id))).json();
    expect(a).toMatchObject({ correct: false, chosen: wrong(key[0]), finished: false });
    expect(a.already).toBeUndefined();
    const again = await (await answerPOST(post({ index: 0, chosen: key[0] }), idCtx(quiz.id))).json();
    expect(again).toMatchObject({ already: true, chosen: wrong(key[0]), correct: false });
    // Out-of-range chosen on an already-answered question: harmless echo of the first answer.
    expect(((await (await answerPOST(post({ index: 0, chosen: 99 }), idCtx(quiz.id))).json()) as { already?: boolean }).already).toBe(true);
    expect(concept(w.userId)).toEqual({ attempts: 1, correct: 0 });
    await Promise.all([1, 1, 1, 1].map((i) => answerPOST(post({ index: i, chosen: key[1] }), idCtx(quiz.id))));
    expect(concept(w.userId)).toEqual({ attempts: 2, correct: 1 });
    const last = await (await answerPOST(post({ index: 2, chosen: key[2] }), idCtx(quiz.id))).json();
    expect(last).toMatchObject({ finished: true, correct: true });
    expect(concept(w.userId)).toEqual({ attempts: 3, correct: 2 });
    const done = await (await answerPOST(post({ index: 2, chosen: wrong(key[2]) }), idCtx(quiz.id))).json();
    expect(done).toMatchObject({ already: true, finished: true });
    expect(concept(w.userId)).toEqual({ attempts: 3, correct: 2 });
    expect(getQuizMe(w.userId, quiz.id)).toMatchObject({ finished: true, left: 0 });
  });

  it("a question with a blank concept records the answer but no mastery; a padded concept name is trimmed onto the same concept", async () => {
    const w = world();
    gen.questions = () => [q(1, { concept: "   " }), q(2, { concept: "  Irrigants  " }), q(3, { concept: "Irrigants" })];
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    for (const i of [0, 1, 2]) answerQuizMe({ userId: w.userId, id: quiz.id, index: i, chosen: stored(quiz.id)[i].correct_index });
    expect(concept(w.userId)).toEqual({ attempts: 2, correct: 2 });
    expect(db.prepare("SELECT COUNT(*) n FROM concepts WHERE user_id = ? AND name = ''").get(w.userId)).toEqual({ n: 0 });
  });

  it("concepts tested on the section's own slides are linked to the section; concepts from search hits are not", async () => {
    const w = world();
    gen.questions = () => [q(1, { concept: "Own", source_page_id: w.topicPages[0] }), q(2, { concept: "Hit", source_page_id: w.hits[0] })];
    await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 3 });
    const linked = (db.prepare("SELECT c.name FROM topic_concepts tc JOIN concepts c ON c.id = tc.concept_id WHERE tc.topic_id = ?").all(w.topicId) as { name: string }[]).map((r) => r.name);
    expect(linked).toEqual(["Own"]);
  });

  it("open returns only this student's newest unfinished quiz for that exam; finished, other exams and other students are ignored", async () => {
    const w = world();
    const w2 = world(w.userId);
    const a = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    const b = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT + " again", size: 3 });
    const other = await createQuizMe({ userId: w.userId, examId: w2.examId, text: TEXT, size: 3 });
    expect(openQuizMe(w.userId, w.examId)?.id).toBe(b.id);
    expect(openQuizMe(w.userId, w2.examId)?.id).toBe(other.id);
    for (let i = 0; i < 3; i++) answerQuizMe({ userId: w.userId, id: b.id, index: i, chosen: 0 });
    expect(openQuizMe(w.userId, w.examId)?.id).toBe(a.id);
    const stranger = apiReadyUser();
    expect(openQuizMe(stranger, w.examId)).toBeNull();
    signIn(stranger);
    const res = await openGET(get(`http://x/api/quizme/open?examId=${w.examId}`));
    expect(res.status).toBe(404); // not her exam
    signIn(w.userId);
    for (const bad of ["", "abc", "1.5", "-1", "0", "99999"]) expect((await openGET(get(`http://x/api/quizme/open?examId=${bad}`))).status, bad).toBe(404);
    expect((await openGET(get("http://x/api/quizme/open"))).status).toBe(404);
    const none = world(w.userId);
    const empty = await openGET(get(`http://x/api/quizme/open?examId=${none.examId}`));
    expect(await empty.json()).toEqual({ quiz: null });
  });

  it("open marks a quiz whose remaining questions are all hidden as finished, and moves on to the next open one (it does not return null forever)", async () => {
    const w = world();
    const older = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    gen.questions = () => [q(1, { question: "What does the radiograph shown below reveal?", image_page_id: w.pic })];
    const pictured = await createQuizMe({ userId: w.userId, examId: w.examId, topicId: w.topicId, text: TEXT, size: 3 });
    db.prepare("DELETE FROM pages WHERE id = ?").run(w.pic);
    const got = openQuizMe(w.userId, w.examId);
    expect(db.prepare("SELECT finished_at FROM quizme WHERE id = ?").get(pictured.id)).not.toEqual({ finished_at: null });
    // The older unfinished quiz is offered straight away rather than hidden behind the dead one (fixed: open moves on
    // to the next unfinished quiz in the same call).
    expect(got?.id).toBe(older.id);
    expect(openQuizMe(w.userId, w.examId)?.id).toBe(older.id);
  });

  it("deleting a student or an exam removes their quizzes (foreign keys)", async () => {
    const w = world();
    await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    expect(count()).toBeGreaterThan(0);
    db.prepare("DELETE FROM exams WHERE id = ?").run(w.examId);
    expect(db.prepare("SELECT COUNT(*) n FROM quizme WHERE exam_id = ?").get(w.examId)).toEqual({ n: 0 });
    const w2 = world();
    await createQuizMe({ userId: w2.userId, examId: w2.examId, text: TEXT, size: 3 });
    db.prepare("DELETE FROM users WHERE id = ?").run(w2.userId);
    expect(db.prepare("SELECT COUNT(*) n FROM quizme WHERE user_id = ?").get(w2.userId)).toEqual({ n: 0 });
  });

  it("signed-out and unfinished-setup users get 401 on every quiz-me route", async () => {
    const w = world();
    const quiz = await createQuizMe({ userId: w.userId, examId: w.examId, text: TEXT, size: 3 });
    signIn(null);
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).status).toBe(401);
    expect((await quizGET(get(), idCtx(quiz.id))).status).toBe(401);
    expect((await answerPOST(post({ index: 0, chosen: 0 }), idCtx(quiz.id))).status).toBe(401);
    expect((await openGET(get(`http://x/api/quizme/open?examId=${w.examId}`))).status).toBe(401);
    db.prepare("UPDATE users SET api_key_enc = NULL WHERE id = ?").run(w.userId);
    signIn(w.userId);
    expect((await createPOST(post({ examId: w.examId, text: TEXT, size: 3 }))).status).toBe(401);
  });
});
