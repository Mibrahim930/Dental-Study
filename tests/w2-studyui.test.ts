// Wave 2, study page and quiz panel: the pure pieces behind the shared dialog (which one answers Escape, the page's
// scroll lock, where Tab goes), the selection pills' thresholds and placement, and lesson marks in one request.
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});

import { sessionToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { GET, PUT } from "@/app/api/marks/route";
import { isTopDialog, lockScroll, nextFocus, openDialogs, pushDialog, removeDialog } from "@/components/dialogStack";
import { clampX, enoughToQuiz, markPillTop, QUIZ_MAX_CHARS, quizPillPlace, tidy } from "@/components/selection";
import { makeUser } from "./helpers";

function signIn(): number {
  const id = makeUser();
  db.prepare("UPDATE users SET api_key_enc = 'enc' WHERE id = ?").run(id);
  jar.cookie = sessionToken(id, 0);
  return id;
}
const put = (key: string, marks: unknown) => PUT(new Request("http://x/api/marks", { method: "PUT", body: JSON.stringify({ key, marks }) }));
const byPrefix = (prefix: string) => GET(new Request(`http://x/api/marks?prefix=${encodeURIComponent(prefix)}`));
const hl = (s: number, e: number) => ({ hl: { text: [[s, e]] }, crossed: [] });

beforeEach(() => {
  jar.cookie = undefined;
});

describe("dialog stack", () => {
  it("only the most recently opened dialog is on top; closing it hands the top back to the one under it", () => {
    const panel = Symbol("panel");
    const report = Symbol("report");
    expect(isTopDialog(panel)).toBe(false);
    pushDialog(panel);
    expect(isTopDialog(panel)).toBe(true);
    pushDialog(report); // Report opened over the quiz panel: Escape belongs to Report only
    expect(isTopDialog(report)).toBe(true);
    expect(isTopDialog(panel)).toBe(false);
    pushDialog(report); // the same one twice (React's development double-run) is still one entry
    expect(openDialogs()).toBe(2);
    removeDialog(report);
    expect(isTopDialog(panel)).toBe(true);
    removeDialog(report); // already gone: no harm
    removeDialog(panel);
    expect(openDialogs()).toBe(0);
    expect(isTopDialog(panel)).toBe(false);
  });

  it("a dialog under the top one closing first leaves the top one on top", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    pushDialog(a);
    pushDialog(b);
    removeDialog(a);
    expect(isTopDialog(b)).toBe(true);
    removeDialog(b);
    expect(openDialogs()).toBe(0);
  });

  it("scroll lock: the page stays locked until the last dialog closes, then gets its own overflow back", () => {
    const doc = { documentElement: { style: { overflow: "" } }, body: { style: { overflow: "auto" } } };
    const first = lockScroll(doc);
    expect([doc.documentElement.style.overflow, doc.body.style.overflow]).toEqual(["hidden", "hidden"]);
    const second = lockScroll(doc);
    first();
    expect(doc.body.style.overflow).toBe("hidden"); // the second dialog is still open
    first(); // releasing twice counts once
    expect(doc.body.style.overflow).toBe("hidden");
    second();
    expect([doc.documentElement.style.overflow, doc.body.style.overflow]).toEqual(["", "auto"]);
  });

  it("Tab wraps at the ends and comes back in from outside; steps inside are left to the browser", () => {
    const items = ["close", "input", "no", "yes"];
    expect(nextFocus(items, "yes", false)).toBe("close");
    expect(nextFocus(items, "close", true)).toBe("yes");
    expect(nextFocus(items, "input", false)).toBeNull();
    expect(nextFocus(items, "no", true)).toBeNull();
    expect(nextFocus(items, null, false)).toBe("close");
    expect(nextFocus(items, "somewhere else", true)).toBe("yes");
    expect(nextFocus([], null, false)).toBeNull();
  });
});

