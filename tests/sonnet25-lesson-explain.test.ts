// Sonnet QA 25: attack tests for "lessons explain, never copy" (quotedFacts, the copy-triggered repair and its acceptance
// rule, the version-3 keep/rewrite decision, class copies and the lesson route).
// Tests named "BUG: …" document a real defect and are left failing on purpose; "(documented) …" tests pin odd but accepted behaviour.
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
import { coveredFacts, QUOTE_MIN_WORDS, quotedFacts } from "@/lib/lessonCoverage";
import { addSharedExam, createClass, joinClass, shareExam } from "@/lib/classes";
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { makeUser } from "./helpers";

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const lessonCallsMade = () => calls.filter((c) => c.purpose.startsWith("lesson")).map((c) => c.purpose);

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------
const notesJson = (i: number, facts: string[]) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: false, emphasis_note: null,
    case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

/** One exam, one topic over one slide per entry of `facts`, one study session. */
function world(facts: string[][], o: { filename?: string; userId?: number } = {}) {
  const userId = o.userId ?? makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, ?, 'done')").run(examId, o.filename ?? "L1.pdf").lastInsertRowid);
  const insertPage = db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, 0, 1.5)");
  const pages = facts.map((f, i) => Number(insertPage.run(doc, i + 1, notesJson(i, f)).lastInsertRowid));
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, doc, pages, topicId, sessionId, topic };
}
type World = ReturnType<typeof world>;
const stored = (w: World, lesson: object) => db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), w.topicId);
const setPageIds = (w: World, raw: string | null) => db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(raw, w.topicId);

// A six-word fact per slide with its own code words, so one slide's sentence can't pass as another's.
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
const F = (k: number) => WORDS.map((w) => `${w}${k}`).join(" ");
const REV = (k: number) => [...WORDS].reverse().map((w) => `${w}${k}`).join(" ");
/** copy = the fact word for word; cover = every key word, reversed (no run of the slide's order); miss = nothing about it; skip = no entry for the slide. */
type Mode = "copy" | "cover" | "miss" | "skip";
const say = (m: Mode, k: number, tag: string) =>
  m === "copy" ? `${tag} says: ${F(k)}.` : m === "cover" ? `${tag} puts it backwards: ${REV(k)}.` : `${tag} has nothing on this one.`;
const oneFactEach = (n: number) => Array.from({ length: n }, (_, k) => [F(k)]);
const lessonOf = (w: World, modes: Mode[], tag: string, extra: object = {}) => ({
  intro: "Intro.",
  slides: w.pages.flatMap((page_id, k) => (modes[k] === "skip" ? [] : [{ page_id, explanation: say(modes[k], k, tag) }])),
  key_points: ["k"],
  connections: null,
  ...extra,
});
const rep = (n: number, m: Mode): Mode[] => Array.from({ length: n }, () => m);

/** Runs getLesson over a one-fact-per-slide section: the first writer answer is `first`, the repair (if asked) `second`. */
async function twoSteps(first: Mode[], second: Mode[] | (() => unknown)) {
  const w = world(oneFactEach(first.length));
  lessonWriter = (n) => (n === 1 ? lessonOf(w, first, "wone") : typeof second === "function" ? second() : lessonOf(w, second, "wtwo"));
  const lesson = await getLesson(w.topic());
  const repairCall = calls.find((c) => c.purpose === "lesson repair");
  const ask = repairCall ? repairCall.content.slice(repairCall.content.indexOf("Your previous lesson")) : "";
  const kept = /wtwo/.test(lessonText(lesson)) ? "repair" : /wone/.test(lessonText(lesson)) ? "first" : "other";
  return { w, lesson, ask, kept, purposes: lessonCallsMade() };
}

beforeEach(() => {
  calls.length = 0;
  lessonCalls = 0;
  lessonWriter = () => ({});
  currentUserId = 0;
});

