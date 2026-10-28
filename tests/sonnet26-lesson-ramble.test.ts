// Sonnet QA 26: attack tests for the lesson-filler trim (trimRamble, tidyLesson, cleanStoredLesson), with the focus on
// false positives (real teaching text being cut), which is the worse failure.
// Tests named "BUG: ..." document a real defect and are left failing on purpose (the comment above each gives the input,
// the wrong output and the src line). Tests named "(documented) ..." pin odd-but-acceptable behaviour.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { purpose: string; content: string; system: string };
const calls: Call[] = [];
let lessonWriter: (call: number, content: string) => unknown = () => ({});
let lessonCalls = 0;

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string; system: string }) => {
    calls.push({ purpose: opts.purpose, content: opts.content, system: opts.system });
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
import { cleanLesson, getLesson, lastLessonScan, lessonText, LESSON_VERSION, scanLessonsForFiller, type Lesson } from "@/lib/study";
import { coveredFacts, quotedFacts, RAMBLE_RUN, trimRamble } from "@/lib/lessonCoverage";
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { makeUser } from "./helpers";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});

/** The tail of the explanation in the student's screenshot. */
const RAMBLE = [
  "End.", "", "(Note: the boxes overlap only at the edges, such as 3 months.)", "", "Done.", "", "(Keep going.)", "", "Ok.", "", "Stop.", "",
  "Enough.", "", "Final.", "", "Fin.", "", ".", "", ".", "", "End of slide.", "", ".", "", "Thanks.", "", "Bye.",
].join("\n");
/** A line of real teaching text (more than three words, no list marker). */
const G = "A long enough real sentence that explains the slide in full detail.";
const GOOD =
  "Kidney injury is sorted by how fast it came on. **Acute kidney injury (AKI)** means the kidney failed within hours to days, so the cause is usually recent: a drug, dehydration, a blockage.\n\n" +
  "**Chronic kidney disease (CKD)** means the damage has been there for at least 3 months and will not come back on its own.";

const notesJson = (i: number, facts: string[]) =>
  JSON.stringify({
    title: `slide ${i}`, summary: "s", image_description: null, key_facts: facts, annotations: [], emphasized: false, emphasis_note: null,
    case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false,
  });

/** One exam, one topic over n slides (fact lists given), one study session. */
function world(n = 2, facts: (i: number) => string[] = (i) => [`fact a${i}`]) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, 'L1.pdf', 'done')").run(examId).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) =>
    Number(
      db
        .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json, emphasized, aspect) VALUES (?, ?, '', 'done', ?, 0, 1.5)")
        .run(doc, i + 1, notesJson(i, facts(i))).lastInsertRowid,
    ),
  );
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', 's', ?)").run(examId, JSON.stringify(pages)).lastInsertRowid);
  const sessionId = Number(db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId).lastInsertRowid);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  return { userId, examId, pages, topicId, sessionId, topic };
}
type World = ReturnType<typeof world>;
type Stored = { slides: { page_id: number; explanation: string; [k: string]: unknown }[]; intro: string; version?: number; key_points: string[]; connections: string | null; [k: string]: unknown };
const lessonOf = (w: World, text: (i: number) => string, extra: object = {}) => ({
  intro: "What this section is about.",
  slides: w.pages.map((page_id, i) => ({ page_id, explanation: text(i) })),
  key_points: ["k"],
  connections: null,
  ...extra,
});
const stored = (w: World, lesson: object) => db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(JSON.stringify(lesson), w.topicId);
const storedLesson = (w: World) => JSON.parse(w.topic().lesson_json!) as Stored;
const getRoute = (w: World, qs = "position=0") => lessonGET(new Request(`http://x/l?${qs}`), { params: Promise.resolve({ id: String(w.sessionId) }) } as never);
const lessonAiCalls = () => calls.filter((c) => c.purpose === "lesson" || c.purpose === "lesson repair");
const trim = (s: string) => trimRamble(s);
const kept = (s: string) => expect(trim(s)).toEqual({ text: s, trimmed: false });

beforeEach(() => {
  calls.length = 0;
  lessonCalls = 0;
  currentUserId = 0;
  lessonWriter = () => ({});
  warn.mockClear();
  error.mockClear();
});

