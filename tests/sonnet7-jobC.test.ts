import { describe, expect, it, vi } from "vitest";

let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { addRange, cleanMarks, mergeRanges, segments, type Range } from "@/lib/marks";
import { GET, PUT } from "@/app/api/marks/route";
import { makeUser } from "./helpers";

function attemptFor(userId: number) {
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  return Number(db.prepare("INSERT INTO attempts (exam_id, mode) VALUES (?, 'tutor')").run(examId).lastInsertRowid);
}
const put = (body: unknown) => PUT(new Request("http://x/m", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) }));
const get = (key: string) => GET(new Request("http://x/m?key=" + encodeURIComponent(key)));

describe("marks API", () => {
  it("another user's attempt: no read, no write", async () => {
    const a = makeUser();
    const b = makeUser();
    const att = attemptFor(a);
    currentUserId = a;
    expect((await put({ key: `attempt:${att}:3`, marks: { hl: { stem: [[0, 3]] }, crossed: [1] } })).status).toBe(200);
    currentUserId = b;
    expect((await get(`attempt:${att}:3`)).status).toBe(400);
    expect((await put({ key: `attempt:${att}:3`, marks: { hl: {}, crossed: [2] } })).status).toBe(400);
    currentUserId = a;
    const got = await (await get(`attempt:${att}:3`)).json();
    expect(got.marks.crossed).toEqual([1]);
  });

  it("same quiz key for two students stays separate", async () => {
    const a = makeUser();
    const b = makeUser();
    currentUserId = a;
    await put({ key: "quiz:deadbeef", marks: { hl: {}, crossed: [0] } });
    currentUserId = b;
    expect((await (await get("quiz:deadbeef")).json()).marks).toBeNull();
    await put({ key: "quiz:deadbeef", marks: { hl: {}, crossed: [3] } });
    currentUserId = a;
    expect((await (await get("quiz:deadbeef")).json()).marks.crossed).toEqual([0]);
  });

  it("malformed keys are refused", async () => {
    currentUserId = makeUser();
    for (const key of ["", "quiz:", "quiz:DEADBEEF", "quiz:deadbeef0", "quiz:deadbee", "attempt:1", "attempt:1:2:3", "attempt:a:b", "attempt:1:1234567890123", "x", "attempt:-1:2", "quiz:deadbeef\n", " quiz:deadbeef", "../quiz:deadbeef"]) {
      expect((await put({ key, marks: { hl: {}, crossed: [1] } })).status, JSON.stringify(key)).toBe(400);
      expect((await get(key)).status, "get " + JSON.stringify(key)).toBe(400);
    }
    expect((await put({ key: 12, marks: {} })).status).toBe(400);
    expect((await put({ key: ["quiz:deadbeef"], marks: {} })).status).toBe(400);
    expect((await put("not json")).status).toBe(400);
    expect((await put("null")).status).toBe(400);
    expect((await GET(new Request("http://x/m"))).status).toBe(400);
  });

  it("unauthenticated is 401", async () => {
    currentUserId = 0;
    expect((await get("quiz:deadbeef")).status).toBe(401);
    expect((await put({ key: "quiz:deadbeef", marks: { hl: {}, crossed: [1] } })).status).toBe(401);
  });

  it("bad marks values: not an object, ranges non-integer / negative / over 20000 / reversed, crossed out of range", async () => {
    currentUserId = makeUser();
    expect((await put({ key: "quiz:00000001", marks: "x" })).status).toBe(400);
    expect((await put({ key: "quiz:00000001", marks: null })).status).toBe(400);
    expect((await put({ key: "quiz:00000001" })).status).toBe(400);
    await put({ key: "quiz:00000002", marks: { hl: { stem: [[0.5, 3], [-1, 4], [5, 20001], [9, 2], [2, 2], ["a", "b"], [1, 2, 3], null], opt0: [[1, 4]] }, crossed: [-1, 10, 99, 1.5, "2", 2, 2, 0] } });
    const got = await (await get("quiz:00000002")).json();
    expect(got.marks.hl).toEqual({ opt0: [[1, 4]] });
    expect(got.marks.crossed).toEqual([0, 2]);
  });

  it("overlapping and touching ranges are merged on save", async () => {
    currentUserId = makeUser();
    await put({ key: "quiz:00000003", marks: { hl: { stem: [[10, 20], [0, 5], [5, 12], [30, 40]] }, crossed: [] } });
    expect((await (await get("quiz:00000003")).json()).marks.hl.stem).toEqual([[0, 20], [30, 40]]);
  });

  it("unknown fields (opt10, __proto__, constructor) are dropped", async () => {
    currentUserId = makeUser();
    await put(`{"key":"quiz:00000004","marks":{"hl":{"opt10":[[0,1]],"__proto__":[[0,1]],"constructor":[[0,1]],"stem":[[0,1]]},"crossed":[1]}}`);
    const m = (await (await get("quiz:00000004")).json()).marks;
    expect(Object.keys(m.hl)).toEqual(["stem"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("giant payloads: a million ranges, a huge crossed list, 5 MB body - no crash, small row", async () => {
    currentUserId = makeUser();
    const many = Array.from({ length: 1_000_000 }, (_, i) => [i * 2, i * 2 + 1]);
    const r = await put({ key: "quiz:00000005", marks: { hl: { stem: many }, crossed: Array.from({ length: 100000 }, (_, i) => i) } });
    expect([200, 400]).toContain(r.status);
    const row = db.prepare("SELECT length(json) n FROM question_marks WHERE key = 'quiz:00000005'").get() as { n: number } | undefined;
    if (row) expect(row.n).toBeLessThanOrEqual(40000);
  });

  it("a full legitimate set (12 fields x 100 ranges) is accepted", async () => {
    currentUserId = makeUser();
    const fields = ["stem", "case", ...Array.from({ length: 10 }, (_, i) => `opt${i}`)];
    const hl = Object.fromEntries(fields.map((f) => [f, Array.from({ length: 100 }, (_, i) => [i * 100 + 1, i * 100 + 19999 > 20000 ? i * 100 + 50 : i * 100 + 50])]));
    expect((await put({ key: "quiz:00000006", marks: { hl, crossed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] } })).status).toBe(200);
  });

  it("empty marks delete the row, and deleting a missing row is fine", async () => {
    const u = makeUser();
    currentUserId = u;
    await put({ key: "quiz:00000007", marks: { hl: { stem: [[0, 2]] }, crossed: [] } });
    expect(db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ?").get(u)).toEqual({ n: 1 });
    expect((await put({ key: "quiz:00000007", marks: { hl: { stem: [] }, crossed: [] } })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ?").get(u)).toEqual({ n: 0 });
    expect((await put({ key: "quiz:00000008", marks: { hl: {}, crossed: [] } })).status).toBe(200);
    expect((await (await get("quiz:00000007")).json()).marks).toBeNull();
  });

  it("BUG (very low): a stored row with corrupt JSON does not crash GET with a 500", async () => {
    const u = makeUser();
    currentUserId = u;
    db.prepare("INSERT INTO question_marks (user_id, key, json) VALUES (?, 'quiz:00000009', 'not json')").run(u);
    let status = 0;
    try {
      status = (await get("quiz:00000009")).status;
    } catch {
      status = 500;
    }
    expect(status, "BUG: corrupt stored JSON makes GET throw").toBe(200);
  });
});

describe("range maths", () => {
  it("mergeRanges / addRange never change their input", () => {
    const a: Range[] = [[0, 5], [10, 12]];
    const copy = JSON.stringify(a);
    addRange(a, [3, 11]);
    mergeRanges(a);
    expect(JSON.stringify(a)).toBe(copy);
  });
  it("segments with crossed-out-of-range, overlapping and reversed ranges still rebuild the text", () => {
    const text = "héllo wörld 🦷 end";
    for (const rs of [[[0, 3], [2, 9]], [[5, 200]], [[9, 2]], [[-5, 3]], [[3, 3]], [[0, 0], [1, 100000]]] as Range[][]) {
      expect(segments(text, rs).map((p) => p.text).join(""), JSON.stringify(rs)).toBe(text);
    }
  });
  it("cleanMarks with NaN, Infinity, nested arrays and a 5000-entry crossed list", () => {
    const m = cleanMarks({ hl: { stem: [[NaN, 2], [Infinity, 3], [[1], [2]]] }, crossed: Array.from({ length: 5000 }, (_, i) => i) })!;
    expect(m.hl).toEqual({});
    expect(m.crossed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