// ---------------------------------------------------------------------------------------------------------------------
describe("quotedFacts: text normalisation", () => {
  it("accents and capitals: an upper-cased, accented copy is still a copy", () => {
    const f = "the Müller glia span retina";
    expect(quotedFacts("THE MÜLLER GLIA SPAN RETINA", [f]).quoted).toEqual([f]);
    expect(quotedFacts("the Muller glia span retina", [f]).quoted).toEqual([]); // ü and u are different letters
  });

  // Input: the 5-word fact "the Müller glia span retina" (precomposed ü) against a lesson that repeats it with the accent as
  // u + U+0308 (NFD, what macOS file names and some PDF extractors produce).
  // Wrong output: quoted = [] (ratio 0). wordRun's [\p{L}\p{N}]+ has no \p{M} and no normalize("NFC"), so the combining mark is a
  // separator: "Müller" becomes "mu" + "ller" in the lesson and the copy slips through (the same for any accented word
  // that is inside the run).
  // src/lib/lessonCoverage.ts line 41 (wordRun).
  it("fixed: an accent written as a combining mark (NFD) hides a copy of the same text written with the precomposed letter (NFC)", () => {
    const fact = "the Müller glia span retina";
    const nfd = fact.normalize("NFD");
    expect(nfd).not.toBe(fact);
    expect(quotedFacts(nfd, [fact]).quoted).toEqual([fact]);
  });

  it("hyphens and slashes split words on both sides alike: 'C-based' = 'C based', 'mL/min' = 'ml / min'", () => {
    const f = "Cystatin C-based GFR below 60 mL/min per 1.73 m2 means CKD";
    expect(quotedFacts("cystatin C based GFR below 60 ml / min per 1.73 m2 means CKD", [f]).quoted).toEqual([f]);
    expect(quotedFacts("cystatin C-based GFR below 60 mL per min per 1.73 m2 means CKD", [f]).quoted).toEqual([]); // "per" for "/" breaks the run
  });

  it("numbers: '1.73' and '1,73' read alike, a changed number breaks the run", () => {
    const f = "Normal serum creatinine is 0.6 to 1.2 mg per dL in adults";
    expect(quotedFacts("normal serum creatinine is 0,6 to 1,2 mg per dL in adults", [f]).quoted).toEqual([f]);
    // the 0.6-1.2 range is the middle of the fact: changing it leaves runs of 3 and 5 words (needs 8)
    expect(quotedFacts("normal serum creatinine is 0.7 to 1.3 mg per dL in adults", [f]).quoted).toEqual([]);
  });

  it("markdown does not hide a copy: bold, bullets, headings and line breaks are all skipped", () => {
    const f = "Cystatin C-based estimates for GFR are less influenced by muscle mass";
    const md = "## Kidneys\n\n- **Cystatin C**-based estimates\n  for *GFR* are less\n  influenced by muscle mass\n";
    expect(quotedFacts(md, [f]).quoted).toEqual([f]);
  });

  it("(documented) markdown that puts words INSIDE the run breaks it: a numbered list or a link target between the words", () => {
    const f = "Cystatin C-based estimates for GFR are less influenced by muscle mass";
    expect(quotedFacts("1. Cystatin C-based estimates for\n2. GFR are less influenced by muscle mass", [f]).quoted).toEqual([]);
    expect(quotedFacts("Cystatin C-based estimates for [GFR](https://x.org/gfr) are less influenced by muscle mass", [f]).quoted).toEqual([]);
  });

  it("a fact repeated inside a longer sentence is quoted, and quoted only once however often it is repeated", () => {
    const f = "The pulp holds the nerves and blood vessels of the tooth";
    const text = `As the slide says, ${f.toLowerCase()}, and again ${f.toLowerCase()}, so remember that.`;
    expect(quotedFacts(text, [f])).toEqual({ quoted: [f], judged: 1, ratio: 1 });
  });

  it("(documented) non-spaced scripts are never judged: a 5-word Chinese fact is one 'word'", () => {
    const f = "牙髓包含神经和血管并且位于牙齿内部";
    expect(quotedFacts(f, [f])).toEqual({ quoted: [], judged: 0, ratio: 0 });
  });

  it("(documented) a fact made only of stopwords is judged like any other (quotedFacts has no stopword list)", () => {
    const f = "it is what it is not";
    expect(quotedFacts("Remember: it is what it is not, always.", [f]).quoted).toEqual([f]);
  });
});

