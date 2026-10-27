// Sonnet QA 18: attack tests for slide-by-slide lessons (tidyLesson, repair trigger, v3 migration, lesson route, class copy).
// Tests named "BUG: …" document a real defect and are left failing on purpose.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string };
const calls: Call[] = [];
let lessonWriter: (call: number, content: string) => unknown = () => ({});
let lessonCalls = 0;

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content });
    if (opts.purpose === "lesson" || opts.purpose === "lesson repair") return lessonWriter(++lessonCalls, opts.content);
    if (opts.purpose === "section quiz") return { questions: [] };
    if (opts.purpose === "section quiz check") return { verdicts: [] };
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db, type Topic } from "@/lib/db";
import { getLesson, lessonIsCurrent, lessonText, LESSON_VERSION } from "@/lib/study";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { makeUser } from "./helpers";

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const notesJson = (i: number, facts: string[], emphasized = false) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized, emphasis_note: null,
    case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

type World = ReturnType<typeof world>;
/** One exam, one topic over n slides, one study session. */
function world(n: number, facts: (i: number) => string[] = (i) => [`fact a${i}`, `fact b${i}`], o: { userId?: number; filename?: string; starred?: number[] } = {}) {
  const userId = o.userId ?? makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, ?, 'done')").run(examId, o.filename ?? "L1.pdf").lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, ?, 1.5)")
        .run(doc, i + 1, notesJson(i, facts(i), o.starred?.includes(i)), o.starred?.includes(i) ? 1 : 0).lastInsertRowid,
    ),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, doc, pages, topicId, sessionId, topic };
}
const good = (w: { pages: number[] }, text = "text", extra: object = {}) => ({
  intro: "intro",
  slides: w.pages.map((page_id) => ({ page_id, explanation: text })),
  key_points: ["k"],
  connections: null,
  ...extra,
});
const stored = (w: World, lesson: object) => db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), w.topicId);
const getRoute = (w: World, qs = "position=0") => lessonGET(new Request(`http://x/l?${qs}`), ctx(w.sessionId));
const repairPrompt = () => {
  const c = calls.find((x) => x.purpose === "lesson repair")!.content;
  return c.slice(c.indexOf("Your previous lesson"));
};

beforeEach(() => {
  calls.length = 0;
  lessonCalls = 0;
  currentUserId = 0;
  lessonWriter = () => ({});
});

