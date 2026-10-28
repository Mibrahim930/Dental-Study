// QA attack tests for the 10-sections-per-lecture cap (capSections in topicMerge.ts, mapLecture in topics.ts).
// "BUG:" tests failed because of a real defect when written (see the comment above each; "fixed:" once it was); "(documented)" tests pin behaviour that is odd
// but acceptable; everything else must pass.
import { beforeEach, describe, expect, it, vi } from "vitest";

type AiTopic = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[] };
let reply: (content: string) => { topics: AiTopic[] } = () => ({ topics: [] });
/** Milliseconds the AI takes for a call (lets a later lecture finish before an earlier one). */
let lag: (content: string) => number = () => 0;
const prompts: { system: string; content: string }[] = [];
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string; system: string }) => {
    if (opts.purpose !== "topic map") throw new Error("unexpected " + opts.purpose);
    prompts.push({ system: opts.system, content: opts.content });
    const ms = lag(opts.content);
    if (ms) await new Promise((r) => setTimeout(r, ms));
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

const notes = (title: string, filler = false) =>
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
    is_filler: filler,
  });

/** A read lecture of `n` slides; `filler` lists 1-based slide numbers that are title/agenda slides. */
function lecture(examId: number, name: string, n: number, filler: number[] = []) {
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, 'done', ?)").run(examId, name, n).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, ?, 'done', ?)")
        .run(doc, i + 1, `doc-${doc}/p${i + 1}.jpg`, notes(`${name} s${i + 1}`, filler.includes(i + 1))).lastInsertRowid,
    ),
  );
  return { doc, pages };
}
const sec = (title: string, page_ids: number[], extra: Partial<AiTopic> = {}): AiTopic => ({ title, summary: `${title} summary.`, page_ids, emphasized: false, concepts: [`${title} concept`], ...extra });
const idsIn = (content: string) => [...content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
const topics = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
const pagesOf = (x: Topic) => JSON.parse(x.page_ids) as number[];
const status = (examId: number) => db.prepare("SELECT topic_status, topic_error FROM exams WHERE id = ?").get(examId) as { topic_status: string; topic_error: string | null };
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
/** A topic written straight to the database, the way an older (pre-cap) build would have left it. */
function seedTopic(examId: number, position: number, title: string, page_ids: number[], document_id: number, lesson: string | null = "L") {
  return Number(
    db
      .prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, document_id, lesson_json, checks_json, checks_version) VALUES (?, ?, ?, 's', ?, ?, ?, '[]', 2)")
      .run(examId, position, title, JSON.stringify(page_ids), document_id, lesson).lastInsertRowid,
  );
}
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const ascending = (a: number[]) => a.every((x, i) => i === 0 || a[i - 1] < x);

beforeEach(() => {
  prompts.length = 0;
  reply = chunked(3);
  lag = () => 0;
});