describe("selection pills", () => {
  it("Quiz me on this: at least three words and twenty characters, spaces tidied", () => {
    expect(enoughToQuiz("the periodontal ligament")).toBe(true);
    expect(enoughToQuiz("periodontal ligament fibres")).toBe(true);
    expect(enoughToQuiz("periodontal   ligament")).toBe(false); // two words, however long
    expect(enoughToQuiz("a b c d")).toBe(false); // four words, too short
    expect(enoughToQuiz("  one\n two \t three four five  ")).toBe(true);
    expect(enoughToQuiz("")).toBe(false);
  });

  it("a long selection is cut at a word near the limit", () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const t = tidy(words);
    expect(t.cut).toBe(true);
    expect(t.text.length).toBeLessThanOrEqual(QUIZ_MAX_CHARS);
    expect(words.startsWith(t.text)).toBe(true);
    expect(words[t.text.length]).toBe(" "); // ends on a whole word
    expect(tidy("short  text\n").text).toBe("short text");
    expect(tidy("short text").cut).toBe(false);
  });

  it("placement: marking pills above the selection unless it's near the top; Quiz me below, a row lower then", () => {
    expect(markPillTop(300, 320)).toBe(252);
    expect(markPillTop(40, 60)).toBe(68);
    expect(clampX(10, 70, 375)).toBe(70);
    expect(clampX(370, 110, 375)).toBe(265);
    expect(quizPillPlace({ left: 0, width: 100, top: 300, bottom: 320 }, 375, 700)).toEqual({ left: 92, top: 334 });
    expect(quizPillPlace({ left: 100, width: 100, top: 40, bottom: 60 }, 375, 700)).toEqual({ left: 150, top: 122 }); // under the marking pill
    expect(quizPillPlace({ left: 100, width: 100, top: 600, bottom: 690 }, 375, 700).top).toBe(640); // kept on screen
  });
});

describe("GET /api/marks?prefix= (a lesson's marks in one request)", () => {
  it("returns every block of that lesson she has marks on, and nothing else", async () => {
    const me = signIn();
    for (const [k, s] of [["lesson:7:0:120", 0], ["lesson:7:31:400", 5], ["lesson:7:32:90", 9], ["lesson:70:1:50", 1], ["lesson:8:1:50", 2]] as const) {
      expect((await put(k, hl(s, s + 3))).status).toBe(200);
    }
    expect((await put("quiz:0123abcd", hl(0, 2))).status).toBe(200);
    // Someone else's marks on the same lesson are never hers.
    const other = signIn();
    expect((await put("lesson:7:31:400", hl(50, 60))).status).toBe(200);
    jar.cookie = sessionToken(me, 0);

    const res = await byPrefix("lesson:7:");
    expect(res.status).toBe(200);
    const { marks } = (await res.json()) as { marks: Record<string, { hl: { text: number[][] } }> };
    expect(Object.keys(marks).sort()).toEqual(["lesson:7:0:120", "lesson:7:31:400", "lesson:7:32:90"]);
    expect(marks["lesson:7:31:400"].hl.text).toEqual([[5, 8]]);
    expect(db.prepare("SELECT COUNT(*) n FROM question_marks WHERE user_id = ?").get(other)).toEqual({ n: 1 });
  });

  it("a lesson with no marks answers an empty map; an unreadable row reads as empty marks", async () => {
    const me = signIn();
    expect(await (await byPrefix("lesson:4:")).json()).toEqual({ marks: {} });
    db.prepare("INSERT INTO question_marks (user_id, key, json) VALUES (?, 'lesson:4:1:10', '{not json')").run(me);
    expect(await (await byPrefix("lesson:4:")).json()).toEqual({ marks: { "lesson:4:1:10": { hl: {}, crossed: [] } } });
  });

  it("only a lesson prefix is accepted (no other kind, no partial ids, no wildcards)", async () => {
    signIn();
    for (const p of ["", "lesson:", "lesson:7", "lesson:7:3:", "lesson:a:", "lesson:%:", "lesson:_:", "quiz:", "quizme:3:", "attempt:1:", "lesson:1234567890123:", " lesson:7:"]) {
      expect((await byPrefix(p)).status, JSON.stringify(p)).toBe(400);
    }
  });

  it("signed out: 401", async () => {
    expect((await byPrefix("lesson:7:")).status).toBe(401);
  });

  it("single keys still work as before", async () => {
    signIn();
    await put("lesson:9:1:10", hl(1, 4));
    const one = (await (await GET(new Request("http://x/api/marks?key=lesson%3A9%3A1%3A10"))).json()) as { marks: { hl: { text: number[][] } } };
    expect(one.marks.hl.text).toEqual([[1, 4]]);
  });
});
