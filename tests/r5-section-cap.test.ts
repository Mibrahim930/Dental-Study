// A lecture has at most MAX_SECTIONS (10) sections. The AI is told so; when it over-splits anyway, neighbouring
// sections are joined (fewest slides first) so the lecture still fits, every slide stays, and slide order holds.
import { beforeEach, describe, expect, it, vi } from "vitest";

type AiTopic = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[] };
let reply: (content: string) => { topics: AiTopic[] } = () => ({ topics: [] });
const prompts: { system: string; content: string }[] = [];
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string; system: string }) => {
    if (opts.purpose !== "topic map") throw new Error("unexpected " + opts.purpose);
    prompts.push({ system: opts.system, content: opts.content });
    return reply(opts.content);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, type Topic } from "@/lib/db";
import { buildTopicMap } from "@/lib/topics";
import { capSections, MAX_SECTIONS } from "@/lib/topicMerge";
import { makeUser } from "./helpers";

const notes = (title: string) =>
  JSON.stringify({
    title,
    summary: `about ${title}`,
    image_description: null,
    key_facts: ["fact"],
    annotations: [],
    emphasized: false,
    emphasis_note: null,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: ["c"],
    is_filler: false,
  });

function lecture(examId: number, name: string, n: number) {
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, 'done', ?)").run(examId, name, n).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, ?, 'done', ?)")
        .run(doc, i + 1, `doc-${doc}/p${i + 1}.jpg`, notes(`${name} s${i + 1}`)).lastInsertRowid,
    ),
  );
  return { doc, pages };
}
const sec = (title: string, page_ids: number[], extra: Partial<AiTopic> = {}): AiTopic => ({ title, summary: `${title} summary.`, page_ids, emphasized: false, concepts: [`${title} concept`], ...extra });
const idsIn = (content: string) => [...content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
const topics = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
const pagesOf = (x: Topic) => JSON.parse(x.page_ids) as number[];
/** The AI splits the slides it was sent into runs of `size`. */
const chunked = (size: number) => (content: string) => {
  const ids = idsIn(content);
  const out: AiTopic[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(sec(`S${i / size + 1}`, ids.slice(i, i + size)));
  return { topics: out };
};
function exam() {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  return { userId, examId };
}

beforeEach(() => {
  prompts.length = 0;
  reply = chunked(3);
});

describe("capSections", () => {
  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

  it("the limit is 10", () => {
    expect(MAX_SECTIONS).toBe(10);
  });

  it("ten or fewer sections come back untouched (same objects' content, same order)", () => {
    const s = ids(10).map((i) => sec(`T${i}`, [i]));
    expect(capSections(s)).toEqual(s);
    expect(capSections(s.slice(0, 3))).toEqual(s.slice(0, 3));
    expect(capSections([])).toEqual([]);
  });

  it("joins the neighbouring pair with the fewest slides until there are 10; slides run on in order, nothing lost", () => {
    // 12 sections: sizes 4,4,1,1,4,4,4,4,4,4,1,2  → the (1,1) pair joins first, then the smallest pair left: (1,2)
    const sizes = [4, 4, 1, 1, 4, 4, 4, 4, 4, 4, 1, 2];
    let next = 1;
    const s = sizes.map((n, i) => {
      const p = ids(n, next);
      next += n;
      return sec(`T${i + 1}`, p);
    });
    const out = capSections(s);
    expect(out).toHaveLength(10);
    expect(out.map((x) => x.page_ids.length)).toEqual([4, 4, 2, 4, 4, 4, 4, 4, 4, 3]);
    expect(out.flatMap((x) => x.page_ids)).toEqual(ids(next - 1));
    expect(out[2]).toMatchObject({ title: "T3 & T4", summary: "T3 summary. T4 summary.", concepts: ["T3 concept", "T4 concept"] });
    expect(out[9].title).toBe("T11 & T12");
  });

  it("a joined section is emphasized if either half was, pools concepts without repeats, and can join again", () => {
    const s = [sec("A", [1], { emphasized: true, concepts: ["x", "y"] }), sec("B", [2], { concepts: ["y", "z"] }), sec("C", [3], { summary: " " }), sec("D", [4])];
    const out = capSections(s, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "A & B & C & D", page_ids: [1, 2, 3, 4], emphasized: true, concepts: ["x", "y", "z", "C concept", "D concept"] });
    expect(out[0].summary).toBe("A summary. B summary. D summary.");
    // the input is not changed
    expect(s.map((x) => x.title)).toEqual(["A", "B", "C", "D"]);
  });

  it("a limit under 1 still leaves one section", () => {
    expect(capSections([sec("A", [1]), sec("B", [2])], 0)).toHaveLength(1);
  });

  it("ties go to the earliest pair (a long run of equal sections joins from the front)", () => {
    const out = capSections(
      ids(12).map((i) => sec(`T${i}`, [i])),
      10,
    );
    expect(out.map((x) => x.title)).toEqual(["T1 & T2", "T3 & T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"]);
  });
});

describe("the topic map keeps a lecture to 10 sections", () => {
  it("tells the AI the limit", async () => {
    const w = exam();
    lecture(w.examId, "L.pdf", 4);
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].system).toMatch(/At most 10 sections per lecture/);
  });

  it("an AI that returns 15 sections for a 45-slide lecture is stored as 10, every slide kept in slide order", async () => {
    const w = exam();
    const l = lecture(w.examId, "Long.pdf", 45);
    reply = chunked(3); // 15 sections of 3
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts).toHaveLength(10);
    expect(ts.flatMap(pagesOf)).toEqual(l.pages);
    expect(ts.map((t) => pagesOf(t).length)).toEqual([6, 6, 6, 6, 6, 3, 3, 3, 3, 3]);
    expect(ts.map((t) => t.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ts[0].title).toBe("S1 & S2");
    expect(ts.every((t) => t.document_id === l.doc)).toBe(true);
  });

  it("each lecture is capped on its own: two over-split lectures give 10 + 10, in lecture order", async () => {
    const w = exam();
    const a = lecture(w.examId, "A.pdf", 24);
    const b = lecture(w.examId, "B.pdf", 12);
    reply = chunked(1); // one slide per section: 24 and 12 sections
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts.filter((t) => t.document_id === a.doc)).toHaveLength(10);
    expect(ts.filter((t) => t.document_id === b.doc)).toHaveLength(10);
    expect(ts.flatMap(pagesOf)).toEqual([...a.pages, ...b.pages]);
  });

  it("a Rebuild is capped too, and a section that keeps the same slides keeps its id and lesson", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 36);
    reply = chunked(3); // 12 → 10 (the two front pairs join)
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    expect(before).toHaveLength(10);
    db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify({ intro: "kept" }), before[9].id);
    reply = chunked(3);
    await buildTopicMap(w.examId, "full");
    const after = topics(w.examId);
    expect(after).toHaveLength(10);
    expect(after.flatMap(pagesOf)).toEqual(l.pages);
    expect(after[9].id).toBe(before[9].id);
    expect(after[9].lesson_json).toBe(JSON.stringify({ intro: "kept" }));
  });

  it("a new lecture added to a mapped exam is capped as well; the old lecture is untouched", async () => {
    const w = exam();
    const a = lecture(w.examId, "A.pdf", 6);
    reply = chunked(3);
    await buildTopicMap(w.examId);
    const first = topics(w.examId).map((t) => t.id);
    expect(first).toHaveLength(2);
    const b = lecture(w.examId, "B.pdf", 30);
    reply = chunked(2); // 15 sections
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts.slice(0, 2).map((t) => t.id)).toEqual(first);
    expect(ts.slice(2)).toHaveLength(10);
    expect(ts.slice(2).flatMap(pagesOf)).toEqual(b.pages);
    expect(ts.slice(2).every((t) => t.document_id === b.doc)).toBe(true);
    expect(ts.slice(0, 2).flatMap(pagesOf)).toEqual(a.pages);
  });
});