describe("capSections: edge cases", () => {
  it("ten sections come back equal but as a new array of new objects; eleven become ten; one hundred become ten", () => {
    const ten = ids(10).map((i) => sec(`T${i}`, [i]));
    const same = capSections(ten);
    expect(same).toEqual(ten);
    expect(same).not.toBe(ten);
    expect(same[0]).not.toBe(ten[0]);
    const eleven = capSections(ids(11).map((i) => sec(`T${i}`, [i])));
    expect(eleven).toHaveLength(10);
    expect(eleven.map((x) => x.page_ids)).toEqual([[1, 2], [3], [4], [5], [6], [7], [8], [9], [10], [11]]);
    expect(capSections(ids(100).map((i) => sec(`T${i}`, [i])))).toHaveLength(10);
  });

  it("200 single-slide sections give 10 sections holding every slide once, in order, none more than twice as big as another", () => {
    const out = capSections(ids(200).map((i) => sec(`T${i}`, [i])));
    expect(out).toHaveLength(10);
    expect(out.flatMap((x) => x.page_ids)).toEqual(ids(200));
    const sizes = out.map((x) => x.page_ids.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(200);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2 * Math.min(...sizes));
    // every original title sits in exactly one joined title, in the original order
    expect(out.flatMap((x) => x.title.split(" & "))).toEqual(ids(200).map((i) => `T${i}`));
  });

  it("(documented) a 200-section input ends with very long joined titles and summaries (no length limit)", () => {
    const out = capSections(ids(200).map((i) => sec(`Topic number ${i}`, [i])));
    // 32 titles in the biggest section: well over 400 characters in a single section title
    const longest = Math.max(...out.map((x) => x.title.length));
    expect(longest).toBeGreaterThan(400);
    expect(Math.max(...out.map((x) => x.summary.length))).toBeGreaterThan(400);
  });

  it("max = 1 joins everything into one section; max = 0 or negative behave like 1", () => {
    const s = ids(5).map((i) => sec(`T${i}`, [i]));
    for (const max of [1, 0, -4]) {
      const out = capSections(s, max);
      expect(out).toHaveLength(1);
      expect(out[0].page_ids).toEqual(ids(5));
      expect(out[0].title).toBe("T1 & T2 & T3 & T4 & T5");
    }
  });

  it("max larger than the length (or Infinity) changes nothing; a fractional max rounds down in effect", () => {
    const s = ids(4).map((i) => sec(`T${i}`, [i]));
    expect(capSections(s, 99)).toEqual(s);
    expect(capSections(s, Infinity)).toEqual(s);
    expect(capSections(s, 2.5)).toHaveLength(2);
  });

  it("max = NaN falls back to the default limit", () => {
    const s = ids(12).map((i) => sec(`T${i}`, [i]));
    expect(capSections(s, NaN)).toHaveLength(10);
  });

  it("an empty list and a single section pass through", () => {
    expect(capSections([])).toEqual([]);
    const one = [sec("A", [1, 2])];
    expect(capSections(one)).toEqual(one);
    expect(capSections(one, 1)).toEqual(one);
  });

  it("(documented) duplicate titles are simply joined: 'A & A'", () => {
    const out = capSections([sec("A", [1], { summary: "same" }), sec("A", [2], { summary: "same" })], 1);
    expect(out[0].title).toBe("A & A");
    expect(out[0].summary).toBe("same same");
  });

  it("(documented) empty titles leave dangling ' & ' separators; blank summaries are dropped without a stray space", () => {
    const blank = capSections([sec("", [1], { summary: "" }), sec("", [2], { summary: "  " })], 1);
    expect(blank[0].title).toBe(" & ");
    expect(blank[0].summary).toBe("");
    const half = capSections([sec("A", [1], { summary: "" }), sec("", [2], { summary: "two." })], 1);
    expect(half[0].title).toBe("A & ");
    expect(half[0].summary).toBe("two.");
  });

  it("(documented) titles and summaries are trimmed only when sections are joined; untouched sections keep their spacing", () => {
    const s = ids(11).map((i) => sec(i <= 2 ? ` T${i} ` : `  T${i}  `, [i], { summary: ` sum${i} ` }));
    const out = capSections(s);
    expect(out[0].title).toBe("T1 & T2");
    expect(out[0].summary).toBe("sum1 sum2");
    expect(out[1].title).toBe("  T3  ");
    expect(out[1].summary).toBe(" sum3 ");
  });

  it("(documented) sections with zero slides are joined first (their pair has the fewest slides) and vanish into a neighbour", () => {
    // 11 sections; the 6th holds no slides. The pair (5th, 6th) sums to 1, as does (6th, 7th); the earlier one wins.
    const s = ids(11).map((i) => sec(`T${i}`, i === 6 ? [] : [i]));
    const out = capSections(s);
    expect(out).toHaveLength(10);
    expect(out[4]).toMatchObject({ title: "T5 & T6", page_ids: [5] });
    expect(out.flatMap((x) => x.page_ids)).toEqual(ids(11).filter((i) => i !== 6));
    // all-empty input still ends with the limit, and nothing throws
    expect(capSections(ids(15).map((i) => sec(`E${i}`, [])))).toHaveLength(10);
    expect(capSections([sec("A", []), sec("B", [])], 1)[0].page_ids).toEqual([]);
  });

  it("extra fields survive on every section that is not joined, and a joined section keeps the first half's extras", () => {
    type Extra = ReturnType<typeof sec> & { document_id: number; tag: string; nested: { x: number } };
    const s: Extra[] = ids(11).map((i) => ({ ...sec(`T${i}`, [i]), document_id: 7, tag: `tag${i}`, nested: { x: i } }));
    const out = capSections(s);
    expect(out).toHaveLength(10);
    for (const o of out) expect(o.document_id).toBe(7);
    expect(out.map((o) => o.tag)).toEqual(["tag1", ...ids(9, 3).map((i) => `tag${i}`)]);
    expect(out[0].nested).toEqual({ x: 1 });
    expect(out[5].nested).toEqual({ x: 7 });
  });

  it("(documented) the second half's extra fields are dropped when two sections join", () => {
    const out = capSections([{ ...sec("A", [1]), note: "from A" }, { ...sec("B", [2]), note: "from B", only: "b" }], 1) as (ReturnType<typeof sec> & { note: string; only?: string })[];
    expect(out[0].note).toBe("from A");
    expect(out[0].only).toBeUndefined();
  });

  it("the input array and its objects and their arrays are not changed", () => {
    const s = [
      sec("A", [1, 2], { emphasized: true, concepts: ["x", "y"] }),
      sec("B", [3], { concepts: ["y", "z"] }),
      ...ids(10, 4).map((i) => sec(`T${i}`, [i])),
    ];
    const before = structuredClone(s);
    const snapshotArrays = s.map((x) => [x.page_ids, x.concepts]);
    const out = capSections(s);
    expect(out).toHaveLength(10);
    expect(s).toEqual(before);
    expect(s.map((x) => [x.page_ids, x.concepts])).toEqual(snapshotArrays);
    s.forEach((x, i) => {
      expect(x.page_ids).toBe(snapshotArrays[i][0]);
      expect(x.concepts).toBe(snapshotArrays[i][1]);
    });
    // calling it again gives the same answer
    expect(capSections(s)).toEqual(out);
  });

  it("(documented) sections that are not joined share their page_ids and concepts arrays with the input (a shallow copy)", () => {
    const s = ids(11).map((i) => sec(`T${i}`, [i]));
    const out = capSections(s);
    expect(out[5].page_ids).toBe(s[6].page_ids);
    expect(out[0].page_ids).not.toBe(s[0].page_ids); // a joined one is new
  });

  it("concepts: pooled without repeats, first-seen order, blanks are carried along (documented: a blank concept survives the pool)", () => {
    const out = capSections([sec("A", [1], { concepts: ["", "x", " "] }), sec("B", [2], { concepts: ["x", "", "y", "y"] })], 1);
    expect(out[0].concepts).toEqual(["", "x", " ", "y"]);
    // two sections with no concepts at all
    expect(capSections([sec("A", [1], { concepts: [] }), sec("B", [2], { concepts: [] })], 1)[0].concepts).toEqual([]);
  });

  it("(documented) concepts that differ only by case or surrounding spaces are not treated as the same in the pool", () => {
    const out = capSections([sec("A", [1], { concepts: ["Pulpitis"] }), sec("B", [2], { concepts: ["pulpitis", "Pulpitis "] })], 1);
    expect(out[0].concepts).toEqual(["Pulpitis", "pulpitis", "Pulpitis "]);
  });

  it("emphasized is true when either half was, and stays false when both were false", () => {
    expect(capSections([sec("A", [1]), sec("B", [2], { emphasized: true })], 1)[0].emphasized).toBe(true);
    expect(capSections([sec("A", [1], { emphasized: true }), sec("B", [2])], 1)[0].emphasized).toBe(true);
    expect(capSections([sec("A", [1]), sec("B", [2])], 1)[0].emphasized).toBe(false);
  });

  it("the fewest-slides pair is chosen even at the very start and the very end of the list", () => {
    const front = capSections([sec("A", [1]), sec("B", [2]), sec("C", [3, 4, 5]), sec("D", [6, 7, 8])], 3);
    expect(front.map((x) => x.title)).toEqual(["A & B", "C", "D"]);
    const back = capSections([sec("A", [1, 2, 3]), sec("B", [4, 5, 6]), sec("C", [7]), sec("D", [8])], 3);
    expect(back.map((x) => x.title)).toEqual(["A", "B", "C & D"]);
  });

  it("property: for 300 random contiguous inputs the result has min(n, max) sections, every slide once and in order, every title once", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const n = 1 + rnd(60);
      const max = 1 + rnd(12);
      let next = 1;
      const s = Array.from({ length: n }, (_, i) => {
        const size = rnd(8) === 0 ? 0 : 1 + rnd(6);
        const p = ids(size, next);
        next += size;
        return sec(`T${i + 1}`, p);
      });
      const out = capSections(s, max);
      expect(out).toHaveLength(Math.min(n, max));
      expect(out.flatMap((x) => x.page_ids)).toEqual(ids(next - 1));
      expect(out.flatMap((x) => x.title.split(" & "))).toEqual(s.map((x) => x.title));
      for (const o of out) expect(ascending(o.page_ids)).toBe(true);
    }
  });

  // INPUT: three sections an AI can legitimately produce after cleanTopics + inSlideOrder, where one section has a
  //   slide inside another one's range: A = [1,4], B = [2,3] (A comes first because its first slide is 1), max = 1.
  // WRONG OUTPUT: capSections gives page_ids [1,4,2,3]; the slides of a section must be in slide order
  //   ([1,2,3,4]), as inSlideOrder() just made them (topics.ts mapLecture doc comment, SYSTEM prompt, TopicFields).
  // SRC: topicMerge.ts line 77, `page_ids: [...a.page_ids, ...b.page_ids]` (a plain concatenation; it only stays in
  //   slide order when the two sections are runs of neighbouring slides, which cleanTopics does not guarantee).
  it("fixed: joining two sections whose slides interleave keeps the joined section's slides in slide order", () => {
    const out = capSections([sec("A", [1, 4]), sec("B", [2, 3])], 1);
    expect(out[0].page_ids).toEqual([1, 2, 3, 4]);
  });
});

