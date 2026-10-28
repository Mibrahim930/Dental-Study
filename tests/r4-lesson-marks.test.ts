// Highlights and underlines on lesson text: saved like question marks, under "lesson:<topic>:<slide>" keys with the
// fields "text" (highlights) and "under" (underlines).
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});

import { sessionToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { cleanMarks, MARKS_KEY } from "@/lib/marks";
import { GET, PUT } from "@/app/api/marks/route";
import { makeUser } from "./helpers";

function signIn(): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc' WHERE id = ?").run(id);
  jar.cookie = sessionToken(id, 0);
  return id;
}
const put = (body: unknown) => PUT(new Request("http://x/api/marks", { method: "PUT", body: JSON.stringify(body) }));
const get = (key: string) => GET(new Request(`http://x/api/marks?key=${encodeURIComponent(key)}`));

beforeEach(() => {
  jar.cookie = undefined;
});

describe("lesson marks", () => {
  it("keys: lesson:<topic>:<slide> is accepted (slide 0 for the intro); junk shapes are not", () => {
    for (const k of ["lesson:1:0:120", "lesson:12:345:0", "lesson:999999999999:1:9999999", "quizme:3:0", "quizme:123456789012:9999"]) expect(MARKS_KEY.test(k), k).toBe(true);
    for (const k of ["quizme:3", "quizme:a:1", "quizme:3:12345", "quizme:3:1:2"]) expect(MARKS_KEY.test(k), k).toBe(false);
    for (const k of ["lesson:1:2", "lesson:1", "lesson:a:1:2", "lesson:1:2:3:4", "lesson:-1:2:3", " lesson:1:2:3", "lesson:1:2:3 ", "lesson:1234567890123:1:2", "lesson:1:2:12345678"]) expect(MARKS_KEY.test(k), k).toBe(false);
  });

  it("fields: text (highlights) and under (underlines) are kept, merged and capped; unknown fields are dropped", () => {
    const m = cleanMarks({ hl: { text: [[0, 5], [3, 9], [20, 25]], under: [[1, 2]], bogus: [[0, 1]], opt3: [[0, 1]] }, crossed: [] })!;
    expect(m.hl.text).toEqual([[0, 9], [20, 25]]);
    expect(m.hl.under).toEqual([[1, 2]]);
    expect(m.hl.bogus).toBeUndefined();
    expect(m.hl.opt3).toEqual([[0, 1]]);
    expect(cleanMarks({ hl: { text: Array.from({ length: 150 }, (_, i) => [i * 3, i * 3 + 1]) }, crossed: [] })!.hl.text).toHaveLength(100);
    expect(cleanMarks({ hl: { under: [[5, 5], [9, 3], [-1, 4], [1.5, 2], [0, 30000]] }, crossed: [] })!.hl.under).toBeUndefined();
  });

  it("the marks API saves and returns lesson marks for the signed-in student only; empty marks delete the row", async () => {
    const me = signIn();
    expect((await put({ key: "lesson:7:3:400", marks: { hl: { text: [[0, 4]], under: [[10, 14]] }, crossed: [] } })).status).toBe(200);
    const got = (await (await get("lesson:7:3:400")).json()) as { marks: { hl: Record<string, number[][]> } };
    expect(got.marks.hl).toEqual({ text: [[0, 4]], under: [[10, 14]] });
    expect(db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ? AND key = 'lesson:7:3:400'").get(me)).toEqual({ n: 1 });
    // another student sees nothing under the same key
    signIn();
    expect(((await (await get("lesson:7:3:400")).json()) as { marks: unknown }).marks).toBeNull();
    // back as the first: clearing deletes the row
    jar.cookie = sessionToken(me, 0);
    expect((await put({ key: "lesson:7:3:400", marks: { hl: {}, crossed: [] } })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ? AND key = 'lesson:7:3:400'").get(me)).toEqual({ n: 0 });
    // a bad key is a 400
    expect((await put({ key: "lesson:7:3", marks: { hl: { text: [[0, 1]] }, crossed: [] } })).status).toBe(400);
    jar.cookie = undefined;
    expect((await get("lesson:7:3:400")).status).toBe(401);
  });
});