describe("quotedFacts: the 70% run at its boundaries", () => {
  // words w1..wn; the run is max(5, ceil(0.7n))
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`);
  const cases: [number, number][] = [[5, 5], [6, 5], [7, 5], [8, 6], [10, 7], [14, 10], [20, 14], [30, 21], [50, 35]];
  for (const [n, run] of cases) {
    it(`${n} words: a run of ${run} counts, ${run - 1} does not (head, middle and tail)`, () => {
      const f = words(n).join(" ");
      const ws = words(n);
      const filler = "zz yy xx";
      expect(quotedFacts(`${filler} ${ws.slice(0, run).join(" ")} ${filler}`, [f]).quoted).toEqual([f]);
      expect(quotedFacts(`${filler} ${ws.slice(n - run).join(" ")}`, [f]).quoted).toEqual([f]);
      const mid = Math.floor((n - run) / 2);
      expect(quotedFacts(`${ws.slice(mid, mid + run).join(" ")}`, [f]).quoted).toEqual([f]);
      expect(quotedFacts(`${filler} ${ws.slice(0, run - 1).join(" ")} ${filler}`, [f]).quoted).toEqual([]);
      expect(quotedFacts(`${filler} ${ws.slice(n - run + 1).join(" ")}`, [f]).quoted).toEqual([]);
    });
  }

  it("run lengths never exceed the fact (no fact is unfindable) for every length 5..300", () => {
    for (let n = QUOTE_MIN_WORDS; n <= 300; n++) {
      const f = words(n).join(" ");
      expect(quotedFacts(f, [f]).quoted, `n=${n}`).toEqual([f]);
    }
  });

  it("a fact one word shorter than the minimum is not judged at all, even when copied whole", () => {
    const f = words(QUOTE_MIN_WORDS - 1).join(" ");
    expect(quotedFacts(f, [f])).toEqual({ quoted: [], judged: 0, ratio: 0 });
  });

  it("(documented) one swapped word in the middle of a 10-word copy escapes: runs of 4 and 5 are under the 7 needed", () => {
    const f = "Cystatin C based estimates for GFR are believed less influenced";
    const swapped = "Cystatin C based estimates, so GFR are believed less influenced";
    expect(f.split(" ")).toHaveLength(10);
    expect(quotedFacts(swapped, [f]).quoted).toEqual([]);
  });

  it("word order matters: the same words reversed, sorted or shuffled are not a copy", () => {
    const f = F(0) + " " + F(1); // 12 words → run 9
    const ws = f.split(" ");
    expect(quotedFacts([...ws].reverse().join(" "), [f]).quoted).toEqual([]);
    expect(quotedFacts([...ws].sort().join(" "), [f]).quoted).toEqual([]);
    const shuffled = [3, 7, 0, 11, 5, 9, 1, 10, 2, 8, 4, 6].map((i) => ws[i]).join(" ");
    expect(quotedFacts(shuffled, [f]).quoted).toEqual([]);
  });

  it("the facts in a different ORDER (each fact intact) are still copies", () => {
    const facts = [F(0), F(1), F(2)];
    expect(quotedFacts(`${F(2)}. ${F(0)}. ${F(1)}.`, facts).ratio).toBe(1);
  });
});

describe("quotedFacts: lists of facts, duplicates, joins and size", () => {
  it("(documented) duplicate facts passed in are each judged and each counted (generateLesson de-duplicates before calling)", () => {
    expect(quotedFacts(F(0), [F(0), F(0), F(1)])).toEqual({ quoted: [F(0), F(0)], judged: 3, ratio: 2 / 3 });
  });

  it("a run that spans the join between two slides' explanations counts, because lessonText joins them with a blank line", () => {
    // Slide 1 ends with the first half of the fact, slide 2 starts with the second half.
    const fact = "w1 w2 w3 w4 w5 w6 w7 w8 w9 w10";
    const lesson = { intro: "", slides: [{ page_id: 1, explanation: "so then w1 w2 w3 w4" }, { page_id: 2, explanation: "w5 w6 w7 w8 and on" }] };
    expect(lessonText(lesson)).toContain("w4\n\nw5");
    // Decision: harmless. A run of 7+ words in sequence across the join is a copy whichever slide holds which half, and by
    // chance it needs 5+ words of one fact to continue the other slide's last words. Pinned so a change is noticed.
    expect(quotedFacts(lessonText(lesson), [fact]).quoted).toEqual([fact]);
  });

  it("the intro joins slide 1's explanation the same way", () => {
    const fact = "w1 w2 w3 w4 w5 w6";
    const lesson = { intro: "It is about w1 w2 w3", slides: [{ page_id: 1, explanation: "w4 w5 w6 then more" }] };
    expect(quotedFacts(lessonText(lesson), [fact]).quoted).toEqual([fact]);
  });

  it("(documented) a short list of names quoted in the slide's order is flagged, an 'and' before the last one hides it", () => {
    const drugs = "Aspirin, ibuprofen, naproxen, ketorolac, diclofenac";
    expect(quotedFacts("The NSAIDs here: aspirin, ibuprofen, naproxen, ketorolac, diclofenac.", [drugs]).quoted).toEqual([drugs]);
    expect(quotedFacts("The NSAIDs here: aspirin, ibuprofen, naproxen, ketorolac and diclofenac.", [drugs]).quoted).toEqual([]);
  });

  it("(documented) a natural restatement of a short definition is flagged: 'The pulp is the nerve tissue of the tooth'", () => {
    const f = "The pulp is the nerve tissue of the tooth"; // 9 words → run 7
    expect(quotedFacts("Here the pulp is the nerve tissue of the tooth, which matters because...", [f]).quoted).toEqual([f]);
  });

  it("a very long fact (3000 words) copied inside a long text is found quickly", () => {
    const fact = Array.from({ length: 3000 }, (_, i) => `term${i}`).join(" ");
    const text = `intro words. ${fact} outro words.`;
    const t0 = performance.now();
    const r = quotedFacts(text, [fact]);
    const ms = performance.now() - t0;
    expect(r.quoted).toEqual([fact]);
    expect(ms).toBeLessThan(200);
  });

  it("a section of 60 slides x 8 facts against a long lesson stays fast, for a copy and for an explanation", () => {
    const facts = Array.from({ length: 480 }, (_, i) => `Fact ${i} ${WORDS.map((w) => `${w}${i}`).join(" ")} closes the thought`);
    const sentence = (i: number) => `Slide ${i} explanation: ${REV(i)} because the mechanism matters for the patient in the chair, and an exam would ask about it again and again.`;
    const long = Array.from({ length: 480 }, (_, i) => sentence(i).repeat(2)).join("\n\n");
    expect(long.length).toBeGreaterThan(100_000);
    const t0 = performance.now();
    const none = quotedFacts(long, facts);
    const t1 = performance.now();
    const all = quotedFacts(facts.join("\n\n") + "\n\n" + long, facts);
    const t2 = performance.now();
    expect(none).toMatchObject({ judged: 480, ratio: 0 });
    expect(all.ratio).toBe(1);
    expect(t1 - t0).toBeLessThan(200);
    expect(t2 - t1).toBeLessThan(200);
  });

  it("a degenerate text (20000 repeats of one word) against facts that almost match stays fast", () => {
    const text = "word ".repeat(20000);
    const facts = Array.from({ length: 20 }, (_, i) => `${"word ".repeat(30)}odd${i} ${"word ".repeat(30)}`);
    const t0 = performance.now();
    expect(quotedFacts(text, facts).quoted).toHaveLength(0); // the run needed is ceil(0.7 * 61) = 43 words, with the odd one inside
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("coverage and copying together", () => {
  it("the fixtures mean what they say: copy covers and quotes, cover covers without quoting, miss does neither", () => {
    const facts = [F(0), F(1), F(2)];
    const text = [say("copy", 0, "t"), say("cover", 1, "t"), say("miss", 2, "t")].join("\n\n");
    expect(coveredFacts(text, facts).covered).toEqual([F(0), F(1)]);
    expect(quotedFacts(text, facts).quoted).toEqual([F(0)]);
  });

  it("a lesson that explains but drops key words (coverage 0.7) and copies nothing: repair asks for the missing facts only", async () => {
    const r = await twoSteps([...rep(7, "cover"), ...rep(3, "miss")], rep(10, "cover"));
    expect(r.purposes).toEqual(["lesson", "lesson repair"]);
    expect(r.ask).toMatch(/^Your previous lesson left things out\. Write the whole lesson again/);
    expect(r.ask).not.toMatch(/repeated/);
    expect(r.ask).not.toMatch(/copied from the slides/);
    for (const k of [7, 8, 9]) expect(r.ask).toContain(`- ${F(k)}`);
    expect(r.ask).not.toContain(`- ${F(0)}`);
    expect(r.kept).toBe("repair");
  });

  it("a lesson that copies every slide (coverage 1, quoted 1): repair says 'repeated', lists every line, has no 'missing' block", async () => {
    const r = await twoSteps(rep(4, "copy"), rep(4, "cover"));
    expect(r.purposes).toEqual(["lesson", "lesson repair"]);
    expect(r.ask).toMatch(/^Your previous lesson repeated the slides instead of explaining them\. Write the whole lesson again, keeping every fact/);
    expect(r.ask).not.toMatch(/left things out/);
    expect(r.ask).not.toMatch(/are missing/);
    expect(r.ask).not.toMatch(/got no entry/);
    for (let k = 0; k < 4; k++) expect(r.ask).toContain(`- ${F(k)}`);
    expect(r.kept).toBe("repair");
  });

  it("copies plus one fact missing but coverage still 0.9: the wording is the 'left things out and repeated' one, with both lists", async () => {
    // 10 facts: 4 copied, 5 covered, 1 missed
    const r = await twoSteps([...rep(4, "copy"), ...rep(5, "cover"), "miss"], rep(10, "cover"));
    expect(r.purposes).toEqual(["lesson", "lesson repair"]);
    expect(r.ask).toMatch(/^Your previous lesson left things out and repeated the slides instead of explaining them\./);
    expect(r.ask).toContain(`- ${F(9)}`);
    expect(r.ask).toMatch(/copied from the slides word for word/);
    expect(r.ask).toContain(`- ${F(0)}`);
  });

  it("copies together with a slide left out: the left-out slide is named and the wording covers both", async () => {
    const r = await twoSteps([...rep(5, "copy"), ...rep(4, "cover"), "skip"], rep(10, "cover"));
    expect(r.ask).toMatch(/^Your previous lesson left things out and repeated/);
    expect(r.ask).toMatch(/got no entry; add one for each:\n- \[P\d+\] L1\.pdf slide 10/);
  });

  it("nothing wrong (coverage 1, 20% copied, no slide left out): no repair", async () => {
    const r = await twoSteps([...rep(2, "copy"), ...rep(8, "cover")], rep(10, "cover"));
    expect(r.purposes).toEqual(["lesson"]);
    expect(r.kept).toBe("first");
  });

  it("copied lines are listed once each even when the same fact stands on several slides", async () => {
    const shared = F(0);
    const w = world([[shared], [shared], [shared, F(1)], [F(2)]]);
    const copyAll = () => ({
      intro: "Intro.",
      slides: w.pages.map((page_id, i) => ({ page_id, explanation: `wone: ${[shared, shared, `${shared}. ${F(1)}`, F(2)][i]}.` })),
      key_points: ["k"],
      connections: null,
    });
    lessonWriter = (n) => (n === 1 ? copyAll() : { ...copyAll(), slides: w.pages.map((page_id, i) => ({ page_id, explanation: `wtwo: ${[REV(0), REV(0), `${REV(0)}. ${REV(1)}`, REV(2)][i]}` })) });
    await getLesson(w.topic());
    const c = calls.find((x) => x.purpose === "lesson repair")!.content;
    const ask = c.slice(c.indexOf("Your previous lesson"));
    expect(ask.split(`- ${shared}\n`).length - 1 + (ask.endsWith(`- ${shared}`) ? 1 : 0)).toBe(1);
    expect(ask).toContain(`- ${F(1)}`);
    expect(ask).toContain(`- ${F(2)}`);
    // The same slide list in the prompt above repeats the fact per slide, the repair block does not.
    expect(c.split(`- ${shared}`).length - 1).toBe(4); // 3 slide-list lines + 1 repair line
  });

  it("the same fact written with other capitals or punctuation on two slides counts once", async () => {
    const w = world([[F(0)], [F(0).toUpperCase() + "!"], [F(1)], [F(2)]]);
    lessonWriter = (n) =>
      n === 1
        ? { intro: "I", slides: w.pages.map((page_id, i) => ({ page_id, explanation: [F(0), F(0), F(1), F(2)][i] })), key_points: [], connections: null }
        : { intro: "I", slides: w.pages.map((page_id, i) => ({ page_id, explanation: [REV(0), REV(0), REV(1), REV(2)][i] })), key_points: [], connections: null };
    await getLesson(w.topic());
    const c = calls.find((x) => x.purpose === "lesson repair")!.content;
    const ask = c.slice(c.indexOf("Your previous lesson"));
    expect(ask.match(new RegExp(F(0), "gi"))).toHaveLength(1);
  });

  it("(documented) a multi-line fact is put in the repair prompt raw, so its line break shows (the slide list collapses it)", async () => {
    const odd = `${F(0)}\n- an injected bullet`;
    const w = world([[odd], [F(1)], [F(2)]]); // three judged facts, all copied
    lessonWriter = (n) => ({
      intro: "I",
      slides: w.pages.map((page_id, i) => ({ page_id, explanation: n === 1 ? [`${F(0)} an injected bullet`, F(1), F(2)][i] : "nothing" })),
      key_points: [],
      connections: null,
    });
    await getLesson(w.topic());
    const c = calls.find((x) => x.purpose === "lesson repair")!.content;
    const ask = c.slice(c.indexOf("Your previous lesson"));
    expect(ask).toContain(`- ${F(0)}\n- an injected bullet`);
    expect(c.slice(0, c.indexOf("Your previous lesson"))).not.toContain("\n- an injected bullet");
  });

  it("a section whose facts are all under five words is never repaired for copying, whatever the lesson does", async () => {
    const w = world([["fact a1", "fact b1"], ["fact a2"]]);
    lessonWriter = () => ({
      intro: "I",
      slides: w.pages.map((page_id) => ({ page_id, explanation: "fact a1 fact b1 fact a2 fact a1 fact b1" })),
      key_points: [],
      connections: null,
    });
    await getLesson(w.topic());
    expect(lessonCallsMade()).toEqual(["lesson"]);
  });

  it("a section with a single long fact that the lesson must quote (a list of names) costs no repair call: under three judged facts nothing counts as copying", async () => {
    const drugs = "Aspirin, ibuprofen, naproxen, ketorolac, diclofenac";
    const w = world([[drugs]]);
    lessonWriter = () => ({
      intro: "I",
      slides: [{ page_id: w.pages[0], explanation: "Painkillers of the NSAID family: aspirin, ibuprofen, naproxen, ketorolac, diclofenac. They block COX enzymes." }],
      key_points: [],
      connections: null,
    });
    const lesson = await getLesson(w.topic());
    // 1 of 1 judged facts would be ratio 1, but a section with fewer than three judged facts is never called a copier.
    expect(lessonCallsMade()).toEqual(["lesson"]);
    expect(lesson.version).toBe(LESSON_VERSION);
  });
});

describe("the repair acceptance rule, branch by branch", () => {
  it("no copies: a repair with the same coverage is kept; one with a single fact fewer is not (no slack)", async () => {
    const first = [...rep(14, "cover"), ...rep(6, "miss")]; // 0.7
    const same = await twoSteps(first, [...rep(14, "cover"), ...rep(6, "miss")]);
    expect(same.kept).toBe("repair");
    calls.length = 0;
    lessonCalls = 0;
    const worse = await twoSteps(first, [...rep(13, "cover"), ...rep(7, "miss")]); // 0.65
    expect(worse.purposes).toEqual(["lesson", "lesson repair"]);
    expect(worse.kept).toBe("first");
  });

  it("with copies: the repair may lose 0.1 of coverage (1 -> 0.9 is kept), not more (1 -> 0.8 is not)", async () => {
    const first = rep(10, "copy");
    expect((await twoSteps(first, [...rep(9, "cover"), "miss"])).kept).toBe("repair");
    calls.length = 0;
    lessonCalls = 0;
    expect((await twoSteps(first, [...rep(8, "cover"), ...rep(2, "miss")])).kept).toBe("first");
  });

  // Input: 10 facts; first lesson copies 4, explains 4, misses 2 (coverage 8/10 = 0.8, quoted 0.4, so a repair is asked);
  // the repair explains 7 and misses 3 (coverage 0.7, quoted 0). The rule says "cover2 >= cover - 0.1", one fact of ten.
  // Wrong output: the repair is thrown away and the lesson that copies 40% of the slides is stored.
  // 0.8 - 0.1 is 0.7000000000000001 in floating point, so 7/10 = 0.7 fails the comparison. src/lib/study.ts line 277.
  it("fixed: the 0.1 coverage slack is lost to floating point: 0.8 -> 0.7 is refused although it is exactly 0.1", async () => {
    const r = await twoSteps([...rep(4, "copy"), ...rep(4, "cover"), ...rep(2, "miss")], [...rep(7, "cover"), ...rep(3, "miss")]);
    expect(r.purposes).toEqual(["lesson", "lesson repair"]);
    expect(r.kept).toBe("repair");
  });

  it("the quoted limit is max(first ratio, 0.3): a repair that copies as much as before is kept, one that copies more is not", async () => {
    const first = [...rep(5, "copy"), ...rep(5, "cover")]; // 0.5
    expect((await twoSteps(first, first)).kept).toBe("repair");
    calls.length = 0;
    lessonCalls = 0;
    expect((await twoSteps(first, [...rep(6, "copy"), ...rep(4, "cover")])).kept).toBe("first");
    calls.length = 0;
    lessonCalls = 0;
    // fewer copies but still above the limit is better, so kept
    expect((await twoSteps(first, [...rep(4, "copy"), ...rep(6, "cover")])).kept).toBe("repair");
  });

  it("when the repair was asked for coverage only (quoted 0.2), the repair may copy up to 0.3 but not 0.4", async () => {
    const first = [...rep(2, "copy"), ...rep(5, "cover"), ...rep(3, "miss")]; // cover 0.7, quoted 0.2
    expect((await twoSteps(first, [...rep(3, "copy"), ...rep(7, "cover")])).kept).toBe("repair");
    calls.length = 0;
    lessonCalls = 0;
    expect((await twoSteps(first, [...rep(4, "copy"), ...rep(6, "cover")])).kept).toBe("first");
  });

  it("slides left out: a repair that restores some is kept, one that restores none but explains is kept, one that loses more is not", async () => {
    const first: Mode[] = [...rep(6, "cover"), ...rep(2, "copy"), "skip", "skip"]; // left 2, cover 0.8, quoted 0.2
    expect((await twoSteps(first, [...rep(9, "cover"), "skip"])).kept).toBe("repair");
    calls.length = 0;
    lessonCalls = 0;
    expect((await twoSteps(first, [...rep(8, "cover"), "skip", "skip"])).kept).toBe("repair");
    calls.length = 0;
    lessonCalls = 0;
    expect((await twoSteps(first, [...rep(7, "cover"), "skip", "skip", "skip"])).kept).toBe("first");
  });

  it("a repair that throws leaves the first lesson, stored and stamped with the current version", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await twoSteps(rep(4, "copy"), () => {
      throw new Error("overloaded");
    });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect(r.purposes).toEqual(["lesson", "lesson repair"]);
    expect(r.kept).toBe("first");
    const row = r.w.topic();
    expect(JSON.parse(row.lesson_json!).version).toBe(LESSON_VERSION);
    expect(lessonIsCurrent(row)).toBe(true);
  });

  it("a repair that returns no slides, junk or null leaves the first lesson", async () => {
    for (const junk of [() => ({}), () => ({ slides: "nope", intro: 5 }), () => ({ intro: "x", slides: [null, { page_id: 99999, explanation: "wtwo" }] })]) {
      calls.length = 0;
      lessonCalls = 0;
      const r = await twoSteps(rep(4, "copy"), junk);
      expect(r.kept, String(junk)).toBe("first");
      expect(r.lesson.slides).toHaveLength(4);
    }
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    calls.length = 0;
    lessonCalls = 0;
    const r = await twoSteps(rep(4, "copy"), () => null);
    err.mockRestore();
    expect(r.kept).toBe("first");
  });

  it("a first answer without slides is repaired (every slide with facts is left out) and the repair is kept", async () => {
    const r = await twoSteps(rep(3, "skip"), rep(3, "cover"));
    expect(r.purposes).toEqual(["lesson", "lesson repair"]);
    expect(r.kept).toBe("repair");
  });

  it("(documented) key_points and connections are not looked at: a lesson that pastes the slides only there is not repaired", async () => {
    const w = world(oneFactEach(4));
    lessonWriter = () => ({ ...lessonOf(w, rep(4, "cover"), "wone"), key_points: oneFactEach(4).map((f) => f[0]), connections: F(0) });
    await getLesson(w.topic());
    expect(lessonCallsMade()).toEqual(["lesson"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("lessonIsCurrent for stored version-3 lessons", () => {
  const v3 = (w: World, modes: Mode[]) => ({ ...lessonOf(w, modes, "old"), version: 3 });

  it("a quoted ratio of exactly 0.3 (3 of 10) is kept, 4 of 13 (0.31) is not", () => {
    const a = world(oneFactEach(10));
    stored(a, v3(a, [...rep(3, "copy"), ...rep(7, "cover")]));
    expect(lessonIsCurrent(a.topic())).toBe(true);
    const b = world(oneFactEach(13));
    stored(b, v3(b, [...rep(4, "copy"), ...rep(9, "cover")]));
    expect(lessonIsCurrent(b.topic())).toBe(false);
  });

  it("the same ratio of 0.3 reached as 9 of 30 and 6 of 20 is kept too (no float surprise at the limit)", () => {
    for (const [n, c] of [[20, 6], [30, 9], [40, 12], [50, 15]]) {
      const w = world(oneFactEach(n));
      stored(w, v3(w, [...rep(c, "copy"), ...rep(n - c, "cover")]));
      expect(lessonIsCurrent(w.topic()), `${c}/${n}`).toBe(true);
    }
  });

  it("every fact under five words: kept, however much of it is pasted", () => {
    const w = world([["fact one"], ["fact two"], ["pulp is nerve"]]);
    stored(w, { intro: "fact one fact two pulp is nerve", slides: [], key_points: [], connections: null, version: 3 });
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("v3 with page_ids pointing at deleted pages: no facts left, kept (documented: a copying lesson survives losing its pages)", () => {
    const w = world(oneFactEach(4));
    stored(w, v3(w, rep(4, "copy")));
    expect(lessonIsCurrent(w.topic())).toBe(false);
    setPageIds(w, JSON.stringify([999001, 999002]));
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("v3 with page_ids partly deleted: judged on the pages that remain", () => {
    const w = world(oneFactEach(4));
    stored(w, v3(w, [...rep(2, "copy"), ...rep(2, "cover")])); // 2 of 4 copied
    expect(lessonIsCurrent(w.topic())).toBe(false);
    setPageIds(w, JSON.stringify([w.pages[2], w.pages[3], 999001])); // the two explained facts remain
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("v3 with page_ids of another document's pages: those pages' facts are what is judged", () => {
    const mine = world(oneFactEach(3));
    const other = world(oneFactEach(3).map((f) => f.map((t) => t.replace(/\d/g, "9"))));
    stored(mine, v3(mine, rep(3, "copy"))); // copies MY facts
    expect(lessonIsCurrent(mine.topic())).toBe(false);
    setPageIds(mine, JSON.stringify(other.pages)); // but the topic now points at the other lecture
    expect(lessonIsCurrent(mine.topic())).toBe(true); // nothing of the other lecture's facts is in the lesson
  });

  it("v3 with empty '[]' page_ids is kept", () => {
    const w = world(oneFactEach(3));
    stored(w, v3(w, rep(3, "copy")));
    setPageIds(w, "[]");
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("v3 with page_ids missing, null or not a string is kept (as the change states)", () => {
    const w = world(oneFactEach(3));
    const lesson = JSON.stringify(v3(w, rep(3, "copy")));
    expect(lessonIsCurrent({ lesson_json: lesson } as never)).toBe(true);
    expect(lessonIsCurrent({ lesson_json: lesson, page_ids: null } as never)).toBe(true);
    expect(lessonIsCurrent({ lesson_json: lesson, page_ids: [w.pages[0]] } as never)).toBe(true);
  });

  it("(documented) v3 with a malformed page_ids string is rewritten, since topicPages throws and the catch says 'not current'", () => {
    const w = world(oneFactEach(3));
    stored(w, v3(w, rep(3, "cover")));
    for (const bad of ["not json", "{", "null", "5", '"abc"', "{}"]) {
      setPageIds(w, bad);
      expect(lessonIsCurrent(w.topic()), bad).toBe(false);
    }
  });

  it("a lesson_json whose slides point at pages outside the section is judged on its text all the same", () => {
    const w = world(oneFactEach(3));
    stored(w, { intro: "I", slides: [{ page_id: 424242, explanation: F(0) }, { page_id: 424243, explanation: F(1) }, { page_id: w.pages[2], explanation: F(2) }], key_points: [], connections: null, version: 3 });
    expect(lessonIsCurrent(w.topic())).toBe(false);
  });

  it("odd stored shapes never throw: null slides, slides with null/numeric/object explanations, no intro", () => {
    const w = world(oneFactEach(3));
    for (const l of [
      { version: 3 },
      { version: 3, slides: null, intro: null },
      { version: 3, slides: [null, {}, { explanation: 5 }, { explanation: { a: 1 } }, { explanation: ["x", "y"] }] },
    ]) {
      stored(w, l);
      expect(() => lessonIsCurrent(w.topic())).not.toThrow();
      expect(lessonIsCurrent(w.topic())).toBe(true);
    }
  });

  it("(documented) a stored v3 lesson whose slides is not an array is rewritten (the read throws and the catch says 'not current')", () => {
    const w = world(oneFactEach(3));
    stored(w, { version: 3, intro: "I", slides: "text" });
    expect(lessonIsCurrent(w.topic())).toBe(false);
  });

  it("(documented) the stored version must be the number 3: '3' as a string is rewritten, '4' as a string counts as current", () => {
    const w = world(oneFactEach(3));
    stored(w, { ...lessonOf(w, rep(3, "cover"), "old"), version: "3" });
    expect(lessonIsCurrent(w.topic())).toBe(false);
    stored(w, { ...lessonOf(w, rep(3, "copy"), "old"), version: "4" });
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("v2, v1, no version and 'null' JSON are rewritten without looking at the text; v4 and later are kept", () => {
    const w = world(oneFactEach(3));
    for (const v of [undefined, 1, 2, 0]) {
      stored(w, { ...lessonOf(w, rep(3, "cover"), "old"), version: v });
      expect(lessonIsCurrent(w.topic()), String(v)).toBe(false);
    }
    db.prepare("UPDATE topics SET lesson_json = 'null' WHERE id = ?").run(w.topicId);
    expect(lessonIsCurrent(w.topic())).toBe(false);
    for (const v of [4, 5, 99]) {
      stored(w, { ...lessonOf(w, rep(3, "copy"), "old"), version: v });
      expect(lessonIsCurrent(w.topic())).toBe(true);
    }
  });

  it("(documented) a facts-sharing recap: the same fact on three slides counts once in the ratio", () => {
    // 4 distinct facts, one of them on three slides. Copying only that one is 1 of 4 = 0.25 (kept); counted per slide it would be 3 of 6.
    const w = world([[F(0)], [F(0)], [F(0)], [F(1)], [F(2)], [F(3)]]);
    stored(w, { intro: "I", slides: w.pages.map((page_id, i) => ({ page_id, explanation: i < 3 ? F(0) : REV(i - 2) })), key_points: [], connections: null, version: 3 });
    expect(lessonIsCurrent(w.topic())).toBe(true);
  });

  it("speed: 60 slides x 8 facts and a long stored lesson are judged in well under 200 ms", () => {
    const facts = Array.from({ length: 60 }, (_, s) => Array.from({ length: 8 }, (_, j) => `Slide ${s} point ${j}: ${WORDS.map((x) => `${x}${s}x${j}`).join(" ")} and then some closing words`));
    const w = world(facts);
    const slides = w.pages.map((page_id, s) => ({
      page_id,
      explanation: facts[s].map((f, j) => `Explained ${j}: ${f.split(" ").reverse().join(" ")} which matters for the patient. `.repeat(2)).join("\n\n"),
    }));
    stored(w, { intro: "I", slides, key_points: [], connections: null, version: 3 });
    const t0 = performance.now();
    const current = lessonIsCurrent(w.topic());
    const ms = performance.now() - t0;
    expect(current).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("rewriting a stored version-3 lesson through getLesson", () => {
  it("a copying v3 lesson is rewritten by one 'lesson' call (not a repair), stored as v4, and then served from cache", async () => {
    const w = world(oneFactEach(4));
    stored(w, { ...lessonOf(w, rep(4, "copy"), "old"), version: 3 });
    lessonWriter = () => lessonOf(w, rep(4, "cover"), "new");
    const got = await getLesson(w.topic());
    expect(lessonCallsMade()).toEqual(["lesson"]);
    expect(got.version).toBe(LESSON_VERSION);
    expect(lessonText(got)).toContain("new");
    expect(JSON.parse(w.topic().lesson_json!).version).toBe(LESSON_VERSION);
    await getLesson(w.topic());
    expect(lessonCallsMade()).toEqual(["lesson"]);
  });

  it("if the rewrite fails the student still gets the stored v3 lesson she could read before; the rewrite is tried again next time", async () => {
    const w = world(oneFactEach(4));
    stored(w, { ...lessonOf(w, rep(4, "copy"), "old"), version: 3 });
    lessonWriter = () => {
      throw new Error("down");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await getLesson(w.topic());
    err.mockRestore();
    expect(lessonText(got)).toContain("old");
    expect(JSON.parse(w.topic().lesson_json!).version).toBe(3); // untouched
    expect(lessonCallsMade()).toEqual(["lesson"]);
    // the next open tries again (and a working writer wins)
    lessonWriter = () => lessonOf(w, rep(4, "cover"), "new");
    expect(lessonText(await getLesson(w.topic()))).toContain("new");
    expect(lessonCallsMade().slice(0, 2)).toEqual(["lesson", "lesson"]);
  });

  it("a rewrite that still copies is stored as v4 anyway and never asked again (the repair is the only retry)", async () => {
    const w = world(oneFactEach(4));
    stored(w, { ...lessonOf(w, rep(4, "copy"), "old"), version: 3 });
    lessonWriter = () => lessonOf(w, rep(4, "copy"), "new");
    await getLesson(w.topic());
    expect(lessonCallsMade()).toEqual(["lesson", "lesson repair"]);
    expect(lessonIsCurrent(w.topic())).toBe(true);
    await getLesson(w.topic());
    expect(lessonCallsMade()).toHaveLength(2);
  });

  it("two concurrent opens share one rewrite", async () => {
    const w = world(oneFactEach(4));
    stored(w, { ...lessonOf(w, rep(4, "copy"), "old"), version: 3 });
    lessonWriter = () => lessonOf(w, rep(4, "cover"), "new");
    await Promise.all([getLesson(w.topic()), getLesson(w.topic())]);
    expect(lessonCallsMade()).toEqual(["lesson"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("class copies", () => {
  function share(w: World) {
    const b = makeUser();
    const cls = createClass(w.userId, "C" + w.examId);
    joinClass(b, (db.prepare("SELECT invite_code FROM classes WHERE id = ?").get(cls) as { invite_code: string }).invite_code);
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(w.examId);
    expect(shareExam(w.userId, cls, w.examId)).toBeNull();
    const res = addSharedExam(b, (db.prepare("SELECT id FROM shared_exams WHERE exam_id = ?").get(w.examId) as { id: number }).id) as { examId: number };
    const copy = db.prepare("SELECT * FROM topics WHERE exam_id = ?").get(res.examId) as Topic;
    const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(res.examId).lastInsertRowid);
    return { b, res, copy, sessionId };
  }

  it("a copied v3 lesson that copies the slides is not current for the classmate; one that explains is", () => {
    const bad = world(oneFactEach(4));
    stored(bad, { ...lessonOf(bad, rep(4, "copy"), "old"), version: 3 });
    const badCopy = share(bad).copy;
    expect(JSON.parse(badCopy.lesson_json!).version).toBe(3);
    expect(lessonIsCurrent(badCopy)).toBe(false);

    const good = world(oneFactEach(4));
    stored(good, { ...lessonOf(good, rep(4, "cover"), "old"), version: 3 });
    expect(lessonIsCurrent(share(good).copy)).toBe(true);
  });

  it("a copied v4 lesson stays current even if it copies (the writer's repair was its one chance)", () => {
    const w = world(oneFactEach(4));
    stored(w, { ...lessonOf(w, rep(4, "copy"), "old"), version: 4 });
    expect(lessonIsCurrent(share(w).copy)).toBe(true);
  });

  it("the classmate's open rewrites the copy once (one 'lesson' call), leaving the owner's lesson alone", async () => {
    const w = world(oneFactEach(4));
    stored(w, { ...lessonOf(w, rep(4, "copy"), "old"), version: 3 });
    const { b, res, copy, sessionId } = share(w);
    currentUserId = b;
    lessonWriter = () => ({ ...lessonOf({ ...w, pages: JSON.parse(copy.page_ids) as number[] } as World, rep(4, "cover"), "fresh") });
    const body = await (await lessonGET(new Request("http://x/l?position=0"), ctx(sessionId))).json();
    expect(lessonCallsMade()).toEqual(["lesson"]);
    expect(body.lesson.version).toBe(LESSON_VERSION);
    expect(body.lesson.slides.map((s: { explanation: string }) => s.explanation).join(" ")).toContain("fresh");
    const mine = db.prepare("SELECT lesson_json FROM topics WHERE exam_id = ?").get(res.examId) as { lesson_json: string };
    expect(JSON.parse(mine.lesson_json).version).toBe(LESSON_VERSION);
    expect(JSON.parse(w.topic().lesson_json!).version).toBe(3); // the owner's copy is only rewritten when she opens it
  });

  it("a copy whose lesson lost a slide (page not copied) is judged on the slides it still has", () => {
    const w = world(oneFactEach(4));
    // copying slides: the owner's lesson copies 3 of 4 facts, but the 3 copied slides are all in the lecture that did not copy
    const failedDoc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'bad.pdf', 'error')").run(w.examId).lastInsertRowid);
    const badPage = Number(
      db.prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, 1, '', 'done', ?, 0, 1.5)").run(failedDoc, notesJson(9, [F(9)])).lastInsertRowid,
    );
    db.prepare("UPDATE topics SET page_ids = ? WHERE id = ?").run(JSON.stringify([...w.pages, badPage]), w.topicId);
    stored(w, { intro: "I", slides: [...w.pages.map((page_id, i) => ({ page_id, explanation: REV(i) })), { page_id: badPage, explanation: F(9) }], key_points: [], connections: null, version: 3 });
    expect(lessonIsCurrent(w.topic())).toBe(true); // 1 of 5 copied
    const { copy } = share(w);
    expect(JSON.parse(copy.lesson_json!).slides).toHaveLength(4);
    expect(lessonIsCurrent(copy)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the lesson route", () => {
  const get = (w: World, qs = "position=0") => lessonGET(new Request(`http://x/l?${qs}`), ctx(w.sessionId));

  it("a stored v3 lesson that copies triggers one 'lesson' call and the new lesson is what the page gets", async () => {
    const w = world(oneFactEach(3));
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, rep(3, "copy"), "old"), version: 3 });
    lessonWriter = () => lessonOf(w, rep(3, "cover"), "fresh");
    const res = await get(w);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(lessonCallsMade()).toEqual(["lesson"]);
    expect(body.lesson.version).toBe(LESSON_VERSION);
    expect(body.lesson.slides.map((s: { page_id: number }) => s.page_id)).toEqual(w.pages);
    expect(body.lesson.slides[0].explanation).toContain("fresh");
    expect(JSON.parse(w.topic().lesson_json!).version).toBe(LESSON_VERSION);
  });

  it("a stored v3 lesson that explains is served as it is with no lesson call", async () => {
    const w = world(oneFactEach(3));
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, rep(3, "cover"), "old"), version: 3 });
    const body = await (await get(w)).json();
    expect(lessonCallsMade()).toEqual([]);
    expect(body.lesson.version).toBe(3);
    expect(body.lesson.slides[0].explanation).toContain("old");
  });

  it("a prefetch of the next topic rewrites a copying v3 lesson too (the rewrite is not tied to opening it)", async () => {
    const w = world(oneFactEach(3));
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, rep(3, "copy"), "old"), version: 3 });
    lessonWriter = () => lessonOf(w, rep(3, "cover"), "fresh");
    await get(w, "position=0&prefetch=1");
    expect(lessonCallsMade()).toEqual(["lesson"]);
    expect(JSON.parse(w.topic().lesson_json!).version).toBe(LESSON_VERSION);
  });

  it("two requests at once (open plus prefetch) share one rewrite", async () => {
    const w = world(oneFactEach(3));
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, rep(3, "copy"), "old"), version: 3 });
    lessonWriter = () => lessonOf(w, rep(3, "cover"), "fresh");
    const [a, b] = await Promise.all([get(w), get(w, "position=0&prefetch=1")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(lessonCallsMade()).toEqual(["lesson"]);
  });

  it("when the rewrite fails the route serves the old v3 lesson (200) instead of an error", async () => {
    const w = world(oneFactEach(3));
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, rep(3, "copy"), "old"), version: 3 });
    lessonWriter = () => {
      throw new Error("internal boom");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get(w);
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("old");
  });

  it("a fresh topic whose first answer copies is repaired and the route serves the repaired text", async () => {
    const w = world(oneFactEach(4));
    currentUserId = w.userId;
    lessonWriter = (n) => (n === 1 ? lessonOf(w, rep(4, "copy"), "wone") : lessonOf(w, rep(4, "cover"), "wtwo"));
    const body = await (await get(w)).json();
    expect(lessonCallsMade()).toEqual(["lesson", "lesson repair"]);
    expect(body.lesson.slides[0].explanation).toContain("wtwo");
  });
});