describe("tidyLesson (through getLesson)", () => {
  it("page ids that are strings / floats / negative / null / NaN are dropped", async () => {
    const w = world(2, () => []);
    lessonWriter = () =>
      good(w, "", {
        slides: [
          { page_id: String(w.pages[0]), explanation: "string id" },
          { page_id: w.pages[0] + 0.5, explanation: "float id" },
          { page_id: -w.pages[0], explanation: "negative id" },
          { page_id: null, explanation: "null id" },
          { page_id: NaN, explanation: "nan id" },
          { explanation: "no id" },
          { page_id: w.pages[1], explanation: "real" },
        ],
      });
    const l = await getLesson(w.topic());
    expect(l.slides).toEqual([{ page_id: w.pages[1], explanation: "real" }]);
  });

  it("explanations that are numbers / null / objects / whitespace are dropped; others are trimmed", async () => {
    const w = world(5, () => []);
    lessonWriter = () =>
      good(w, "", {
        slides: [
          { page_id: w.pages[0], explanation: 42 },
          { page_id: w.pages[1], explanation: null },
          { page_id: w.pages[2], explanation: "  \n\t " },
          { page_id: w.pages[3], explanation: { text: "x" } },
          { page_id: w.pages[4], explanation: "  padded  " },
        ],
      });
    const l = await getLesson(w.topic());
    expect(l.slides).toEqual([{ page_id: w.pages[4], explanation: "padded" }]);
  });

  it("non-object slide entries (null, string, number) do not throw", async () => {
    const w = world(1, () => []);
    lessonWriter = () => good(w, "", { slides: [null, "abc", 7, undefined, [], { page_id: w.pages[0], explanation: "ok" }] });
    expect((await getLesson(w.topic())).slides).toHaveLength(1);
  });

  it("slides not an array (object / string / null / missing) gives an empty slide list", async () => {
    for (const slides of [{ 0: { page_id: 1, explanation: "x" } }, "text", null, undefined]) {
      const w = world(1, () => []);
      lessonWriter = () => ({ intro: "i", slides, key_points: ["k"], connections: null });
      const l = await getLesson(w.topic());
      expect(l.slides).toEqual([]);
    }
  });

  it("missing intro, missing key_points, wrong-typed connections are normalised", async () => {
    const w = world(1, () => []);
    lessonWriter = () => ({ slides: [{ page_id: w.pages[0], explanation: "e" }], connections: 5 });
    const l = await getLesson(w.topic());
    expect(l.intro).toBe("");
    expect(l.key_points).toEqual([]);
    expect(l.connections).toBeNull();
    expect(l.version).toBe(LESSON_VERSION);
    const w2 = world(1, () => []);
    lessonWriter = () => ({ intro: 12, slides: [], key_points: "nope", connections: "see exam 1" });
    const l2 = await getLesson(w2.topic());
    expect(l2.intro).toBe("");
    expect(l2.key_points).toEqual([]);
    expect(l2.connections).toBe("see exam 1");
  });

  it("intro is trimmed", async () => {
    const w = world(1, () => []);
    lessonWriter = () => good(w, "e", { intro: "  hello  \n" });
    expect((await getLesson(w.topic())).intro).toBe("hello");
  });

  it("duplicates in any order merge in first-seen order of text, output in slide order", async () => {
    const w = world(3, () => []);
    const [a, b, c] = w.pages;
    lessonWriter = () =>
      good(w, "", {
        slides: [
          { page_id: c, explanation: "c1" },
          { page_id: a, explanation: "a1" },
          { page_id: c, explanation: "c2" },
          { page_id: b, explanation: "b1" },
          { page_id: a, explanation: "a2" },
          { page_id: c, explanation: "   " },
          { page_id: c, explanation: "c3" },
        ],
      });
    const l = await getLesson(w.topic());
    expect(l.slides).toEqual([
      { page_id: a, explanation: "a1\n\na2" },
      { page_id: b, explanation: "b1" },
      { page_id: c, explanation: "c1\n\nc2\n\nc3" },
    ]);
  });

  it("a page of another topic in the same exam, and a page of another user's exam, are dropped", async () => {
    const w = world(2, () => []);
    const otherTopicPage = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, 9, '', 'done', ?)").run(w.doc, notesJson(9, [])).lastInsertRowid);
    const stranger = world(1, () => []);
    lessonWriter = () =>
      good(w, "", {
        slides: [
          { page_id: otherTopicPage, explanation: "same exam other topic" },
          { page_id: stranger.pages[0], explanation: "other user" },
          { page_id: w.pages[0], explanation: "mine" },
        ],
      });
    const l = await getLesson(w.topic());
    expect(l.slides.map((s) => s.page_id)).toEqual([w.pages[0]]);
  });

  it("order across two documents follows document id, then page number (not topic page_ids order)", async () => {
    const w = world(2, () => []);
    const doc2 = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L2.PDF', 'done')").run(w.examId).lastInsertRowid);
    const p2 = [2, 1].map((n) => Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, '', 'done', ?)").run(doc2, n, notesJson(n, [])).lastInsertRowid));
    // topic page_ids deliberately scrambled
    const scrambled = [p2[0], w.pages[1], p2[1], w.pages[0]];
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify(scrambled), w.topicId);
    lessonWriter = () => good(w, "", { slides: [...scrambled].reverse().map((page_id) => ({ page_id, explanation: "e" + page_id })) });
    const l = await getLesson(w.topic());
    expect(l.slides.map((s) => s.page_id)).toEqual([w.pages[0], w.pages[1], p2[1], p2[0]]);
  });

  it("a topic with an empty page list yields an empty lesson without throwing", async () => {
    const w = world(0, () => []);
    lessonWriter = () => good(w, "e", { slides: [{ page_id: 1, explanation: "x" }] });
    expect((await getLesson(w.topic())).slides).toEqual([]);
  });

  it("a writer returning null rejects and stores nothing", async () => {
    const w = world(1);
    lessonWriter = () => null;
    await expect(getLesson(w.topic())).rejects.toThrow();
    expect(w.topic().lesson_json).toBeNull();
  });

  it("huge number of slides: all kept, in order", async () => {
    const w = world(300, () => []);
    lessonWriter = () => good(w, "e");
    const l = await getLesson(w.topic());
    expect(l.slides.map((s) => s.page_id)).toEqual(w.pages);
    expect(JSON.parse(w.topic().lesson_json!).slides).toHaveLength(300);
  });

  it("markdown / HTML in an explanation is stored verbatim (rendering is the client's job)", async () => {
    const w = world(1, () => []);
    const md = "**bold** <script>alert(1)</script>\n\n- item\n\n```js\nx\n```";
    lessonWriter = () => good(w, md);
    expect((await getLesson(w.topic())).slides[0].explanation).toBe(md);
  });

  it("extra unknown fields from the writer (e.g. caption) are carried but harmless", async () => {
    const w = world(1, () => []);
    lessonWriter = () => good(w, "e", { explanation: "legacy" });
    const l = await getLesson(w.topic());
    expect(lessonText(l)).toBe("intro\n\ne");
  });
});