describe("the cap through buildTopicMap", () => {
  // INPUT: a 22-slide lecture; the AI returns 11 sections, the first two interleaved: [1,4], [2,3], then pairs [5,6]...[21,22].
  //   cleanTopics keeps them as they are, inSlideOrder sorts each section's slides, capSections joins the first two.
  // WRONG OUTPUT: the stored first section has page_ids [1,4,2,3] instead of [1,2,3,4].
  // SRC: topicMerge.ts line 77 (see the capSections BUG above); reached from topics.ts line 162.
  it("fixed: a stored joined section keeps the slides of interleaved sections in slide order", async () => {
    const w = exam();
    const l = lecture(w.examId, "Inter.pdf", 22);
    const p = l.pages;
    reply = () => ({
      topics: [sec("A", [p[0], p[3]]), sec("B", [p[1], p[2]]), ...ids(9).map((k) => sec(`P${k}`, [p[4 + (k - 1) * 2], p[5 + (k - 1) * 2]]))],
    });
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts).toHaveLength(10);
    expect(pagesOf(ts[0])).toEqual([p[0], p[1], p[2], p[3]]);
  });

  it("a messy AI reply (14 sections listed backwards, slides backwards, invented ids, a repeated slide, left-out slides, a filler slide) still gives 10 sections with every content slide once, in order", async () => {
    const w = exam();
    const l = lecture(w.examId, "Messy.pdf", 43, [1]); // slide 1 is a title slide; content = slides 2..43 = 42 slides
    const content = l.pages.slice(1);
    reply = (c) => {
      const sent = idsIn(c);
      expect(sent).toEqual(content); // the filler slide is never sent
      const out: AiTopic[] = [];
      for (let i = 0; i < sent.length; i += 3) out.push(sec(`S${i / 3 + 1}`, sent.slice(i, i + 3).reverse())); // 14 sections of 3, each backwards
      out.reverse(); // sections listed backwards
      out[0].page_ids.push(999999, l.pages[0]); // an invented id and the title slide
      out[12].page_ids.push(sent[10]); // a slide also listed in a later section (its real section, out[10], is listed first and keeps it)
      // leave out two slides: one in the middle of a section, one at the very end of the lecture
      for (const o of out) o.page_ids = o.page_ids.filter((x) => x !== sent[19] && x !== sent[sent.length - 1]);
      return { topics: out };
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId).topic_status).toBe("ready");
    const ts = topics(w.examId);
    expect(ts).toHaveLength(10);
    expect(ts.map((t) => t.position)).toEqual(ids(10).map((i) => i - 1));
    expect(ts.flatMap(pagesOf)).toEqual(content);
    for (const t of ts) {
      expect(ascending(pagesOf(t).map((id) => l.pages.indexOf(id)))).toBe(true);
      expect(t.document_id).toBe(l.doc);
    }
    expect(prompts).toHaveLength(1); // the cap never asks the AI a second time
  });

  it("several lectures, the first one slowest: positions run 0..n-1 in upload order and each lecture has at most 10 sections", async () => {
    const w = exam();
    const a = lecture(w.examId, "A.pdf", 40);
    const b = lecture(w.examId, "B.pdf", 26);
    const c = lecture(w.examId, "C.pdf", 5);
    const d = lecture(w.examId, "D.pdf", 11);
    lag = (content) => (idsIn(content)[0] === a.pages[0] ? 60 : idsIn(content)[0] === b.pages[0] ? 30 : 0);
    reply = (content) => chunked(content.includes("D.pdf") ? 1 : 2)(content);
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    const per = [a, b, c, d].map((l) => ts.filter((t) => t.document_id === l.doc));
    expect(per.map((x) => x.length)).toEqual([10, 10, 3, 10]);
    expect(ts.map((t) => t.position)).toEqual(ts.map((_, i) => i));
    expect(ts.flatMap(pagesOf)).toEqual([...a.pages, ...b.pages, ...c.pages, ...d.pages]);
    expect(ts.map((t) => t.document_id)).toEqual([...Array(10).fill(a.doc), ...Array(10).fill(b.doc), ...Array(3).fill(c.doc), ...Array(10).fill(d.doc)]);
    expect(prompts).toHaveLength(4);
  });

  it("exactly 10 sections from the AI are stored untouched (titles included); 11 give one joined section", async () => {
    const w = exam();
    lecture(w.examId, "Ten.pdf", 30);
    reply = chunked(3);
    await buildTopicMap(w.examId);
    expect(topics(w.examId).map((t) => t.title)).toEqual(ids(10).map((i) => `S${i}`));
    const w2 = exam();
    lecture(w2.examId, "Eleven.pdf", 11);
    reply = chunked(1);
    await buildTopicMap(w2.examId);
    const ts = topics(w2.examId);
    expect(ts).toHaveLength(10);
    expect(ts[0].title).toBe("S1 & S2");
  });

  it("a very over-split lecture (150 one-slide sections) is stored as 10 sections with all 150 slides", async () => {
    const w = exam();
    const l = lecture(w.examId, "Huge.pdf", 150);
    reply = chunked(1);
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts).toHaveLength(10);
    expect(ts.flatMap(pagesOf)).toEqual(l.pages);
  });

  it("joined sections pool their concepts in the database: blanks are skipped and names that differ only by spaces link once", async () => {
    const w = exam();
    lecture(w.examId, "C.pdf", 11);
    reply = (content) => {
      const all = idsIn(content);
      return {
        topics: all.map((id, i) => sec(`S${i + 1}`, [id], { concepts: i === 0 ? [" Pulpitis", "", "  "] : i === 1 ? ["Pulpitis ", "Cvek"] : [`K${i}`] })),
      };
    };
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts).toHaveLength(10);
    const names = (db.prepare("SELECT c.name FROM topic_concepts tc JOIN concepts c ON c.id = tc.concept_id WHERE tc.topic_id = ? ORDER BY c.name").all(ts[0].id) as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(["Cvek", "Pulpitis"]);
    expect(ts[0].emphasized).toBe(0);
  });

  it("a joined section is emphasized in the database when either half was", async () => {
    const w = exam();
    lecture(w.examId, "Em.pdf", 11);
    reply = (content) => ({ topics: idsIn(content).map((id, i) => sec(`S${i + 1}`, [id], { emphasized: i === 1 })) });
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts[0].emphasized).toBe(1);
    expect(ts[1].emphasized).toBe(0);
  });

  it("an AI reply of nothing usable (no sections, or only invented ids) gives one whole-lecture section on an automatic run", async () => {
    const w = exam();
    const base = lecture(w.examId, "Base.pdf", 4);
    reply = chunked(2);
    await buildTopicMap(w.examId); // the exam already has a map, so the next lectures are added to it
    expect(topics(w.examId)).toHaveLength(2);
    const a = lecture(w.examId, "Empty reply.pdf", 8);
    const b = lecture(w.examId, "Invented.pdf", 30);
    const c = lecture(w.examId, "Fine.pdf", 6);
    reply = (content) => {
      if (content.includes("Empty reply.pdf")) return { topics: [] };
      if (content.includes("Invented.pdf")) return { topics: ids(12).map((i) => sec(`X${i}`, [900000 + i])) };
      return chunked(3)(content);
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId).topic_status).toBe("ready");
    const ts = topics(w.examId);
    expect(ts.filter((t) => t.document_id === a.doc)).toHaveLength(1);
    expect(ts.filter((t) => t.document_id === b.doc)).toHaveLength(1);
    expect(ts.filter((t) => t.document_id === c.doc)).toHaveLength(2);
    const whole = ts.find((t) => t.document_id === a.doc)!;
    expect(pagesOf(whole)).toEqual(a.pages);
    expect(whole.title).toBe("Empty reply");
    expect(pagesOf(ts.find((t) => t.document_id === b.doc)!)).toEqual(b.pages);
    expect(ts.slice(0, 2).flatMap(pagesOf)).toEqual(base.pages);
    expect(ts.map((t) => t.position)).toEqual(ts.map((_, i) => i));
  });

  it("a Rebuild where one lecture's reply is empty fails cleanly (status error, old map untouched)", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 12);
    reply = chunked(1);
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    expect(before).toHaveLength(10);
    reply = () => ({ topics: [] });
    await buildTopicMap(w.examId, "full");
    expect(status(w.examId).topic_status).toBe("error");
    expect(status(w.examId).topic_error).toMatch(/came back empty for L\.pdf/);
    expect(topics(w.examId).map((t) => [t.id, t.page_ids])).toEqual(before.map((t) => [t.id, t.page_ids]));
    expect(topics(w.examId).flatMap(pagesOf)).toEqual(l.pages);
    // and the next good Rebuild recovers
    reply = chunked(1);
    await buildTopicMap(w.examId, "full");
    expect(status(w.examId).topic_status).toBe("ready");
    expect(status(w.examId).topic_error).toBeNull();
  });

  it("one lecture failing makes the whole build fail even when another lecture was over-split; nothing half-written", async () => {
    const w = exam();
    lecture(w.examId, "Good.pdf", 20);
    lecture(w.examId, "Bad.pdf", 4);
    reply = (content) => {
      if (content.includes("Bad.pdf")) throw new Error("AI down");
      return chunked(1)(content);
    };
    await buildTopicMap(w.examId);
    expect(status(w.examId).topic_status).toBe("error");
    expect(topics(w.examId)).toHaveLength(0);
  });

  it("auto: a lecture already mapped with 10 sections that gains a retried slide takes it into the nearest section, with no AI call, and still has 10", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 21);
    db.prepare("UPDATE pages SET status = 'error' WHERE id = ?").run(l.pages[10]); // slide 11 not read yet
    reply = chunked(2); // 20 slides -> 10 sections of 2
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    expect(before).toHaveLength(10);
    db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[]', checks_version = 2 WHERE exam_id = ?").run(w.examId);
    db.prepare("UPDATE pages SET status = 'done' WHERE id = ?").run(l.pages[10]);
    prompts.length = 0;
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(0);
    const now = topics(w.examId);
    expect(now.map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(now).toHaveLength(10);
    expect(now.flatMap(pagesOf)).toEqual(l.pages);
    // slide 11 sits between slide 10 (section 5) and slide 12 (section 6): the nearer one found first wins, the earlier section
    expect(pagesOf(now[4])).toEqual([l.pages[8], l.pages[9], l.pages[10]]);
    expect(now[4].lesson_json).toBeNull();
    expect(now.filter((t) => t.lesson_json === null)).toHaveLength(1);
    expect(now.map((t) => t.position)).toEqual(ids(10).map((i) => i - 1));
  });

  it("auto: retried slides at the very start and the very end of a 10-section lecture join the first and the last section", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 22);
    db.prepare("UPDATE pages SET status = 'error' WHERE id IN (?, ?)").run(l.pages[0], l.pages[21]);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    expect(topics(w.examId)).toHaveLength(10);
    db.prepare("UPDATE pages SET status = 'done' WHERE id IN (?, ?)").run(l.pages[0], l.pages[21]);
    await buildTopicMap(w.examId);
    const now = topics(w.examId);
    expect(now).toHaveLength(10);
    expect(pagesOf(now[0])).toEqual([l.pages[0], l.pages[1], l.pages[2]]);
    expect(pagesOf(now[9])).toEqual([l.pages[19], l.pages[20], l.pages[21]]);
    expect(now.flatMap(pagesOf)).toEqual(l.pages);
  });

  it("auto: a retried slide in a mapped lecture and a brand-new over-split lecture in the same run: 10 + 10, positions 0..19, questions refiled", async () => {
    const w = exam();
    const a = lecture(w.examId, "A.pdf", 21);
    db.prepare("UPDATE pages SET status = 'error' WHERE id = ?").run(a.pages[20]);
    reply = chunked(2);
    await buildTopicMap(w.examId);
    db.prepare("UPDATE pages SET status = 'done' WHERE id = ?").run(a.pages[20]);
    const b = lecture(w.examId, "B.pdf", 15);
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, NULL, 'recall', 's', '[]', 0, 'e', ?)");
    const qB = Number(ins.run(w.examId, b.pages[1]).lastInsertRowid); // slide 2 ends up in the joined first section
    const qA = Number(ins.run(w.examId, a.pages[20]).lastInsertRowid);
    reply = chunked(1); // 15 sections for B
    prompts.length = 0;
    await buildTopicMap(w.examId);
    expect(prompts).toHaveLength(1);
    const ts = topics(w.examId);
    expect(ts.filter((t) => t.document_id === a.doc)).toHaveLength(10);
    expect(ts.filter((t) => t.document_id === b.doc)).toHaveLength(10);
    expect(ts.map((t) => t.position)).toEqual(ts.map((_, i) => i));
    expect(ts.flatMap(pagesOf)).toEqual([...a.pages, ...b.pages]);
    const holder = (p: number) => ts.find((t) => pagesOf(t).includes(p))!.id;
    const topicOf = (q: number) => (db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id;
    expect(topicOf(qB)).toBe(holder(b.pages[1]));
    expect(topicOf(qA)).toBe(holder(a.pages[20]));
    expect(pagesOf(ts.find((t) => t.id === topicOf(qB))!).length).toBeGreaterThan(1);
  });

  it("(documented) auto never re-caps a lecture that was mapped before the cap existed: a 12-section lecture stays at 12", async () => {
    const w = exam();
    const l = lecture(w.examId, "Old.pdf", 25);
    db.prepare("UPDATE pages SET status = 'error' WHERE id = ?").run(l.pages[24]);
    const sections = ids(12).map((i) => seedTopic(w.examId, i - 1, `Old ${i}`, l.pages.slice((i - 1) * 2, i * 2), l.doc));
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    db.prepare("UPDATE pages SET status = 'done' WHERE id = ?").run(l.pages[24]);
    await buildTopicMap(w.examId);
    const now = topics(w.examId);
    expect(now.map((t) => t.id)).toEqual(sections);
    expect(pagesOf(now[11])).toEqual([l.pages[22], l.pages[23], l.pages[24]]);
    expect(prompts).toHaveLength(0);
  });

  it("Rebuild of a 12-section pre-cap map into 10: 8 sections keep their id, lesson and quiz; the two merged ones keep the first old topic each and lose their lesson; the other two old topics go", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 36);
    const old = ids(12).map((i) => seedTopic(w.examId, i - 1, `Old ${i}`, l.pages.slice((i - 1) * 3, i * 3), l.doc));
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    const studied = db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)");
    for (const i of [0, 1, 3, 7]) studied.run(w.userId, old[i]);
    const ins = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)");
    const q4 = Number(ins.run(w.examId, old[1], l.pages[3]).lastInsertRowid); // slide 4: old topic 2 (goes), now inside new section 1
    const q10 = Number(ins.run(w.examId, old[3], l.pages[9]).lastInsertRowid); // slide 10: old topic 4 (goes), now inside new section 2
    const q20 = Number(ins.run(w.examId, old[6], l.pages[19]).lastInsertRowid); // untouched section
    const sess = db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, ?)");
    const farSession = Number(sess.run(w.examId, 11).lastInsertRowid);
    const nearSession = Number(sess.run(w.examId, 3).lastInsertRowid);
    reply = chunked(3); // 12 sections -> 10 (S1+S2 and S3+S4 join)
    await buildTopicMap(w.examId, "full");
    expect(status(w.examId).topic_status).toBe("ready");
    const now = topics(w.examId);
    expect(now).toHaveLength(10);
    expect(now.flatMap(pagesOf)).toEqual(l.pages);
    expect(now.map((t) => t.position)).toEqual(ids(10).map((i) => i - 1));
    // survivors: old 1 and 3 (the first old topic inside each joined section) and old 5..12; old 2 and 4 are gone
    expect(now.map((t) => t.id)).toEqual([old[0], old[2], ...old.slice(4)]);
    expect((db.prepare("SELECT COUNT(*) n FROM topics WHERE id IN (?, ?)").get(old[1], old[3]) as { n: number }).n).toBe(0);
    // joined sections are rewritten (new title and slides, lesson and quiz cleared); the other eight are untouched
    expect(now[0]).toMatchObject({ title: "S1 & S2", lesson_json: null, checks_json: null });
    expect(now[1]).toMatchObject({ title: "S3 & S4", lesson_json: null, checks_json: null });
    for (const t of now.slice(2)) expect(t).toMatchObject({ lesson_json: "L", checks_json: "[]", checks_version: 2 });
    expect(now[2].title).toBe("Old 5");
    // progress follows ids: the two kept joined sections and the untouched one stay studied; the deleted ones' rows are gone
    const studiedIds = (db.prepare("SELECT topic_id FROM topic_study WHERE user_id = ? ORDER BY topic_id").all(w.userId) as { topic_id: number }[]).map((r) => r.topic_id);
    expect(studiedIds).toEqual([old[0], old[7]]);
    // questions follow their slide into the section that now holds it
    const topicOf = (q: number) => (db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id;
    expect(topicOf(q4)).toBe(old[0]);
    expect(topicOf(q10)).toBe(old[2]);
    expect(topicOf(q20)).toBe(old[6]);
    // the study position is pulled back inside the new, shorter map
    const pos = (id: number) => (db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(id) as { p: number }).p;
    expect(pos(farSession)).toBe(9);
    expect(pos(nearSession)).toBe(3);
    // the concepts are linked to the surviving rows without duplicates
    const linked = (id: number) => (db.prepare("SELECT COUNT(*) n FROM topic_concepts WHERE topic_id = ?").get(id) as { n: number }).n;
    expect(linked(old[0])).toBe(2); // "S1 concept" and "S2 concept" pooled
    expect(linked(old[4])).toBe(1);
  });

  it("Rebuild with the same over-split reply again is a no-op for ids, positions, lessons, titles and progress", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 39);
    reply = chunked(3); // 13 -> 10
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    expect(before).toHaveLength(10);
    db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[]', checks_version = 2 WHERE exam_id = ?").run(w.examId);
    for (const t of before) db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, t.id);
    await buildTopicMap(w.examId, "full");
    await buildTopicMap(w.examId, "full");
    const after = topics(w.examId);
    expect(after.map((t) => [t.id, t.position, t.title, t.page_ids, t.lesson_json])).toEqual(before.map((t) => [t.id, t.position, t.title, t.page_ids, "L"]));
    expect((db.prepare("SELECT COUNT(*) n FROM topic_study WHERE user_id = ?").get(w.userId) as { n: number }).n).toBe(10);
    expect(after.flatMap(pagesOf)).toEqual(l.pages);
  });

  it("Rebuild: a big joined section matches an old topic only when it shares half of both; an old coarse topic is replaced and its questions are refiled", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 22);
    // old map: one topic per 11 slides (each is only 4 of 11 slides inside the first joined section: 4*2 < 11, no match)
    const big1 = seedTopic(w.examId, 0, "Big 1", l.pages.slice(0, 11), l.doc);
    const big2 = seedTopic(w.examId, 1, "Big 2", l.pages.slice(11), l.doc);
    db.prepare("INSERT INTO topic_study (user_id, topic_id) VALUES (?, ?)").run(w.userId, big1);
    const q = Number(
      db
        .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', 's', '[]', 0, 'e', ?)")
        .run(w.examId, big2, l.pages[15]).lastInsertRowid,
    );
    reply = chunked(2); // 11 sections -> 10; first joined section holds slides 1-4
    await buildTopicMap(w.examId, "full");
    const now = topics(w.examId);
    expect(now).toHaveLength(10);
    // [1-4] overlaps big1 by 4 of 11: no; [5-6] overlaps big1 by 2 of 11: no; ... every new section is too small for the big old ones
    // (row ids of deleted topics can be handed out again to new rows, so compare content, not ids)
    expect(now.some((t) => t.title.startsWith("Big"))).toBe(false);
    expect(now.every((t) => t.lesson_json === null)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) n FROM topic_study WHERE topic_id = ?").get(big1) as { n: number }).n).toBe(0);
    const topicOf = (db.prepare("SELECT topic_id FROM questions WHERE id = ?").get(q) as { topic_id: number }).topic_id;
    expect(topicOf).toBe(now.find((t) => pagesOf(t).includes(l.pages[15]))!.id);
    expect(now.flatMap(pagesOf)).toEqual(l.pages);
  });

  it("Rebuild across two lectures: one lecture over-split and one fine, old ids of the fine one all stay, positions stay 0..n-1", async () => {
    const w = exam();
    const a = lecture(w.examId, "A.pdf", 36);
    const b = lecture(w.examId, "B.pdf", 9);
    reply = chunked(3);
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    expect(before.filter((t) => t.document_id === a.doc)).toHaveLength(10);
    expect(before.filter((t) => t.document_id === b.doc)).toHaveLength(3);
    db.prepare("UPDATE topics SET lesson_json = 'L' WHERE exam_id = ?").run(w.examId);
    // A's AI now gives 18 sections of 2; B is unchanged
    reply = (content) => (content.includes("A.pdf") ? chunked(2)(content) : chunked(3)(content));
    await buildTopicMap(w.examId, "full");
    const now = topics(w.examId);
    expect(now.filter((t) => t.document_id === a.doc)).toHaveLength(10);
    expect(now.filter((t) => t.document_id === b.doc).map((t) => t.id)).toEqual(before.filter((t) => t.document_id === b.doc).map((t) => t.id));
    expect(now.filter((t) => t.document_id === b.doc).every((t) => t.lesson_json === "L")).toBe(true);
    expect(now.map((t) => t.position)).toEqual(now.map((_, i) => i));
    expect(now.flatMap(pagesOf)).toEqual([...a.pages, ...b.pages]);
    expect(status(w.examId).topic_status).toBe("ready");
  });

  it("study sessions: a position past the end of a smaller map is pulled back to the last section; one inside it is left alone", async () => {
    const w = exam();
    const l = lecture(w.examId, "L.pdf", 30);
    reply = chunked(1); // 30 -> 10
    const sess = db.prepare("INSERT INTO study_sessions (exam_id, current_position) VALUES (?, ?)");
    const s1 = Number(sess.run(w.examId, 25).lastInsertRowid);
    const s2 = Number(sess.run(w.examId, 4).lastInsertRowid);
    await buildTopicMap(w.examId);
    const pos = (id: number) => (db.prepare("SELECT current_position p FROM study_sessions WHERE id = ?").get(id) as { p: number }).p;
    // (a first automatic build with no old map goes through fullMap, whose renumber() clamps too)
    expect(topics(w.examId)).toHaveLength(10);
    expect(pos(s1)).toBe(9);
    expect(pos(s2)).toBe(4);
    expect(topics(w.examId).flatMap(pagesOf)).toEqual(l.pages);
  });

  it("section positions stay unique after an auto run adds a capped lecture to a map with a gap", async () => {
    const w = exam();
    const a = lecture(w.examId, "A.pdf", 6);
    reply = chunked(3);
    await buildTopicMap(w.examId);
    const b = lecture(w.examId, "B.pdf", 33);
    reply = chunked(3); // 11 sections -> 10
    await buildTopicMap(w.examId);
    const c = lecture(w.examId, "C.pdf", 40);
    reply = chunked(2); // 20 -> 10
    await buildTopicMap(w.examId);
    const ts = topics(w.examId);
    expect(ts.map((t) => t.position)).toEqual(ids(22).map((i) => i - 1));
    expect(ts.flatMap(pagesOf)).toEqual([...a.pages, ...b.pages, ...c.pages]);
    expect([a, b, c].map((l) => ts.filter((t) => t.document_id === l.doc).length)).toEqual([2, 10, 10]);
  });

  it("the system prompt states the limit with the same number the code uses", async () => {
    const w = exam();
    lecture(w.examId, "L.pdf", 3);
    await buildTopicMap(w.examId);
    expect(prompts[0].system).toContain(`At most ${MAX_SECTIONS} sections per lecture`);
    expect(MAX_SECTIONS).toBe(10);
  });
});