describe("real explanation shapes that must stay", () => {
  it("bold term lines with a real sentence under each stay", () => {
    kept(`${G}\n\n**Pulp**\n\nThe soft tissue inside the tooth carries the nerve.\n\n**Dentin**\n\nThe hard layer under the enamel.\n\n**Enamel**\n\nThe outer shell, the hardest tissue in the body.`);
  });

  it("a bold term and its definition on the next line stay when the definition is a sentence", () => {
    kept(`${G}\n\n**Pulp**\nThe soft tissue inside the tooth, carrying the nerve.\n**Dentin**\nThe hard layer under the enamel, softer than enamel.`);
  });

  it("'Key idea:' and 'Remember:' lead-ins followed by sentences stay", () => {
    kept(`Key idea:\nThe nerve sits inside a sealed box, so swelling has nowhere to go.\n\nRemember:\nThat is why pulpitis hurts so much more than a cut on the skin.`);
  });

  it("one isolated emphasis line ('Why?', 'Remember:', 'Important!') between sentences stays", () => {
    kept(`${G}\n\nWhy?\n\nBecause the pulp is sealed in a rigid box and cannot swell.\n\nImportant!\n\nThe pain is the warning, not the disease itself.`);
  });

  it("Q&A with Question:/Answer: labels, and Yes./No, it does not. mixed with sentences, stays", () => {
    kept(`Question: Does the nerve die at once?\nAnswer: No, it dies slowly over days, which is why the pain lingers.\n\nYes.\nNo, it does not.\nThe tooth only turns dark after the nerve is gone.`);
  });

  it("two short answers on their own lines stay (fewer than three filler lines)", () => {
    kept("Yes.\nNo, it does not.");
    kept("See the picture.\n\nIt shows the pulp.");
  });

  it("'Stage 1.' 'Stage 2.' 'Stage 3.' stay (they have digits) at any position", () => {
    kept(`Stage 1.\nStage 2.\nStage 3.\n\n${G}`);
    kept(`${G}\n\nStage 1.\nStage 2.\nStage 3.`);
  });

  it("abbreviations inside sentences, and one short 'e.g. a crack.' line, stay", () => {
    kept(`The pulp, i.e. the nerve, dies first.\ne.g. a crack.\nThen the tooth hurts a lot at night, which is the classic sign.`);
  });

  it("single emphasis lines with asterisks and underscores stay", () => {
    kept(`${G}\n\n*Note*\n\nThe pulp has no second blood supply.\n\n_Careful_\n\nDo not confuse it with the periodontal ligament, which sits outside the root.`);
  });

  it("a lone horizontal rule between paragraphs stays", () => {
    kept(`${G}\n\n---\n\nSecond part of the explanation here is long enough to count as text.`);
    kept(`${G}\n\n---\n\nSecond part.\n\nReal long sentence continues here after the divider.`);
  });

  it("nested lists with indentation stay, including an indented continuation among items", () => {
    kept(`${G}\n\n- one\n  - two\n    - three\n      - four\n  - five\n\nAnd real text follows after the list.`);
    kept(`${G}\n\n  - one\n  - two\n  - three\n\nAnd real text follows after it.`);
  });

  it("a single emoji-only line or a '★ you emphasized this' lead line stays", () => {
    kept(`${G}\n\n📌\n\nReal text after the pin is long enough to count.`);
    kept(`★ you emphasized this\n\n${G}`);
  });

  it("a heading followed by one or two short lines and then a sentence stays", () => {
    kept(`### Causes\n\nTrauma\n\nCaries\n\nThese two are the common causes of pulp death.`);
  });

  it("a single short French/Spanish line between sentences stays; accented letters count as letters", () => {
    kept(`${G}\n\nC'est tout.\n\nLa pulpe est le tissu mou à l'intérieur de la dent.`);
    kept(`${G}\n\nEl diente.\n\nLa pulpa contiene los nervios y los vasos sanguíneos.`);
  });

  it("a lone '...' pause stays", () => {
    kept(`${G}\n\n...\n\nThe pulp then dies.`);
  });

  it("Windows line endings: real text with short lines is returned untouched, a filler tail is cut without a stray \\r", () => {
    kept(`${G}\r\n\r\nShort one.\r\n\r\nAnother real sentence that explains something at length.\r\n`.trimEnd());
    const r = trim(`${G}\r\n\r\nDone.\r\n\r\nOk.\r\n\r\nBye.\r\n`);
    expect(r).toEqual({ text: G, trimmed: true });
    expect(r.text).not.toMatch(/\r/);
  });

  it("a single very long line is one real line and stays", () => {
    const long = "word ".repeat(200000).trim();
    expect(trim(long)).toEqual({ text: long, trimmed: false });
  });

  it("a filler line made of digits, a lead-in ending in ':', a pipe row, a quote and a heading are never filler", () => {
    kept(`${G}\n\nDone 1.\nOk 2.\nBye 3.\n\nDone:\nOk:\nBye:\n\n| a |\n| b |\n| c |\n\n> q\n> r\n> s\n\n#tag\n#tag2\n#tag3`);
  });

  it("an equation line without digits is filler only in a run: 'x = y' once stays", () => {
    kept(`${G}\n\nx = y\n\nsays that the two sides balance, which is the whole idea of the equation.`);
  });

  it("a trailing whitespace-only difference is not a trim", () => {
    expect(trim(`${G}\n\n   \n`)).toEqual({ text: G, trimmed: false });
    expect(trim(`${G}   `)).toEqual({ text: G, trimmed: false });
  });
});

describe("filler that must go", () => {
  it("the screenshot tail, with CRLF and with blank lines, is cut at the first run", () => {
    expect(trim(`${GOOD}\n\n${RAMBLE}`)).toEqual({ text: GOOD, trimmed: true });
    expect(trim(`${GOOD}\n\n${RAMBLE}`.replace(/\n/g, "\r\n"))).toMatchObject({ trimmed: true });
    expect(trim(`${GOOD}\n\n${RAMBLE}`.replace(/\n/g, "\r\n")).text.replace(/\r\n/g, "\n")).toBe(GOOD);
  });

  it("three filler lines of any mix (parenthesised, one-word, punctuation, bold term) form a run", () => {
    expect(trim(`${G}\n\n(Keep going.)\n\nOk.\n\n.`).text).toBe(G);
    expect(trim(`${G}\n\n**Done**\n\n_Ok_\n\n…`).text).toBe(G);
  });

  it("fixed: short real lines in any language and bold terms are not filler (filler is known by its words); a run of punctuation pauses still goes", () => {
    kept(`${G}\n\nC'est tout.\n\nLa pulpe.\n\nEl diente.\n\nTexto real y largo después.`);
    expect(trim(`${G}\n\n...\n\n...\n\n...\n\nThe pulp then dies.`).text).toBe(G);
    kept(`${G}\n\n**AKI**\n**CKD**\n**ESKD**\n\nThese are the three stages of the disease progression overall.`);
  });

  it("(documented) text after a ramble in the middle is lost with it", () => {
    expect(trim(`${G}\n\nDone.\n\nOk.\n\nStop.\n\nThe real conclusion of the slide, which is now gone.`)).toEqual({ text: G, trimmed: true });
  });

  it("fixed: a trailing parenthesised aside with real words stays; one made of sign-off words goes", () => {
    kept(`${G}\n\n(This also explains why the pulp reacts to cold, covered on the next slide.)`);
    expect(trim(`${G}\n\n(Keep going.)`).text).toBe(G);
  });

  it("fixed: a final short line of real words ('It hurts.') stays; a sign-off ('Bye.') goes", () => {
    kept(`Key idea:\nThe nerve is inside the tooth.\nIt hurts.`);
    expect(trim(`Key idea:\nThe nerve is inside the tooth.\nBye.`).text).toBe("Key idea:\nThe nerve is inside the tooth.");
  });

  it("fixed: three short answers on three lines are real words, not filler: the entry stays", () => {
    kept("Yes.\nIt does.\nAlways.");
  });

  it("fixed: '•' and lettered ('A. Pulp', 'a) Pulp') list items are structure, never filler", () => {
    kept(`${G}\n\n• Done\n• Ok\n• Bye`);
    kept(`${G}\n\nA. Pulp\nB. Dentin\nC. Enamel\n\nreal text after the lettered options.`);
    kept(`${G}\n\na) Pulp\nb) Dentin\nc) Enamel`);
  });

  it("fixed: a bold lead-in '**Key idea:**' / '**Remember:**' is a lead-in, never filler, even when trailing", () => {
    kept(`${G}\n\n**Key idea:**\n\nThe pulp is sealed in a rigid box.`);
    kept(`${G}\n\n**Remember:**`);
  });

  it("(documented) the heading rule needs '#' as the first character: '#tag' counts as a heading, not filler", () => {
    kept(`${G}\n\n#tag\n#tag2\n#tag3`);
  });

  it("a punctuation-only run of every flavour goes", () => {
    for (const p of [".", "…", "—", "()", "!!", "?"]) expect(trim(`${G}\n\n${p}\n\n${p}\n\n${p}`).text).toBe(G);
  });
});