describe("lessonText", () => {
  it("empty intro has no leading blank lines; empty slides skipped; tolerant of missing fields", () => {
    expect(lessonText({ intro: "", slides: [{ page_id: 1, explanation: "a" }, { page_id: 2, explanation: "b" }] })).toBe("a\n\nb");
    expect(lessonText({ intro: "i", slides: [] })).toBe("i");
    expect(lessonText({ intro: "", slides: [] })).toBe("");
    expect(lessonText({ intro: "i", slides: [{ page_id: 1, explanation: "" }, { page_id: 2, explanation: "z" }] })).toBe("i\n\nz");
    expect(lessonText({} as never)).toBe("");
    expect(lessonText({ intro: "i", slides: [null, { page_id: 1 }] } as never)).toBe("i");
  });
});

describe("repair trigger", () => {
  it("a left-out slide that has facts triggers exactly one repair even when coverage is 100%", async () => {
    const w = world(2, (i) => [`alpha${i}word`]);
    lessonWriter = (n) =>
      n === 1 ? good(w, "", { intro: "alpha0word alpha1word", slides: [{ page_id: w.pages[0], explanation: "x" }] }) : good(w, "alpha0word alpha1word");
    const l = await getLesson(w.topic());
    expect(lessonCalls).toBe(2);
    expect(l.slides).toHaveLength(2);
    expect(calls.filter((c) => c.purpose === "lesson repair")).toHaveLength(1);
  });

  it("a slide whose key_facts are only whitespace may be skipped without a repair", async () => {
    const w = world(2, (i) => (i === 0 ? ["beta0word"] : ["   ", ""]));
    lessonWriter = () => good(w, "", { slides: [{ page_id: w.pages[0], explanation: "beta0word" }] });
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
  });

  it("no facts anywhere: never a repair, even with every slide left out", async () => {
    const w = world(3, () => []);
    lessonWriter = () => good(w, "", { slides: [] });
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
  });

  it("all slides covered and coverage >= 80%: no repair", async () => {
    const w = world(2, (i) => [`gamma${i}word`]);
    lessonWriter = () => good(w, "gamma0word gamma1word");
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
  });

  it("repair prompt names each left-out slide with P id, filename and slide number, and each missing fact once", async () => {
    const w = world(4, (i) => [`delta${i}word`], { filename: "Perio.pdf" });
    lessonWriter = (n) => (n === 1 ? good(w, "", { slides: [{ page_id: w.pages[1], explanation: "delta1word" }, { page_id: w.pages[3], explanation: "delta3word" }] }) : good(w, "delta0word delta1word delta2word delta3word"));
    await getLesson(w.topic());
    const p = repairPrompt();
    expect(p).toContain(`- [P${w.pages[0]}] Perio.pdf slide 1`);
    expect(p).toContain(`- [P${w.pages[2]}] Perio.pdf slide 3`);
    expect(p).not.toContain(`[P${w.pages[1]}]`);
    expect(p).not.toContain(`[P${w.pages[3]}]`);
    expect(p.match(/- delta0word/g)).toHaveLength(1);
    expect(p.match(/- delta2word/g)).toHaveLength(1);
    expect(p).not.toMatch(/- delta1word/);
  });

  it("when only coverage is low (all slides present) the prompt has no left-out-slides section", async () => {
    const w = world(1, () => Array.from({ length: 5 }, (_, i) => `eps${i}word`));
    lessonWriter = (n) => (n === 1 ? good(w, "nothing") : good(w, "eps0word eps1word eps2word eps3word eps4word"));
    await getLesson(w.topic());
    expect(repairPrompt()).not.toContain("got no entry");
    expect(repairPrompt()).toContain("- eps0word");
  });

  it("repair with equal coverage but MORE slides left out is rejected", async () => {
    const w = world(3, (i) => [`zeta${i}word`]);
    // first: slide 0 and 1 present, slide 2 missing (coverage by text 3/3 via intro)
    lessonWriter = (n) =>
      n === 1
        ? good(w, "", { intro: "zeta0word zeta1word zeta2word", slides: [{ page_id: w.pages[0], explanation: "a" }, { page_id: w.pages[1], explanation: "b" }] })
        : good(w, "", { intro: "zeta0word zeta1word zeta2word", slides: [{ page_id: w.pages[0], explanation: "FROM REPAIR" }] });
    const l = await getLesson(w.topic());
    expect(l.slides.map((s) => s.explanation)).toEqual(["a", "b"]);
  });

  it("repair with equal coverage and equal left-out is accepted", async () => {
    const w = world(2, (i) => [`eta${i}word`]);
    lessonWriter = (n) => good(w, "", { intro: "eta0word eta1word", slides: [{ page_id: w.pages[0], explanation: n === 1 ? "FIRST" : "SECOND" }] });
    const l = await getLesson(w.topic());
    expect(l.slides[0].explanation).toBe("SECOND");
  });

  it("repair with lower coverage but fewer slides left out is rejected (coverage wins)", async () => {
    const w = world(2, (i) => [`theta${i}word`, `theta${i}extra`]);
    lessonWriter = (n) =>
      n === 1
        ? good(w, "", { slides: [{ page_id: w.pages[0], explanation: "theta0word theta0extra theta1word theta1extra" }] }) // 100%, slide 1 left out
        : good(w, "theta0word"); // both slides, 25%
    const l = await getLesson(w.topic());
    expect(l.slides).toHaveLength(1);
    expect(lessonText(l)).toContain("theta1extra");
  });

  it("repair with higher coverage and fewer left out is accepted; repair with higher coverage but more left out is rejected", async () => {
    const w = world(2, (i) => [`iota${i}word`]);
    lessonWriter = (n) => (n === 1 ? good(w, "", { slides: [] }) : good(w, "iota0word iota1word"));
    expect((await getLesson(w.topic())).slides).toHaveLength(2);

    const w2 = world(3, (i) => [`kappa${i}word`]);
    lessonCalls = 0;
    lessonWriter = (n) =>
      n === 1
        ? good(w2, "", { slides: [{ page_id: w2.pages[0], explanation: "x" }, { page_id: w2.pages[1], explanation: "y" }] }) // coverage 0, 1 left out
        : good(w2, "", { slides: [{ page_id: w2.pages[0], explanation: "kappa0word kappa1word kappa2word" }] }); // coverage 100%, 2 left out
    const l = await getLesson(w2.topic());
    expect(l.slides.map((s) => s.explanation)).toEqual(["x", "y"]);
  });

  it("a throwing repair keeps the first lesson, stored as v3", async () => {
    const w = world(2, (i) => [`lambda${i}word`]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    lessonWriter = (n) => {
      if (n === 2) throw new Error("repair down");
      return good(w, "", { slides: [{ page_id: w.pages[0], explanation: "FIRST" }] });
    };
    const l = await getLesson(w.topic());
    err.mockRestore();
    expect(l.slides[0].explanation).toBe("FIRST");
    expect(JSON.parse(w.topic().lesson_json!).version).toBe(3);
  });

  it("a repair returning garbage (slides not an array) is tidied and rejected, first lesson kept", async () => {
    const w = world(2, (i) => [`mu${i}word`]);
    lessonWriter = (n) => (n === 1 ? good(w, "", { slides: [{ page_id: w.pages[0], explanation: "FIRST mu0word mu1word" }] }) : { intro: "", slides: "garbage" });
    const l = await getLesson(w.topic());
    expect(l.slides[0].explanation).toMatch(/^FIRST/);
  });

  it("a left-out slide whose only fact has no significant stem (punctuation) needs no entry while others have facts", async () => {
    const w = world(2, (i) => (i === 0 ? ["nu0word"] : ["?!"]));
    lessonWriter = () => good(w, "", { slides: [{ page_id: w.pages[0], explanation: "nu0word" }] });
    await getLesson(w.topic());
    // A fact with no letters/digits is not a real fact; skipping its slide should not cost a repair call.
    expect(lessonCalls).toBe(1);
  });

  it("only ever one repair, even if the repair is still bad", async () => {
    const w = world(2, (i) => [`xi${i}word`]);
    lessonWriter = () => good(w, "", { slides: [] });
    await getLesson(w.topic());
    expect(lessonCalls).toBe(2);
  });
});

describe("repair trigger: question slides and fillers", () => {
  const setNotes = (pageId: number, patch: object) => {
    const row = db.prepare("SELECT notes_json FROM pages WHERE id = ?").get(pageId) as { notes_json: string };
    db.prepare("UPDATE pages SET notes_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.notes_json), ...patch }), pageId);
  };

  it("a slide with a case_prompt but no facts that gets no entry triggers the repair, naming it", async () => {
    const w = world(2, (i) => (i === 0 ? ["omicron0word"] : []));
    setNotes(w.pages[1], { case_prompt: "What is the diagnosis?" });
    lessonWriter = (n) => good(w, "", { slides: n === 1 ? [{ page_id: w.pages[0], explanation: "omicron0word" }] : w.pages.map((page_id) => ({ page_id, explanation: "omicron0word" })) });
    const l = await getLesson(w.topic());
    expect(lessonCalls).toBe(2);
    expect(repairPrompt()).toContain("These slides have facts or a question but got no entry");
    expect(repairPrompt()).toContain(`- [P${w.pages[1]}] L1.pdf slide 2`);
    expect(l.slides).toHaveLength(2);
  });

  it("repair fires for a left-out question slide even when no slide has any fact", async () => {
    const w = world(2, () => []);
    setNotes(w.pages[0], { case_prompt: "Which drug?" });
    lessonWriter = (n) => good(w, "", { slides: n === 1 ? [] : [{ page_id: w.pages[0], explanation: "answer" }] });
    const l = await getLesson(w.topic());
    expect(lessonCalls).toBe(2);
    expect(l.slides).toHaveLength(1);
  });

  it("a whitespace-only case_prompt does not require an entry", async () => {
    const w = world(1, () => []);
    setNotes(w.pages[0], { case_prompt: "   " });
    lessonWriter = () => good(w, "", { slides: [] });
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
  });

  it("a slide flagged is_filler is never required, even with facts or a case prompt; other facts still count", async () => {
    const w = world(2, () => ["pi0word"]);
    setNotes(w.pages[0], { is_filler: true, case_prompt: "Q?" });
    lessonWriter = () => good(w, "", { slides: [{ page_id: w.pages[1], explanation: "pi0word" }] });
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
  });

  it("a left-out question slide: repair that still leaves it out is accepted only if not worse; first lesson kept when repair leaves out more", async () => {
    const w = world(2, () => []);
    setNotes(w.pages[0], { case_prompt: "A?" });
    setNotes(w.pages[1], { case_prompt: "B?" });
    lessonWriter = (n) => good(w, "", { slides: n === 1 ? [{ page_id: w.pages[0], explanation: "FIRST" }] : [] });
    expect((await getLesson(w.topic())).slides[0].explanation).toBe("FIRST");
  });
});

describe("versions and migration", () => {
  it("a stored v2 lesson (old shape with explanation) is rewritten on open, v3 afterwards", async () => {
    const w = world(1);
    stored(w, { explanation: "OLD", key_points: [], slides: [{ page_id: w.pages[0], caption: "c" }], connections: null, version: 2 });
    expect(lessonIsCurrent(w.topic())).toBe(false);
    lessonWriter = () => good(w, "fact a0 fact b0");
    const l = await getLesson(w.topic());
    expect(l.slides[0].explanation).toBe("fact a0 fact b0");
    expect(l.version).toBe(3);
    expect("explanation" in JSON.parse(w.topic().lesson_json!)).toBe(false);
  });

  it("a stored unversioned (v1) lesson is rewritten too", async () => {
    const w = world(1, () => []);
    stored(w, { explanation: "OLD", key_points: [], slides: [], connections: null });
    lessonWriter = () => good(w, "new");
    expect((await getLesson(w.topic())).version).toBe(3);
  });

  it("a stored v3 lesson is served without any AI call, and via the route too", async () => {
    const w = world(2);
    currentUserId = w.userId;
    stored(w, { intro: "I", slides: [{ page_id: w.pages[0], explanation: "e0" }], key_points: ["k"], connections: null, version: 3 });
    const l = await getLesson(w.topic());
    expect(l.intro).toBe("I");
    const res = await getRoute(w);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.purpose.startsWith("lesson"))).toHaveLength(0);
  });

  it("a stored v3 lesson referencing removed pages still loads through the route (no throw); the stale slide is left out, slideInfo lacks its id", async () => {
    const w = world(2);
    currentUserId = w.userId;
    const gone = 987654;
    stored(w, { intro: "I", slides: [{ page_id: gone, explanation: "stale" }, { page_id: w.pages[0], explanation: "e0" }], key_points: [], connections: null, version: 3 });
    const res = await getRoute(w);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slideInfo[gone]).toBeUndefined();
    expect(body.lesson.slides.map((s: { page_id: number }) => s.page_id)).toEqual([w.pages[0]]);
    expect(Object.keys(body.slideInfo)).toHaveLength(2);
  });

  it("a stored v3 lesson that references a page belonging to someone else: the route leaves that slide out", async () => {
    const w = world(1);
    currentUserId = w.userId;
    const stranger = world(1);
    stored(w, { intro: "I", slides: [{ page_id: stranger.pages[0], explanation: "foreign" }], key_points: [], connections: null, version: 3 });
    const body = await (await getRoute(w)).json();
    expect(body.lesson.slides.every((s: { page_id: number }) => w.pages.includes(s.page_id))).toBe(true);
  });

  it("a stored v3 lesson with a new page added to the topic since: still served as is (documented limitation)", async () => {
    const w = world(1);
    stored(w, { intro: "I", slides: [{ page_id: w.pages[0], explanation: "e0" }], key_points: [], connections: null, version: 3 });
    const extra = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, 2, '', 'done', ?)").run(w.doc, notesJson(2, ["f"])).lastInsertRowid);
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([...w.pages, extra]), w.topicId);
    const l = await getLesson(w.topic());
    expect(l.slides).toHaveLength(1);
    expect(lessonCalls).toBe(0);
  });
});

