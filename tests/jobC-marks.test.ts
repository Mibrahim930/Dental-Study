import { describe, expect, it, vi } from "vitest";

let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { addRange, cleanMarks, coveringRange, isEmpty, MARKS_KEY, mergeRanges, removeRangeAt, segments } from "@/lib/marks";
import { GET, PUT } from "@/app/api/marks/route";
import { makeExam, makeUser } from "./helpers";

describe("range maths", () => {
  it("merges overlapping and touching ranges, drops empty ones, sorts", () => {
    expect(mergeRanges([[5, 8], [0, 2], [2, 3], [7, 10], [4, 4]])).toEqual([[0, 3], [5, 10]]);
    expect(addRange([[0, 3]], [10, 12])).toEqual([[0, 3], [10, 12]]);
    expect(addRange([[0, 3], [10, 12]], [2, 11])).toEqual([[0, 12]]);
  });

  it("removes the highlight under a character; finds one covering a selection", () => {
    expect(removeRangeAt([[0, 3], [5, 9]], 6)).toEqual([[0, 3]]);
    expect(removeRangeAt([[0, 3]], 3)).toEqual([[0, 3]]);
    expect(coveringRange([[0, 10]], [2, 5])).toEqual([0, 10]);
    expect(coveringRange([[0, 4]], [2, 5])).toBeNull();
  });

  it("splits text into marked and plain pieces that rebuild the text exactly", () => {
    const text = "Pulp necrosis is not vital";
    const parts = segments(text, [[0, 4], [21, 26], [100, 200]]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.filter((p) => p.marked).map((p) => p.text)).toEqual(["Pulp", "vital"]);
    expect(segments("", [[0, 3]])).toEqual([{ text: "", start: 0, marked: false }]);
    expect(segments("abc", [])).toEqual([{ text: "abc", start: 0, marked: false }]);
  });

  it("cleanMarks keeps only sane data", () => {
    expect(cleanMarks(null)).toBeNull();
    expect(cleanMarks("x")).toBeNull();
    const m = cleanMarks({ hl: { stem: [[3, 1], [0, 2], [1, 4], "x", [1.5, 2]], opt2: [[0, 5]], evil: [[0, 1]], opt1: "no" }, crossed: [3, 3, 1, -1, 2.5, 99, "4"] })!;
    expect(m).toEqual({ hl: { stem: [[0, 4]], opt2: [[0, 5]] }, crossed: [1, 3] });
    expect(isEmpty(cleanMarks({})!)).toBe(true);
  });

  it("keys: practice-exam question or quiz question id only", () => {
    for (const k of ["attempt:12:345", "quiz:0a1b2c3d"]) expect(MARKS_KEY.test(k), k).toBe(true);
    for (const k of ["attempt:12", "quiz:ZZZZZZZZ", "quiz:0a1b2c3d4", "x", "attempt:1:2:3", "../etc"]) expect(MARKS_KEY.test(k), k).toBe(false);
  });
});

describe("/api/marks", () => {
  const get = (key: string) => GET(new Request(`http://x/api/marks?key=${encodeURIComponent(key)}`));
  const put = (body: unknown) => PUT(new Request("http://x/api/marks", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) }));
  function attemptOf(userId: number) {
    const { examId } = makeExam(userId, null, [1]);
    return Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(examId).lastInsertRowid);
  }

  it("round trip for a practice question; empty marks delete the row", async () => {
    currentUserId = makeUser();
    const key = `attempt:${attemptOf(currentUserId)}:7`;
    expect(await (await get(key)).json()).toEqual({ marks: null, updated_at: null });
    const marks = { hl: { stem: [[0, 4]] }, crossed: [2] };
    expect((await put({ key, marks })).status).toBe(200);
    expect((await (await get(key)).json()).marks).toEqual(marks);
    expect((await put({ key, marks: { hl: {}, crossed: [] } })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ?").get(currentUserId)).toEqual({ n: 0 });
  });

  it("quiz keys are per student: one student's marks never show for another", async () => {
    const a = makeUser();
    const b = makeUser();
    currentUserId = a;
    await put({ key: "quiz:abcdef12", marks: { hl: {}, crossed: [1] } });
    currentUserId = b;
    expect((await (await get("quiz:abcdef12")).json()).marks).toBeNull();
  });

  it("refuses: signed out, someone else's practice exam, bad keys, bad bodies", async () => {
    const owner = makeUser();
    const key = `attempt:${attemptOf(owner)}:1`;
    currentUserId = 0;
    expect((await get(key)).status).toBe(401);
    expect((await put({ key, marks: { hl: {}, crossed: [1] } })).status).toBe(401);
    currentUserId = makeUser();
    expect((await get(key)).status).toBe(400);
    expect((await put({ key, marks: { hl: {}, crossed: [1] } })).status).toBe(400);
    expect((await get("attempt:999999999:1")).status).toBe(400);
    expect((await get("whatever")).status).toBe(400);
    expect((await put("not json")).status).toBe(400);
    expect((await put({ key: "quiz:abcdef12", marks: "x" })).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) n FROM question_marks WHERE key = ?").get(key)).toEqual({ n: 0 });
  });

  it("caps the size (100 highlights per text, and a size limit on top)", async () => {
    currentUserId = makeUser();
    const fields = ["stem", "case", ...Array.from({ length: 10 }, (_, f) => `opt${f}`)];
    const ranges = (n: number) => Array.from({ length: n }, (_, i) => [10000 + i * 90, 10000 + i * 90 + 50]);
    const huge = { hl: Object.fromEntries(fields.map((f) => [f, ranges(500)])), crossed: [] };
    expect((await put({ key: "quiz:abcdef12", marks: huge })).status).toBe(400);
    const ok = { hl: { stem: ranges(500) }, crossed: [] };
    expect((await put({ key: "quiz:abcdef12", marks: ok })).status).toBe(200);
    const saved = (await (await get("quiz:abcdef12")).json()).marks;
    expect(saved.hl.stem).toHaveLength(100);
  });
});