describe("false positives (real text cut)", () => {
  // Input: "<sentence>\n\n---\n\nSecond part.\n\n---\n\nThird part has a full sentence that explains more."
  // Wrong: everything after the first sentence is cut: "---", "Second part." and "---" are three filler lines (punctuation
  // only counts as filler), so the run starts at the first rule and the closing paragraph goes with it.
  // Source: lessonCoverage.ts:87-89 (isFiller: a markdown rule "---" / "***" / "___" has no words, so words.length <= 3).
  it("fixed: horizontal rules around a short sub-title are filler, and the text after them is cut", () => {
    kept(`${G}\n\n---\n\nSecond part.\n\n---\n\nThird part has a full sentence that explains more.`);
  });

  // Input: "<sentence>\n\n★ you emphasized this" (the phrase the lesson prompt itself asks for).
  // Wrong: the line is dropped as trailing filler (3 words, no digit): the student loses the importance marker.
  // Source: lessonCoverage.ts:127 (trailing filler dropped) with isFiller at 89; study.ts LESSON_SYSTEM line 358 asks for it.
  it("fixed: the '★ you emphasized this' marker the prompt asks for is dropped when it is the last line", () => {
    kept(`${G}\n\n★ you emphasized this`);
  });

  // Input: "<sentence>\n\n**Pulp**\nThe soft tissue inside the tooth, carrying the nerve.\n**Enamel**\nHard shell."
  // Wrong: the last term and its short definition ("**Enamel**\nHard shell.") are dropped as trailing filler.
  // Source: lessonCoverage.ts:127 (trailing filler dropped), isFiller at 89 (a 2-word definition is filler).
  it("fixed: the last term of a bold-term list is dropped when its definition is up to three words", () => {
    kept(`${G}\n\n**Pulp**\nThe soft tissue inside the tooth, carrying the nerve.\n**Enamel**\nHard shell.`);
  });

  // Input: "<sentence>\n\nPulp\nSoft tissue.\nDentin\nHard layer.\nEnamel\nOuter shell."
  // Wrong: output is just the sentence: six short lines form a run and the whole glossary is cut.
  // Source: lessonCoverage.ts:97-126 (run of RAMBLE_RUN short lines), isFiller at 89.
  it("fixed: a glossary of short terms with short definitions is cut", () => {
    kept(`${G}\n\nPulp\nSoft tissue.\nDentin\nHard layer.\nEnamel\nOuter shell.`);
  });

  // Input: "### Causes\n\nTrauma\n\nCaries\n\nCracks\n\nThese three are the common causes of pulp death."
  // Wrong: "### Causes" (the heading is the only non-filler line), the three cause names are a run, so the cut is at "Trauma"
  // and the closing sentence is lost too.
  // Source: lessonCoverage.ts:122-125 (cut = runStart); a short bullet-free list is not told apart from filler (line 89).
  it("fixed: a heading followed by three short bullet-free lines and a closing sentence is cut to the heading", () => {
    kept("### Causes\n\nTrauma\n\nCaries\n\nCracks\n\nThese three are the common causes of pulp death.");
  });

  // Input: "Pulp\nDentin\nEnamel\n\nThe tooth has these three layers, and each one has a job."
  // Wrong: { text: "", trimmed: true }: a run at the very start puts the cut at line 0, so the whole entry, including the
  // long sentence, is empty (a stored lesson would then lose the slide, see the stored-lesson test below).
  // Source: lessonCoverage.ts:122-125 (cut = runStart = 0) and 114-128; the all-filler check at 110 is passed by the sentence.
  it("fixed: an explanation that opens with three short lines and then teaches loses everything", () => {
    kept("Pulp\nDentin\nEnamel\n\nThe tooth has these three layers, and each one has a job.");
  });

  // Input: three Chinese sentences, one per line ("牙髓是牙齿内部的神经和血管组织。" ...).
  // Wrong: { text: "", trimmed: true }: a language written without spaces has one "word" per line, so every line is filler.
  // Source: lessonCoverage.ts:87-89 (word count by letter runs; CJK has none between words).
  it("fixed: an explanation written in Chinese (no spaces between words) is all filler", () => {
    const zh = "牙髓是牙齿内部的神经和血管组织。\n\n它被牙本质包围，所以肿胀时没有空间。\n\n这就是牙髓炎特别疼的原因。";
    kept(zh);
  });

  it("list items are structure whatever marker they use, even when their words are sign-offs", () => {
    kept(`${G}\n\n- Done\n- Ok\n- Bye`);
    kept(`${G}\n\n* Done\n* Ok\n* Bye`);
    kept(`${G}\n\n1. Done\n2. Ok\n3. Bye`);
  });
});