describe("lesson route", () => {
  it("slideInfo and aspects include every page of the topic, lecture strips .pdf case-insensitively, emphasized is boolean", async () => {
    const w = world(3, () => [], { filename: "Endo Lecture.PDF", starred: [1] });
    currentUserId = w.userId;
    lessonWriter = () => good(w, "e"); // only needs writing once
    const doc2 = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'notes.pdf.pdf', 'done')").run(w.examId).lastInsertRowid);
    const p4 = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, aspect) VALUES (?, 7, '', 'done', ?, 0.75)").run(doc2, notesJson(7, [])).lastInsertRowid);
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([...w.pages, p4]), w.topicId);
    const body = await (await getRoute(w)).json();
    const all = [...w.pages, p4];
    expect(Object.keys(body.aspects).map(Number).sort()).toEqual([...all].sort());
    expect(Object.keys(body.slideInfo).map(Number).sort()).toEqual([...all].sort());
    expect(body.slideInfo[w.pages[0]]).toEqual({ number: 1, lecture: "Endo Lecture", emphasized: false });
    expect(body.slideInfo[w.pages[1]].emphasized).toBe(true);
    expect(body.slideInfo[p4]).toEqual({ number: 7, lecture: "notes.pdf", emphasized: false });
    expect(body.aspects[p4]).toBe(0.75);
    expect(body.aspects[w.pages[0]]).toBe(1.5);
    for (const id of all) expect(typeof body.slideInfo[id].emphasized).toBe("boolean");
  });

  it("a filename merely containing 'pdf' in the middle is untouched", async () => {
    const w = world(1, () => [], { filename: "my.pdf.notes.PdF" });
    currentUserId = w.userId;
    lessonWriter = () => good(w, "e");
    const body = await (await getRoute(w)).json();
    expect(body.slideInfo[w.pages[0]].lecture).toBe("my.pdf.notes");
  });

  it("lesson slides in the response are in slide order and the response has intro", async () => {
    const w = world(3, () => []);
    currentUserId = w.userId;
    lessonWriter = () => good(w, "", { intro: "Hello", slides: [...w.pages].reverse().map((page_id) => ({ page_id, explanation: "e" })) });
    const body = await (await getRoute(w)).json();
    expect(body.lesson.intro).toBe("Hello");
    expect(body.lesson.slides.map((s: { page_id: number }) => s.page_id)).toEqual(w.pages);
    expect(body.stressed).toEqual([]);
  });

  it("a topic with no pages returns empty aspects/slideInfo", async () => {
    const w = world(0, () => []);
    currentUserId = w.userId;
    lessonWriter = () => good(w, "e");
    const body = await (await getRoute(w)).json();
    expect(body.aspects).toEqual({});
    expect(body.slideInfo).toEqual({});
    expect(body.lesson.slides).toEqual([]);
  });

  it("a prefetch doesn't mark the topic studied or move the session; a real open does", async () => {
    const w = world(1);
    currentUserId = w.userId;
    lessonWriter = () => good(w, "fact a0 fact b0");
    db.prepare("UPDATE study_sessions SET current_position = 5 WHERE id = ?").run(w.sessionId);
    expect((await getRoute(w, "position=0&prefetch=1")).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) c FROM topic_study WHERE topic_id = ?").get(w.topicId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(w.sessionId)).toEqual({ p: 5 });
    expect(calls.some((c) => c.purpose === "section quiz")).toBe(false);
    await getRoute(w);
    expect(db.prepare("SELECT COUNT(*) c FROM topic_study WHERE topic_id = ?").get(w.topicId)).toEqual({ c: 1 });
    expect(db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(w.sessionId)).toEqual({ p: 0 });
  });

  it("401 without a user, 404 for another user's session, 404 for a missing topic position", async () => {
    const w = world(1);
    currentUserId = 0;
    expect((await getRoute(w)).status).toBe(401);
    currentUserId = makeUser();
    expect((await getRoute(w)).status).toBe(404);
    currentUserId = w.userId;
    expect((await getRoute(w, "position=9")).status).toBe(404);
  });

  it("a failing writer gives a 500 with a plain message", async () => {
    const w = world(1);
    currentUserId = w.userId;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    lessonWriter = () => {
      throw new Error("boom internal");
    };
    const res = await getRoute(w);
    err.mockRestore();
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("internal");
  });
});

describe("class copy", () => {
  function share(w: World) {
    const b = makeUser();
    const cls = createClass(w.userId, "C" + w.examId);
    joinClass(b, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(cls) as { invite_code: string }).invite_code);
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    expect(shareExam(w.userId, cls, w.examId)).toBeNull();
    const res = addSharedExam(b, (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(w.examId) as { id: number }).id) as { examId: number };
    const copy = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(res.examId) as Topic;
    const copyPages = (db.prepare("SELECT p.id FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ? ORDER BY d.id, p.page_number").all(res.examId) as { id: number }[]).map((r) => r.id);
    return { b, res, copy, copyPages };
  }

  it("copied v3 lesson: slides point at the copy's page ids, version and intro preserved, texts unchanged", () => {
    const w = world(3);
    stored(w, { intro: "INTRO", slides: w.pages.map((page_id, i) => ({ page_id, explanation: `e${i}` })), key_points: ["k1"], connections: "conn", version: 3 });
    const { copy, copyPages } = share(w);
    const l = JSON.parse(copy.lesson_json!);
    expect(l.slides.map((s: { page_id: number }) => s.page_id)).toEqual(copyPages);
    expect(l.slides.map((s: { explanation: string }) => s.explanation)).toEqual(["e0", "e1", "e2"]);
    expect(l.intro).toBe("INTRO");
    expect(l.version).toBe(3);
    expect(l.connections).toBe("conn");
    expect(l.key_points).toEqual(["k1"]);
    expect(lessonIsCurrent(copy)).toBe(true);
    expect(copyPages.some((id) => w.pages.includes(id))).toBe(false);
  });

  it("the copied lesson loads through the route for the classmate without an AI call, slideInfo covering its slides", async () => {
    const w = world(2);
    stored(w, { intro: "INTRO", slides: w.pages.map((page_id) => ({ page_id, explanation: "e" })), key_points: [], connections: null, version: 3 });
    const { b, res, copyPages } = share(w);
    currentUserId = b;
    const sid = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(res.examId).lastInsertRowid);
    const body = await (await lessonGET(new Request("http://x/l?position=0"), ctx(sid))).json();
    expect(calls.filter((c) => c.purpose.startsWith("lesson"))).toHaveLength(0);
    for (const s of body.lesson.slides) expect(body.slideInfo[s.page_id]).toBeDefined();
    expect(body.lesson.slides.map((s: { page_id: number }) => s.page_id)).toEqual(copyPages);
  });

  it("a topic without a stored lesson copies with null lesson_json", () => {
    const w = world(1);
    expect(share(w).copy.lesson_json).toBeNull();
  });

  it("a stored old-shape v2 lesson (no intro) copies without throwing and is still rewritten on the classmate's open", async () => {
    const w = world(1);
    stored(w, { explanation: "OLD", key_points: [], slides: [{ page_id: w.pages[0], caption: "c" }], connections: null, version: 2 });
    const { copy } = share(w);
    expect(lessonIsCurrent(copy)).toBe(false);
  });

  it("a lesson slide whose page wasn't copied (lecture not 'done') is left out of the classmate's lesson", () => {
    const w = world(1);
    const failedDoc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'bad.pdf', 'error')").run(w.examId).lastInsertRowid);
    const badPage = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, 1, '', 'done', ?)").run(failedDoc, notesJson(1, ["f"])).lastInsertRowid);
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([w.pages[0], badPage]), w.topicId);
    stored(w, { intro: "I", slides: [{ page_id: w.pages[0], explanation: "a" }, { page_id: badPage, explanation: "b" }], key_points: [], connections: null, version: 3 });
    const { copy, copyPages } = share(w);
    const l = JSON.parse(copy.lesson_json!);
    expect(l.slides.every((s: { page_id: number }) => copyPages.includes(s.page_id))).toBe(true);
  });
});

describe("concurrency", () => {
  it("concurrent getLesson calls share one generation (new shape), later calls hit the stored lesson", async () => {
    const w = world(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    lessonWriter = async () => {
      await gate;
      return good(w, "fact a0 fact b0 fact a1 fact b1");
    };
    const ps = [getLesson(w.topic()), getLesson(w.topic()), getLesson(w.topic())];
    release();
    const [a, b, c] = await Promise.all(ps);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(lessonCalls).toBe(1);
    await getLesson(w.topic());
    expect(lessonCalls).toBe(1);
  });

  it("after a failed generation a retry generates again", async () => {
    const w = world(1, () => []);
    lessonWriter = (n) => {
      if (n === 1) throw new Error("down");
      return good(w, "e");
    };
    await expect(getLesson(w.topic())).rejects.toThrow();
    expect((await getLesson(w.topic())).slides).toHaveLength(1);
  });
});