describe("code fences", () => {
  it("filler-looking lines inside a closed ``` or ~~~ fence stay, and filler after it is cut", () => {
    const a = `${G}\n\n\`\`\`\nDone.\nOk.\nBye.\n\`\`\`\n\nDone.\n\nOk.\n\nBye.`;
    expect(trim(a)).toEqual({ text: `${G}\n\n\`\`\`\nDone.\nOk.\nBye.\n\`\`\``, trimmed: true });
    const b = `${G}\n\n~~~\nDone.\nOk.\nBye.\n~~~\n\nDone.\n\nOk.\n\nBye.`;
    expect(trim(b).text).toBe(`${G}\n\n~~~\nDone.\nOk.\nBye.\n~~~`);
  });

  it("a fence immediately followed by filler: the fence stays whole, the filler goes", () => {
    expect(trim(`${G}\n\n\`\`\`\nx\n\`\`\`\nDone.\nOk.\nBye.`).text).toBe(`${G}\n\n\`\`\`\nx\n\`\`\``);
    expect(trim(`${G}\n\n~~~~\nx\n~~~~\nDone.\nOk.\nBye.`).text).toBe(`${G}\n\n~~~~\nx\n~~~~`);
  });

  it("a fence with an info string and CRLF endings is honoured", () => {
    const t = "A real sentence here is long enough.\r\n```text\r\nDone.\r\nOk.\r\nBye.\r\n```\r\nAfter the block the explanation continues here.";
    expect(trim(t)).toEqual({ text: t, trimmed: false });
  });

  it("(documented) an unclosed fence protects everything after it, so a ramble there is kept", () => {
    const t = `${G}\n\n\`\`\`\nDone.\nOk.\nBye.\nStop.`;
    expect(trim(t)).toEqual({ text: t, trimmed: false });
  });

  it("a ``` in the middle of a line is not a fence: the ramble after it is cut", () => {
    expect(trim(`${G} text \`\`\` more\n\nDone.\n\nOk.\n\nBye.`).text).toBe(`${G} text \`\`\` more`);
    expect(trim(`${G}\n\nUse the \`\`\` marker to open a block\n\nDone.\n\nOk.\n\nBye.`).text).toBe(`${G}\n\nUse the \`\`\` marker to open a block`);
  });

  it("(documented) fence kinds are not matched: ~~~ closes a ``` fence, and ```x``` on one line opens one that never closes", () => {
    // "```\nx\n~~~\nDone..." : the ~~~ toggles the fence off, so the lines after it are judged as prose and cut.
    expect(trim(`${G}\n\n\`\`\`\nx\n~~~\nDone.\nOk.\nBye.\n\`\`\`\nafter`).text).toBe(`${G}\n\n\`\`\`\nx\n~~~`);
    const t = `${G}\n\n\`\`\`x\`\`\`\nDone.\nOk.\nBye.`;
    expect(trim(t)).toEqual({ text: t, trimmed: false });
  });

  it("a text made only of a fenced block is kept, however short its lines", () => {
    const t = "```\nDone.\nOk.\nBye.\n```";
    expect(trim(t)).toEqual({ text: t, trimmed: false });
  });

  it("filler between two fences is judged outside them: one line stays, a run of three goes with what follows", () => {
    const one = `${G}\n\n\`\`\`\nx\n\`\`\`\nOk.\n\`\`\`\ny\n\`\`\``;
    expect(trim(one)).toEqual({ text: one, trimmed: false });
    expect(trim(`${G}\n\n\`\`\`\nx\n\`\`\`\nOk.\nDone.\nBye.\n\`\`\`\ny\n\`\`\``).text).toBe(`${G}\n\n\`\`\`\nx\n\`\`\``);
  });
});

describe("trimRamble properties", () => {
  it("random mixes of lines: the result is a prefix of the input, is stable when trimmed again, and 'trimmed' tells the truth", () => {
    const pool = [
      G, "Done.", "Ok.", "", "", "(Keep going.)", "---", "**Pulp**", "- item", "## Heading", "```", "~~~", "Why?", "Stage 1.", "...", "★ you emphasized this",
      "A second ordinary sentence with more than three words.", "Bye.", "x = 3", "|a|b|", "> q", "Remember:", "   ", "\t- tab item", "牙髓。",
    ];
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let t = 0; t < 600; t++) {
      const lines = Array.from({ length: rnd(14) }, () => pool[rnd(pool.length)]);
      const input = lines.join(rnd(4) === 0 ? "\r\n" : "\n");
      const r = trim(input);
      expect(input.startsWith(r.text) || r.text === "").toBe(true);
      expect(r.trimmed).toBe(r.text !== input.trimEnd());
      expect(trim(r.text)).toEqual({ text: r.text, trimmed: false });
      expect(r.text).toBe(r.text.trimEnd());
    }
  });

  it("a text never grows and never gains characters", () => {
    for (const t of [RAMBLE, `${GOOD}\n\n${RAMBLE}`, "", "x", "\n\n", "Done.\n\nOk.\n\nBye."]) expect(trim(t).text.length).toBeLessThanOrEqual(t.length);
  });
});

describe("performance", () => {
  const ms = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  trim("warm up.\n\nDone.\nOk.\nBye.\n" + G); // JIT before the clock

  it("50,000 lines of real text stay fast (< 200 ms)", () => {
    const t = Array.from({ length: 50000 }, (_, i) => `${G} Line ${i} adds more.`).join("\n");
    expect(ms(() => trim(t))).toBeLessThan(200);
  });

  it("50,000 filler lines after one sentence are cut fast", () => {
    const t = `${G}\n${"Done.\n".repeat(50000)}`;
    let r!: ReturnType<typeof trim>;
    expect(ms(() => (r = trim(t)))).toBeLessThan(200);
    expect(r.text).toBe(G);
  });

  it("50,000 alternating real/short lines (never a run of three) stay and are fast", () => {
    const t = Array.from({ length: 25000 }, () => `${G}\nOk.`).join("\n").replace(/\nOk\.$/, "");
    expect(ms(() => trim(t))).toBeLessThan(200);
    expect(trim(t).trimmed).toBe(false);
  });

  it("50,000 blank lines between three fillers and a long fenced block are fast", () => {
    const t = `${G}\n${"\n".repeat(50000)}Done.\n${"\n".repeat(50000)}Ok.\n\`\`\`\n${"Done.\n".repeat(20000)}\`\`\`\n`;
    expect(ms(() => trim(t))).toBeLessThan(200);
  });

  it("a 2 MB single line is fast", () => {
    const t = "word ".repeat(400000);
    expect(ms(() => trim(t))).toBeLessThan(200);
  });
});

describe("stored lessons through getLesson", () => {
  it("the clean lesson saved back keeps the version, key_points, connections and extra fields (lesson and slide level)", async () => {
    const w = world();
    stored(w, {
      ...lessonOf(w, (i) => (i === 0 ? `${GOOD}\n\n${RAMBLE}` : GOOD), { key_points: ["★ a", "b"], connections: "Exam 1, Q4", extraField: { deep: [1, 2] } }),
      version: 3,
    });
    const before = storedLesson(w);
    before.slides[0].note = "slide extra";
    stored(w, before);
    const lesson = await getLesson(w.topic());
    expect(lessonAiCalls()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const after = storedLesson(w);
    expect(after).toEqual({ ...before, slides: [{ ...before.slides[0], explanation: GOOD }, before.slides[1]] });
    expect(after.version).toBe(3);
    expect(after.extraField).toEqual({ deep: [1, 2] });
    expect(after.slides[0].note).toBe("slide extra");
    expect(lesson).toEqual(after);
  });

  it("a second open of a cleaned lesson writes nothing and warns nothing", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    await getLesson(w.topic());
    const saved = w.topic().lesson_json;
    warn.mockClear();
    await getLesson(w.topic());
    expect(w.topic().lesson_json).toBe(saved);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a lesson with no filler is neither rewritten in the database nor warned about, whatever its whitespace", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, () => `${GOOD}\n\n  \n`), version: LESSON_VERSION });
    const before = w.topic().lesson_json;
    const l = await getLesson(w.topic());
    expect(w.topic().lesson_json).toBe(before);
    expect(l.slides[0].explanation).toBe(`${GOOD}\n\n  \n`);
    expect(warn).not.toHaveBeenCalled();
  });

  // Input: a stored current lesson whose every slide is a filler run (RAMBLE).
  // Wrong: getLesson serves { slides: [] } and saves it over the stored lesson at the current version, so it is never rewritten
  // (the student sees an intro and nothing else, for good). A fresh lesson at least gets a repair call (study.ts tidyLesson).
  // Source: study.ts:249 (slides dropped), 255 (saved back at the same version), 181 (lessonIsCurrent keeps serving it).
  it("fixed: a stored lesson whose slides are all filler is served with no slides and never rewritten", async () => {
    const w = world(3);
    lessonWriter = () => lessonOf(w, (i) => `${GOOD} fact a${i}`);
    stored(w, { ...lessonOf(w, () => RAMBLE), version: LESSON_VERSION });
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.length).toBeGreaterThan(0);
  });

  // Input: stored slide 0 = "Pulp\nDentin\nEnamel\n\nThe tooth has these three layers, and each one has a job." (see BUG above).
  // Wrong: the slide is deleted from the stored lesson and the deletion is saved; no repair ever asks for it.
  // Source: study.ts:243-249 + 255 on top of lessonCoverage.ts:122-125.
  it("fixed: a stored slide that opens with three short lines loses its whole explanation for good", async () => {
    const w = world();
    const real = "Pulp\nDentin\nEnamel\n\nThe tooth has these three layers, and each one has a job.";
    stored(w, { ...lessonOf(w, (i) => (i === 0 ? real : GOOD)), version: LESSON_VERSION });
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
    expect(storedLesson(w).slides[0].explanation).toBe(real);
  });

  it("(documented) a stored slide that was all filler is dropped for good (no repair for stored lessons), the others stay", async () => {
    const w = world(3);
    stored(w, { ...lessonOf(w, (i) => (i === 1 ? RAMBLE : GOOD)), version: LESSON_VERSION });
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.map((s) => s.page_id)).toEqual([w.pages[0], w.pages[2]]);
    expect(storedLesson(w).slides.map((s) => s.page_id)).toEqual([w.pages[0], w.pages[2]]);
    expect(lessonAiCalls()).toHaveLength(0);
  });

  it("(documented) an empty or whitespace-only stored explanation is not filler: it is served as it is and nothing is saved", async () => {
    const w = world(3);
    stored(w, { ...lessonOf(w, (i) => (i === 0 ? "" : i === 1 ? "   \n " : GOOD)), version: LESSON_VERSION });
    const before = w.topic().lesson_json;
    const lesson = await getLesson(w.topic());
    expect(lesson.slides.map((s) => s.page_id)).toEqual(w.pages);
    expect(w.topic().lesson_json).toBe(before);
  });

  it("a lesson whose intro is all filler gets an empty intro, slides and the rest intact", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, () => GOOD, { intro: RAMBLE, key_points: ["k1", "k2"], connections: "c" }), version: LESSON_VERSION });
    const lesson = await getLesson(w.topic());
    expect(lesson.intro).toBe("");
    expect(lesson.slides).toHaveLength(2);
    const s = storedLesson(w);
    expect(s.intro).toBe("");
    expect(s.key_points).toEqual(["k1", "k2"]);
    expect(s.connections).toBe("c");
  });

  it("an intro with a filler tail is cut; a one-line short intro ('About the pulp.') is kept", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, () => GOOD, { intro: "What this is about.\n\nDone.\n\nOk.\n\nBye." }), version: LESSON_VERSION });
    expect((await getLesson(w.topic())).intro).toBe("What this is about.");
    const v = world();
    stored(v, { ...lessonOf(v, () => GOOD, { intro: "About the pulp." }), version: LESSON_VERSION });
    const before = v.topic().lesson_json;
    expect((await getLesson(v.topic())).intro).toBe("About the pulp.");
    expect(v.topic().lesson_json).toBe(before);
  });

  it("malformed stored shapes (arrays, strings, numbers, null as slides; no slides; object slides) never throw", async () => {
    const w = world();
    stored(w, {
      intro: "I",
      slides: [null, "str", 5, [], { page_id: w.pages[0], explanation: { a: 1 } }, { page_id: w.pages[1], explanation: RAMBLE }, { page_id: w.pages[0], explanation: GOOD }],
      key_points: [],
      connections: null,
      version: LESSON_VERSION,
    });
    const lesson = await getLesson(w.topic());
    // the null entry and the all-filler entry go; the odd ones are kept as they are
    expect(lesson.slides).toHaveLength(5);
    expect(lesson.slides.at(-1)!.explanation).toBe(GOOD);
    expect(lessonText(lesson)).not.toMatch(/Bye/);
    for (const odd of [{ version: LESSON_VERSION }, { slides: {}, intro: 3, version: LESSON_VERSION }, { slides: null, intro: null, version: LESSON_VERSION }]) {
      stored(w, odd);
      const before = w.topic().lesson_json;
      await expect(getLesson(w.topic())).resolves.toBeTruthy();
      expect(w.topic().lesson_json).toBe(before);
    }
  });

  it("(documented) a stored object/string 'slides' passes getLesson but the route answers 500, not a crash", async () => {
    const w = world();
    currentUserId = w.userId;
    stored(w, { intro: "I", slides: "nope", key_points: [], connections: null, version: LESSON_VERSION });
    const res = await getRoute(w);
    expect(res.status).toBe(500);
  });

  it("the fallback after a failed rewrite serves the stored v3 lesson clean and saves it clean (still v3, so the rewrite is retried)", async () => {
    const facts = ["the soft pulp fills the root canal space", "dentin lies between enamel and the pulp", "enamel is the hardest tissue of the body"];
    const w = world(3, (i) => [facts[i]]);
    // v3 text that repeats the slides' sentences, so it is not "current" and a rewrite is tried
    stored(w, { ...lessonOf(w, (i) => `${facts[i]}.\n\n${RAMBLE}`, { key_points: ["kp"], connections: "cn" }), version: 3 });
    lessonWriter = () => {
      throw new Error("AI is down");
    };
    const lesson = await getLesson(w.topic());
    expect(lessonAiCalls()).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    expect(lesson.slides.map((s) => s.explanation)).toEqual(facts.map((f) => `${f}.`));
    const s = storedLesson(w);
    expect(s.version).toBe(3);
    expect(s.slides.map((x) => x.explanation)).toEqual(facts.map((f) => `${f}.`));
    expect([s.key_points, s.connections]).toEqual([["kp"], "cn"]);
    // second open retries the rewrite again (still not current)
    lessonWriter = () => lessonOf(w, (i) => `Own words about fact ${i}. ${facts[i].split(" ").reverse().join(" ")}`);
    await getLesson(w.topic());
    expect(lessonAiCalls().length).toBeGreaterThan(1);
  });

  it("the fallback with nothing to clean leaves the stored text alone", async () => {
    const facts = ["the soft pulp fills the root canal space", "dentin lies between enamel and the pulp", "enamel is the hardest tissue of the body"];
    const w = world(3, (i) => [facts[i]]);
    stored(w, { ...lessonOf(w, (i) => `${facts[i]}.`), version: 3 });
    const before = w.topic().lesson_json;
    lessonWriter = () => {
      throw new Error("down");
    };
    await getLesson(w.topic());
    expect(w.topic().lesson_json).toBe(before);
  });

  it("an old (version 1 or 2) lesson has no slide-by-slide form: a failed rewrite still throws", async () => {
    const w = world();
    stored(w, { intro: "I", slides: [{ page_id: w.pages[0], explanation: `x\n\n${RAMBLE}` }], key_points: [], connections: null, version: 2 });
    lessonWriter = () => {
      throw new Error("down");
    };
    await expect(getLesson(w.topic())).rejects.toThrow("down");
  });

  it("concurrent opens of the same stored lesson each get the clean lesson and leave one consistent row", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    const snap = w.topic();
    const all = await Promise.all([getLesson(snap), getLesson(w.topic()), getLesson(snap), getLesson(w.topic())]);
    for (const l of all) expect(l.slides.map((s) => s.explanation)).toEqual([GOOD, GOOD]);
    expect(storedLesson(w).slides.map((s) => s.explanation)).toEqual([GOOD, GOOD]);
    expect(lessonAiCalls()).toHaveLength(0);
  });

  it("(documented) a stale topic snapshot cleaned after a newer lesson was saved overwrites the newer one", async () => {
    const w = world();
    stored(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    const stale = w.topic();
    stored(w, { ...lessonOf(w, () => "A newer lesson text, much longer than three words.", { intro: "Newer" }), version: LESSON_VERSION });
    await getLesson(stale);
    expect(storedLesson(w).intro).toBe("What this section is about.");
  });

  it("cleaning one topic's lesson leaves another topic's identical stored lesson alone", async () => {
    const a = world();
    const b = world();
    stored(a, { ...lessonOf(a, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    const bLesson = { ...lessonOf(b, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION };
    stored(b, bLesson);
    await getLesson(a.topic());
    expect(storedLesson(b)).toEqual(bLesson);
    expect(storedLesson(a).slides[0].explanation).toBe(GOOD);
  });
});

describe("stored lessons through the route", () => {
  it("serves the clean lesson, saves it, keeps version/key_points/connections/extra fields, and makes no lesson AI call", async () => {
    const w = world();
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, (i) => (i === 1 ? `${GOOD}\n\n${RAMBLE}` : GOOD), { key_points: ["★ a"], connections: "cn", extraField: 7 }), version: LESSON_VERSION });
    const res = await getRoute(w);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lesson.slides.map((s: { explanation: string }) => s.explanation)).toEqual([GOOD, GOOD]);
    expect(body.lesson).toMatchObject({ version: LESSON_VERSION, key_points: ["★ a"], connections: "cn", extraField: 7 });
    expect(JSON.stringify(body)).not.toMatch(/Bye|Keep going|End of slide/);
    expect(storedLesson(w).slides[1].explanation).toBe(GOOD);
    expect(lessonAiCalls()).toHaveLength(0);
  });

  it("a prefetch cleans too, and the real open afterwards finds nothing more to do", async () => {
    const w = world();
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    expect((await getRoute(w, "position=0&prefetch=1")).status).toBe(200);
    expect(storedLesson(w).slides[0].explanation).toBe(GOOD);
    warn.mockClear();
    expect((await getRoute(w)).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("another user's request is a 404 that cleans nothing, leaks nothing and calls no AI; no sign-in is a 401", async () => {
    const w = world();
    const stranger = makeUser();
    stored(w, { ...lessonOf(w, () => `SECRET-INTRO ${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    const before = w.topic().lesson_json;
    currentUserId = stranger;
    const res = await getRoute(w);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/SECRET|Bye|slides/);
    currentUserId = 0;
    expect((await getRoute(w)).status).toBe(401);
    expect(w.topic().lesson_json).toBe(before);
    expect(calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("concurrent route opens of one stored lesson all answer 200 with the same clean lesson", async () => {
    const w = world();
    currentUserId = w.userId;
    stored(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    const res = await Promise.all([getRoute(w), getRoute(w), getRoute(w, "position=0&prefetch=1")]);
    const bodies = await Promise.all(res.map((r) => r.json()));
    for (const b of bodies) expect(b.lesson.slides.map((s: { explanation: string }) => s.explanation)).toEqual([GOOD, GOOD]);
    expect(storedLesson(w).slides.map((s) => s.explanation)).toEqual([GOOD, GOOD]);
  });

  it("a stored slide that belongs to a removed page is filtered after cleaning, and the page that is there is cleaned", async () => {
    const w = world();
    currentUserId = w.userId;
    stored(w, {
      intro: "I",
      slides: [{ page_id: 987654, explanation: `${GOOD}\n\n${RAMBLE}` }, { page_id: w.pages[0], explanation: `${GOOD}\n\n${RAMBLE}` }],
      key_points: [],
      connections: null,
      version: LESSON_VERSION,
    });
    const body = await (await getRoute(w)).json();
    expect(body.lesson.slides).toEqual([{ page_id: w.pages[0], explanation: GOOD }]);
  });
});

describe("fresh lessons", () => {
  it("the repair prompt names a slide whose entry was all filler, and carries none of the filler", async () => {
    const w = world();
    lessonWriter = (n) => (n === 1 ? lessonOf(w, (i) => (i === 0 ? RAMBLE : `${GOOD} fact a1`)) : lessonOf(w, (i) => `${GOOD} fact a${i}`));
    await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    const repair = calls[1].content.slice(calls[1].content.indexOf("Your previous lesson"));
    expect(repair).toContain("These slides have facts or a question but got no entry");
    expect(repair).toContain(`- [P${w.pages[0]}] L1.pdf slide 1`);
    expect(repair).not.toContain(`- [P${w.pages[1]}]`);
    expect(repair).not.toMatch(/Bye|Keep going|End of slide/);
  });

  it("(documented) when the repair also returns only filler for that slide, the lesson is stored without it at the current version", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, (i) => (i === 0 ? RAMBLE : `${GOOD} fact a1`));
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    expect(lesson.slides.map((s) => s.page_id)).toEqual([w.pages[1]]);
    const s = storedLesson(w);
    expect(s.version).toBe(LESSON_VERSION);
    expect(s.slides.map((x) => x.page_id)).toEqual([w.pages[1]]);
  });

  it("(documented) when every slide is filler both times, a lesson with no slides is stored at the current version", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, () => RAMBLE);
    const lesson = await getLesson(w.topic());
    expect(lesson.slides).toEqual([]);
    expect(storedLesson(w).version).toBe(LESSON_VERSION);
  });

  it("(documented) filler in key_points and connections is left as the writer wrote it", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, (i) => `${GOOD} fact a${i}`, { key_points: ["Done.", "Ok.", "Bye.", "★ real point"], connections: RAMBLE });
    const lesson = await getLesson(w.topic());
    expect(lesson.key_points).toEqual(["Done.", "Ok.", "Bye.", "★ real point"]);
    expect(lesson.connections).toBe(RAMBLE);
  });

  it("a slide given twice: a filler-only entry is skipped, and two real entries are each trimmed before they are joined", async () => {
    const w = world();
    lessonWriter = () => ({
      intro: "I",
      slides: [
        { page_id: w.pages[0], explanation: `${GOOD} fact a0\n\n${RAMBLE}` },
        { page_id: w.pages[0], explanation: RAMBLE },
        { page_id: w.pages[0], explanation: `${G}\n\nDone.\n\nOk.\n\nBye.` },
        { page_id: w.pages[1], explanation: `${GOOD} fact a1` },
      ],
      key_points: [],
      connections: null,
    });
    const lesson = await getLesson(w.topic());
    expect(lesson.slides[0].explanation).toBe(`${GOOD} fact a0\n\n${G}`);
    expect(lessonText(lesson)).not.toMatch(/Bye|Keep going|End of slide/);
  });

  it("the copy check works on the trimmed text: a copy that sits only in the filler tail does not trigger a repair", async () => {
    const facts = ["pulp holds nerves and blood vessels inside tooth", "dentin lies between enamel and pulp layer", "enamel covers crown and protects dentin underneath"];
    const own = [
      "Inside each tooth sits the pulp. It holds nerves, plus blood vessels.",
      "Between the enamel and the pulp layer lies dentin, the middle layer.",
      "Enamel covers the crown and shields the dentin below.",
    ];
    const w = world(3, (i) => [facts[i]]);
    // the copied fact is an aside right before a run of sign-offs: it goes with the run
    const raw = (i: number) => `${own[i]}\n\n(${facts[i]})\n\nDone.\n\nOk.\n\nBye.`;
    // premise: on the raw text the lesson would count as a copy and the checks would ask for a repair
    const rawText = [0, 1, 2].map(raw).join("\n\n");
    expect(quotedFacts(rawText, facts).ratio).toBe(1);
    expect(coveredFacts([0, 1, 2].map((i) => own[i]).join("\n\n"), facts).ratio).toBe(1);
    lessonWriter = () => lessonOf(w, raw);
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(lesson.slides.map((s) => s.explanation)).toEqual(own);
  });

  it("coverage is computed on the trimmed text: a fact that is only named in the filler tail is asked for in the repair", async () => {
    const fact = "enamel dentin cementum";
    const w = world(1, () => [fact]);
    const body = "Teeth are built in layers, and each layer has its own job in protecting the nerve.";
    const first = `${body}\n\n(Enamel dentin cementum.)\n\nDone.\n\nOk.\n\nBye.`;
    // premise: the raw text would count the fact as covered
    expect(coveredFacts(first, [fact]).ratio).toBe(1);
    expect(coveredFacts(trim(first).text, [fact]).ratio).toBe(0);
    lessonWriter = (n) => lessonOf(w, () => (n === 1 ? first : `${body} The three layers are enamel, dentin and cementum.`));
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson", "lesson repair"]);
    expect(calls[1].content).toContain("These facts from the slides are missing");
    expect(calls[1].content).toContain(`- ${fact}`);
    expect(lesson.slides[0].explanation).toMatch(/cementum\.$/);
  });

  it("a writer reply with the filler spread across the entry and the intro leaves one clean stored lesson", async () => {
    const w = world();
    lessonWriter = () => lessonOf(w, (i) => `${GOOD} fact a${i}\n\n${RAMBLE}`, { intro: `One sentence about the kidney.\n\n${RAMBLE}` });
    const lesson = await getLesson(w.topic());
    expect(calls.map((c) => c.purpose)).toEqual(["lesson"]);
    expect(lesson.intro).toBe("One sentence about the kidney.");
    expect(JSON.stringify(storedLesson(w))).not.toMatch(/Bye|Keep going|End of slide/);
    expect(RAMBLE_RUN).toBe(3);
  });
});

describe("the start-up scan and cleanLesson", () => {
  const put = (w: World, lesson: unknown) => db.prepare("UPDATE topics SET lesson_json = ? WHERE id = ?").run(typeof lesson === "string" ? lesson : JSON.stringify(lesson), w.topicId);
  const hit = (w: World) => lastLessonScan()?.found.find((h) => h.topicId === w.topicId);

  it("cleanLesson does not touch its input, is stable on its own output, and returns the same object when nothing changes", () => {
    const l = lessonOf(world(), () => `${GOOD}\n\n${RAMBLE}`, { version: 3 }) as unknown as Lesson;
    const frozen = JSON.stringify(l);
    const c = cleanLesson(l);
    expect(JSON.stringify(l)).toBe(frozen);
    expect(c.changed).toBe(true);
    const again = cleanLesson(c.lesson);
    expect(again.changed).toBe(false);
    expect(again.lesson).toBe(c.lesson);
  });

  it("(documented) a null entry is removed only together with a real change; on its own the lesson is returned as it is", () => {
    const w = world();
    const base = { intro: "I", slides: [null, { page_id: w.pages[0], explanation: GOOD }], key_points: [], connections: null };
    expect(cleanLesson(base as unknown as Lesson)).toMatchObject({ changed: false });
    expect(cleanLesson({ ...base, slides: [...base.slides, { page_id: w.pages[1], explanation: `${GOOD}\n\n${RAMBLE}` }] } as unknown as Lesson).lesson.slides).toHaveLength(2);
  });

  it("the scan cleans every kind of stored lesson (old versions too) without an AI call, keeping version and extra fields", () => {
    const old = world();
    put(old, { ...lessonOf(old, () => `${GOOD}\n\n${RAMBLE}`, { extra: 1 }), version: 2 });
    const none = world();
    const fine = world();
    put(fine, { ...lessonOf(fine, () => GOOD), version: LESSON_VERSION });
    const fineBefore = fine.topic().lesson_json;
    const scan = scanLessonsForFiller();
    expect(lessonAiCalls()).toHaveLength(0);
    expect(scan.found.map((h) => h.topicId)).toContain(old.topicId);
    expect(storedLesson(old)).toMatchObject({ version: 2, extra: 1 });
    expect(storedLesson(old).slides.map((s) => s.explanation)).toEqual([GOOD, GOOD]);
    expect(none.topic().lesson_json).toBeNull();
    expect(fine.topic().lesson_json).toBe(fineBefore);
    expect(scanLessonsForFiller().found).toEqual([]);
    expect(hit(old)).toMatchObject({ trimmed: 2, dropped: 0, intro: false });
  });

  // Input: a stored current lesson whose slide 0 is "Pulp\nDentin\nEnamel\n\nThe tooth has these three layers, ...".
  // Wrong: the start-up scan deletes the slide from the lesson of every student, without anyone opening it, and records it as
  // a "dropped" filler slide; the text cannot be recovered (the lesson is current, so it is never repaired).
  // Source: study.ts cleanLesson (the `dropped` branch) on top of lessonCoverage.ts:122-125; scanLessonsForFiller saves it.
  it("fixed: the scan silently deletes a slide whose real explanation opens with three short lines", () => {
    const w = world();
    const real = "Pulp\nDentin\nEnamel\n\nThe tooth has these three layers, and each one has a job.";
    put(w, { ...lessonOf(w, (i) => (i === 0 ? real : GOOD)), version: LESSON_VERSION });
    scanLessonsForFiller();
    expect(storedLesson(w).slides.map((s) => s.page_id)).toEqual(w.pages);
  });

  it("fixed: a short real intro followed by a ramble keeps its sentence and loses the ramble", () => {
    const w = world();
    put(w, { ...lessonOf(w, () => GOOD, { intro: `About the kidney.\n\n${RAMBLE}` }), version: LESSON_VERSION });
    scanLessonsForFiller();
    expect(storedLesson(w).intro).toBe("About the kidney.");
    expect(hit(w)).toMatchObject({ intro: true });
  });

  it("(documented) the record of everything ever found only grows: a lesson found once stays listed after it is clean", () => {
    const w = world();
    put(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    scanLessonsForFiller();
    scanLessonsForFiller();
    scanLessonsForFiller();
    expect(lastLessonScan()!.found.filter((h) => h.topicId === w.topicId)).toHaveLength(1);
  });

  it("odd rows (not JSON, a JSON scalar, an array, no slides) don't stop the scan from cleaning the next lesson", () => {
    const bad = [world(), world(), world(), world()];
    put(bad[0], "{not json");
    put(bad[1], "7");
    put(bad[2], "[]");
    put(bad[3], { intro: "x", slides: null, version: LESSON_VERSION });
    const w = world();
    put(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    expect(() => scanLessonsForFiller()).not.toThrow();
    expect(storedLesson(w).slides[0].explanation).toBe(GOOD);
    expect(bad[0].topic().lesson_json).toBe("{not json");
  });

  it("a lesson opened after the scan finds nothing to clean (no second warning) and an opened one is not listed by the scan", async () => {
    const w = world();
    put(w, { ...lessonOf(w, () => `${GOOD}\n\n${RAMBLE}`), version: LESSON_VERSION });
    await getLesson(w.topic());
    warn.mockClear();
    const scan = scanLessonsForFiller();
    expect(scan.found.map((h) => h.topicId)).not.toContain(w.topicId);
    expect(warn).not.toHaveBeenCalled();
  });
});
