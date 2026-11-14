// A fake AI for browser tests and previews (docs/EXAM-PLAN.md, "Fake AI for browser tests").
//
// AI_FAKE=1 makes generate() and the slide batch helpers in lib/ai.ts answer from the writers below instead of calling
// Claude or ChatGPT: no network, no cost, the same answer for the same prompt. Each writer reads the prompt the real
// caller builds (slide lines "[P12] …", fact lines "- F3: …", planned questions "Q4: slide P12 — fact: "…" — …") and
// answers in the caller's own schema; the answer is then checked against that schema, so a writer that drifts from a
// caller fails loudly in the tests instead of quietly. Questions have exactly one right option (the fact itself) and
// distractors that say they are fake.
//
// AI_FAKE_DELAY_MS (default 0) makes every fake answer wait that long, so a browser test can see "writing…" states.
// AI_FAKE_FAIL="<purpose>:<n>" makes the n-th fake call with that purpose fail like a busy service (see fakeFailure).
//
// It is never a fallback, and it is refused in production: the server will not start with AI_FAKE set there
// (instrumentation.ts), and generate() refuses it too. Fake calls still need a signed-in student with a key on file
// (the callers read credentials as usual), and they are logged to ai_usage with model "fake" and cost 0.
import crypto from "crypto";
import type { z } from "zod";
import { keyWords } from "./lessonCoverage";

export const FAKE_MODEL = "fake";

/** The fake is on (AI_FAKE=1). Whether it may be used is fakeRefusal's business. */
export const fakeOn = (env: NodeJS.ProcessEnv = process.env) => env.AI_FAKE === "1";

/** Why the fake can't be used here, or null when it can: never in production. */
export function fakeRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.NODE_ENV === "production" ? "AI_FAKE must not be set in production" : null;
}

/** Wait AI_FAKE_DELAY_MS (0 when unset or not a number). */
export async function fakeDelay(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const ms = Number(env.AI_FAKE_DELAY_MS ?? 0);
  if (Number.isFinite(ms) && ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 120_000)));
}

type Content = string | ({ type: "text"; text: string } | { type: "image"; base64: string })[];

/** The prompt as one text (pictures left out). */
export const promptText = (content: Content): string =>
  typeof content === "string" ? content : content.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n\n");

/**
 * The fake answer to one call, checked against the caller's schema (throws when it doesn't fit, or when no writer
 * knows the purpose). Waits AI_FAKE_DELAY_MS first.
 */
export async function fakeAnswer<S extends z.ZodType>(opts: { purpose: string; schema: S; system: string; content: Content }): Promise<z.infer<S>> {
  await fakeDelay();
  fakeFailure(opts.purpose);
  return fakeAnswerNow(opts);
}

// Calls answered so far per purpose (per server process), for AI_FAKE_FAIL.
const fakeCalls = new Map<string, number>();

/**
 * AI_FAKE_FAIL="practice questions:2" makes the 2nd fake call with that purpose throw like a busy AI service (not a
 * key problem), so a browser test can watch an exam come up short and finish itself. Several can be given, separated
 * by commas. Unset: nothing ever fails.
 */
export function fakeFailure(purpose: string, env: NodeJS.ProcessEnv = process.env) {
  const spec = env.AI_FAKE_FAIL;
  if (!spec) return;
  const n = (fakeCalls.get(purpose) ?? 0) + 1;
  fakeCalls.set(purpose, n);
  for (const part of spec.split(",")) {
    const at = part.lastIndexOf(":");
    if (at > 0 && part.slice(0, at).trim() === purpose && Number(part.slice(at + 1)) === n) throw new Error("Fake AI: overloaded (529)");
  }
}

/** fakeAnswer without the delay (the batch helpers answer a whole batch at once). */
export function fakeAnswerNow<S extends z.ZodType>(opts: { purpose: string; schema: S; system: string; content: Content }): z.infer<S> {
  const writer = WRITERS[opts.purpose.replace(/ \(batch\)$/, "")];
  if (!writer) throw new Error(`The fake AI has no writer for "${opts.purpose}".`);
  const raw = writer(promptText(opts.content));
  const parsed = opts.schema.safeParse(raw);
  if (!parsed.success) throw new Error(`The fake AI's answer for "${opts.purpose}" doesn't fit the caller's schema: ${parsed.error.message.slice(0, 500)}`);
  return parsed.data as z.infer<S>;
}

// ---- Reading the prompts ----

/** A short stable tag for a prompt, so answers differ between prompts but not between runs. */
const tag = (text: string) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 6);

type FactLine = { n: number | null; text: string };
type Slide = { id: number; title: string; facts: FactLine[]; emphasized: boolean; image: boolean; imageCase: boolean; casePrompt: string | null };

/**
 * The slides in a prompt, as lib/study.ts slideNotesText writes them: a "[P12] …: title" line, then the summary,
 * "- F3: fact" lines, "Case: …". A block ends at a blank line or at a repair's "To do:" line (an entry quoted after it
 * is not the slide's).
 */
function slidesIn(text: string): Slide[] {
  const out: Slide[] = [];
  let cur: Slide | null = null;
  let open = false;
  for (const line of text.split("\n")) {
    const head = /^\[P(\d+)\](.*)$/.exec(line);
    if (head) {
      const rest = head[2];
      const colon = rest.indexOf(": ");
      const title = (colon >= 0 ? rest.slice(colon + 2) : rest).replace(/ ★IMPORTANT.*$/, "").trim() || `P${head[1]}`;
      cur = { id: Number(head[1]), title, facts: [], emphasized: rest.includes("★IMPORTANT"), image: rest.includes("[IMAGE"), imageCase: rest.includes("[IMAGE-CASE]"), casePrompt: null };
      if (!out.some((s) => s.id === cur!.id)) out.push(cur);
      open = true;
      continue;
    }
    if (!cur || !open) continue;
    if (line.trim() === "" || line.startsWith("To do:")) {
      open = false;
      continue;
    }
    const fact = /^- (?:F(\d+): )?(.*)$/.exec(line);
    if (fact) cur.facts.push({ n: fact[1] ? Number(fact[1]) : null, text: fact[2].trim() });
    const kase = /^Case: (.*)$/.exec(line);
    if (kase) cur.casePrompt = kase[1].trim();
  }
  return out;
}

type PlannedSlot = { n: number; pages: number[]; facts: string[]; kind: string; caseN: number | null };

/** Planned questions: "Q4: slide P12 — fact: "…" — recall" (section quiz, and practice exams written to a plan). */
function slotsIn(text: string): PlannedSlot[] {
  const out: PlannedSlot[] = [];
  for (const m of text.matchAll(/^Q(\d+): (.*)$/gm)) {
    const rest = m[2];
    const where = rest.split(" — ")[0];
    const facts = [...rest.matchAll(/"([^"]*)"/g)].map((f) => f[1]);
    const kind = rest.split(" — ").at(-1)?.trim() ?? "";
    const caseN = /\bcase (\d+)\b/i.exec(rest.replace(/"[^"]*"/g, ""));
    out.push({ n: Number(m[1]), pages: [...where.matchAll(/P(\d+)/g)].map((p) => Number(p[1])), facts, kind, caseN: caseN ? Number(caseN[1]) : null });
  }
  return out;
}

const conceptsIn = (text: string): string[] =>
  (/^Concept names: (.*)$/m.exec(text)?.[1] ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && c !== "none");

// Words left out of question stems: a stem that names a picture or a slide would need a picture to show.
const PICTURE_WORDS =
  /^(?:image|picture|photo|photograph|radiograph|x-?ray|micrograph|figure|illustration|diagram|drawing|schematic|arrow|arrowhead|slide|slides|shown|pictured|labeled|labelled|marked|circled|dotted|dashed|shaded|bitewing|panoramic|periapical|film|cbct|scan)s?$/i;

/** A few words of a fact for a question stem (never a run the lesson check would call a copy, never a picture word). */
const gist = (fact: string, n = 4) =>
  keyWords(fact)
    .filter((w) => !PICTURE_WORDS.test(w) && !/^\d+$/.test(w))
    .slice(0, n)
    .join(", ") || "this point";

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A question with one right option (the fact) and fake distractors; the right option sits at a different place each time. */
function mcq(n: number, fact: string, count: 4 | 5, where: string) {
  const right = clip(fact.replace(/\s+/g, " ").trim()) || `What ${where} teaches`;
  const wrong = [
    `The reverse of this (fake distractor A, question ${n})`,
    `Only true in children (fake distractor B, question ${n})`,
    `Something the lecture never says (fake distractor C, question ${n})`,
    `A mix-up with a neighbouring topic (fake distractor D, question ${n})`,
  ].slice(0, count - 1);
  const at = n % count;
  const options = [...wrong.slice(0, at), right, ...wrong.slice(at)];
  return {
    options,
    correct_index: at,
    correct_answer: right,
    option_notes: options.map((o, i) => (i === at ? "Right: this is what the slide says (fake note)." : "Wrong: made up by the fake writer (fake note).")),
    explanation: `Fake explanation: the slide states this point, and the distractors are invented (Fake lecture, ${where}).`,
  };
}

const patientBox = (k: number) => ({
  patient: `${30 + (k % 40)}-year-old (fake patient ${k})`,
  chief_complaint: "Fake complaint: a tooth that hurts on biting",
  medical_history: "None (fake)",
  medications: "None (fake)",
  allergies: "None known (fake)",
  dental_history: "Fake: a filling two years ago",
  findings: "Fake findings: tender to percussion, normal probing",
});

/** Round-robin over the slides that have something to ask; each slide's facts in turn. */
function factPicker(slides: Slide[]) {
  const usable = slides.length ? slides : [];
  const used = new Map<number, number>();
  return (i: number): { page: number | null; fact: string; slide: Slide | null } => {
    if (usable.length === 0) return { page: null, fact: `A fake point number ${i + 1} from the passage`, slide: null };
    const s = usable[i % usable.length];
    const k = used.get(s.id) ?? 0;
    used.set(s.id, k + 1);
    const f = s.facts.length ? s.facts[k % s.facts.length].text : s.casePrompt ?? s.title;
    return { page: s.id, fact: f, slide: s };
  };
}

// ---- The writers, by purpose ----

const WRITERS: Record<string, (prompt: string) => unknown> = {
  "read slides": readSlides,
  "topic map": topicMap,
  lesson: lesson,
  "lesson repair": lesson,
  "section quiz": sectionQuiz,
  "section quiz check": quizCheck,
  "practice questions": practiceQuestions,
  "case sets": caseSets,
  "quiz me": quizMe,
  "exam schedule import": scheduleImport,
};

/** Slide notes from the slide's text layer (the picture is not looked at), plus facts that name the slide so every slide's are its own. */
function readSlides(prompt: string) {
  const lecture = /^Lecture: (.*)$/m.exec(prompt)?.[1]?.trim() ?? "lecture";
  const n = Number(/^Slide (\d+)$/m.exec(prompt)?.[1] ?? 1);
  const layer = (prompt.split("Extracted text layer:\n")[1] ?? "").trim();
  const lines = layer === "(none)" ? [] : layer.split("\n").map((l) => l.trim()).filter((l) => l.length >= 3);
  const name = lecture.replace(/\.pdf$/i, "");
  const filler = lines.length > 0 && lines.length <= 2 && /\b(thank you|questions\?|references|outline|agenda|objectives)\b/i.test(lines.join(" "));
  const caseLine = lines.find((l) => /^case:/i.test(l));
  const answerLine = lines.find((l) => /^answer:/i.test(l));
  const emphasized = /\b(important|know this|high-yield)\b|★/i.test(layer);
  const facts = filler
    ? []
    : [
        ...lines.slice(1, 3).filter((l) => l !== caseLine && l !== answerLine),
        `${name} page ${n}, point 1: a made-up fact for testing`,
        `${name} page ${n}, point 2: another made-up fact to learn`,
      ];
  return {
    title: clip(lines[0] ?? `${name} page ${n}`, 80),
    summary: `Fake summary of page ${n} of ${name}.`,
    image_description: /\b(radiograph|photo|x-ray|image)\b/i.test(layer) ? `Fake description of the picture on page ${n}` : null,
    key_facts: facts,
    annotations: [],
    emphasized,
    emphasis_note: emphasized ? `Fake: page ${n} was marked important` : null,
    case_prompt: caseLine ? caseLine.replace(/^case:\s*/i, "") : null,
    case_answer: caseLine && answerLine ? answerLine.replace(/^answer:\s*/i, "") : null,
    case_image_box: null,
    abbreviations: [],
    concepts: [`${name} concept ${Math.ceil(n / 4)}`],
    is_filler: filler,
  };
}

/** Sections of three or four slides, in the order the slides are listed. */
function topicMap(prompt: string) {
  const slides = [...prompt.matchAll(/^\[P(\d+)\] slide \d+: (.*)$/gm)].map((m) => {
    const [title, rest = ""] = m[2].split(" — ");
    return {
      id: Number(m[1]),
      title: title.replace(/ ★IMPORTANT$/, "").trim(),
      starred: title.includes("★IMPORTANT"),
      concepts: (/\| concepts: (.*)$/.exec(rest)?.[1] ?? "").split("; ").map((c) => c.trim()).filter(Boolean),
    };
  });
  const count = Math.max(1, Math.ceil(slides.length / 4));
  const topics = [];
  for (let i = 0, start = 0; i < count; i++) {
    const size = Math.floor(slides.length / count) + (i < slides.length % count ? 1 : 0);
    const part = slides.slice(start, (start += size));
    if (part.length === 0) continue;
    const concepts = [...new Set(part.flatMap((s) => s.concepts))].slice(0, 8);
    topics.push({
      title: `Fake section ${i + 1}: ${clip(part[0].title, 60)}`,
      summary: `A made-up section of ${part.length} slide(s), starting with "${clip(part[0].title, 60)}".`,
      page_ids: part.map((s) => s.id),
      emphasized: part.some((s) => s.starred),
      concepts: concepts.length ? concepts : [`Fake concept ${i + 1}`],
    });
  }
  return { topics };
}

/** One entry per slide given, explaining (in other words) and claiming every numbered fact under it. Also the section's intro and key points. */
function lesson(prompt: string) {
  const slides = slidesIn(prompt);
  const entries = slides.map((s) => {
    const lines = s.facts.map(
      (f) => `- ${f.n != null ? `**F${f.n}**` : "This point"}, in other words (fake writer): it is about ${gist(f.text)}, and it matters because exams ask about it.`,
    );
    return {
      page_id: s.id,
      explanation: [
        `This slide (fake lesson) is about **${s.title}**.${s.emphasized ? " ★ you emphasized this." : ""}`,
        ...lines,
        s.casePrompt ? `The case on this slide is answered from the slide itself (fake answer).` : "",
        s.facts.length === 0 && !s.casePrompt ? "Nothing more to learn here; the fake writer just names it." : "",
      ]
        .filter(Boolean)
        .join("\n"),
      facts: s.facts.flatMap((f) => (f.n != null ? [f.n] : [])),
    };
  });
  const starred = slides.filter((s) => s.emphasized).map((s) => `★ Fake key point: ${clip(s.title, 80)}`);
  const plain = slides.filter((s) => !s.emphasized).map((s) => `Fake key point: ${clip(s.title, 80)}`);
  const key_points = [...starred, ...plain];
  for (let k = key_points.length; k < 5; k++) key_points.push(`Fake key point ${k + 1}: review this section once more`);
  return {
    slides: entries,
    intro: `A made-up lesson (fake AI) about ${clip(/^Section: (.*)$/m.exec(prompt)?.[1] ?? "this section", 80)}.`,
    key_points: key_points.slice(0, 10),
    connections: null,
  };
}

/** One question per planned slot, its Q number echoed and its slide set as the source. */
function sectionQuiz(prompt: string) {
  const slides = slidesIn(prompt);
  const concept = conceptsIn(prompt)[0] ?? "Fake concept";
  const fallback = slides[0]?.id ?? 0;
  return {
    questions: slotsIn(prompt).map((s) => {
      const page = s.pages[0] ?? fallback;
      const fact = s.facts.join("; ") || slides.find((x) => x.id === page)?.facts[0]?.text || slides.find((x) => x.id === page)?.title || "";
      return {
        slot: s.n,
        question: `Fake question ${s.n}: which statement about ${gist(fact)} is correct?`,
        ...mcq(s.n, fact, 4, `P${page}`),
        source_page_id: page,
        image_page_id: null,
        concept,
      };
    }),
  };
}

/** Every question passes, each verdict under the number it was listed with. */
function quizCheck(prompt: string) {
  const list = prompt.split("\n\nQuestions:\n")[1] ?? "";
  return { verdicts: [...list.matchAll(/^(\d+)\. /gm)].map((m) => ({ n: Number(m[1]), ok: true, picture: false, reason: "Fake check: fine" })) };
}

/** A practice question of the kind asked for, 5 options. */
function practiceQuestion(k: number, t: string, pick: { page: number | null; fact: string; slide: Slide | null }, kind: string, concept: string, slot?: number) {
  const type = kind === "image" && pick.slide?.image ? "image" : kind === "case" ? "case" : "recall";
  const stem =
    type === "case"
      ? `Fake case ${t}-${k + 1}: for this patient, which statement about ${gist(pick.fact)} is correct?`
      : `Fake question ${t}-${k + 1}: which statement about ${gist(pick.fact)} is correct?`;
  return {
    ...(slot != null ? { slot } : {}),
    type,
    image_page_id: type === "image" ? pick.page : null,
    patient_box: type === "case" ? patientBox(k + 1) : null,
    stem,
    ...mcq(k + 1, pick.fact, 5, pick.page != null ? `P${pick.page}` : "the passage"),
    source_page_id: pick.page ?? 0,
    concept,
  };
}

/**
 * "Write N questions: <mix>" over the slides, or, when the prompt lists planned questions (Q<n>: slide P<id> — fact:
 * "…" — <kind>), one per planned question with its number echoed in `slot`.
 */
function practiceQuestions(prompt: string) {
  const slides = slidesIn(prompt);
  const concept = conceptsIn(prompt)[0] ?? "Fake concept";
  const t = tag(prompt);
  const planned = slotsIn(prompt);
  if (planned.length > 0) {
    return {
      questions: planned.map((s, k) => {
        const slide = slides.find((x) => x.id === s.pages[0]) ?? null;
        const fact = s.facts[0] ?? slide?.facts[0]?.text ?? slide?.title ?? "";
        const kind = /\bcase\b/i.test(s.kind) ? "case" : /\bimage\b/i.test(s.kind) ? "image" : "recall";
        return practiceQuestion(k, t, { page: s.pages[0] ?? slides[0]?.id ?? null, fact, slide }, kind, concept, s.n);
      }),
    };
  }
  const size = Number(/Write (\d+) questions/.exec(prompt)?.[1] ?? 5);
  const mix = /Write \d+ questions: (.*?)\./.exec(prompt)?.[1] ?? "";
  const pick = factPicker(slides);
  return {
    questions: Array.from({ length: size }, (_, k) => {
      const kind = /^all \d+ type=recall/.test(mix) ? "recall" : /^mostly type=case/.test(mix) ? (k === 0 && size > 1 ? "recall" : "case") : k % 4 === 3 ? "case" : "recall";
      return practiceQuestion(k, t, pick(k), kind, concept);
    }),
  };
}

/** "Write N case sets": one fake patient each with three questions from neighbouring slides (planned slots echoed when listed). */
function caseSets(prompt: string) {
  const slides = slidesIn(prompt);
  const concept = conceptsIn(prompt)[0] ?? "Fake concept";
  const t = tag(prompt);
  const imageCase = slides.find((s) => s.imageCase)?.id ?? null;
  const planned = slotsIn(prompt);
  const groups: { pick: { page: number | null; fact: string; slide: Slide | null }; slot?: number }[][] = [];
  if (planned.length > 0) {
    const byCase = new Map<string, PlannedSlot[]>();
    planned.forEach((s, i) => {
      const key = s.caseN != null ? `c${s.caseN}` : `g${Math.floor(i / 3)}`;
      byCase.set(key, [...(byCase.get(key) ?? []), s]);
    });
    for (const g of byCase.values())
      groups.push(
        g.map((s) => {
          const slide = slides.find((x) => x.id === s.pages[0]) ?? null;
          return { slot: s.n, pick: { page: s.pages[0] ?? slides[0]?.id ?? null, fact: s.facts[0] ?? slide?.facts[0]?.text ?? slide?.title ?? "", slide } };
        }),
      );
  } else {
    const size = Number(/Write (\d+) case sets?/.exec(prompt)?.[1] ?? 1);
    const pick = factPicker(slides);
    for (let c = 0; c < size; c++) groups.push(Array.from({ length: 3 }, (_, q) => ({ pick: pick(c * 3 + q) })));
  }
  return {
    cases: groups.map((g, c) => ({
      scenario: `Fake patient ${t}-${c + 1} comes in for a made-up visit about ${gist(g[0]?.pick.fact ?? "", 3)}.`,
      patient_box: patientBox(c + 1),
      image_page_id: imageCase,
      questions: g.map(({ pick, slot }, q) => ({
        ...(slot != null ? { slot } : {}),
        stem: `Fake case ${t}-${c + 1}, question ${q + 1}: for this patient, which statement about ${gist(pick.fact)} is correct?`,
        ...mcq(c * 5 + q + 1, pick.fact, 5, pick.page != null ? `P${pick.page}` : "the case"),
        source_page_id: pick.page ?? 0,
        concept,
      })),
    })),
  };
}

/** "Write exactly N questions." about the highlighted passage, 4 options, from the slides when there are any. */
function quizMe(prompt: string) {
  const slides = slidesIn(prompt);
  const concept = conceptsIn(prompt)[0] ?? "Fake concept";
  const size = Number(/Write exactly (\d+) questions/.exec(prompt)?.[1] ?? 3);
  const passage = /"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? "";
  const t = tag(prompt);
  const pick = factPicker(slides);
  return {
    questions: Array.from({ length: size }, (_, k) => {
      const p = slides.length ? pick(k) : { page: null, fact: `${clip(passage, 60)} (point ${k + 1})`, slide: null };
      return {
        question: `Fake quiz-me ${t}-${k + 1}: which statement about ${gist(p.fact)} is correct?`,
        ...mcq(k + 1, p.fact, 4, p.page != null ? `P${p.page}` : "the passage"),
        concept,
        source_page_id: p.page,
        image_page_id: null,
      };
    }),
  };
}

/** Every pasted line with a YYYY-MM-DD date becomes an exam; with none, one made-up exam two weeks after today. */
function scheduleImport(prompt: string) {
  const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(prompt)?.[1] ?? new Date().toISOString().slice(0, 10);
  const pasted = /Pasted schedule:\n<<<\n([\s\S]*?)\n>>>/.exec(prompt)?.[1] ?? "";
  type Exam = { name: string; date: string; course: null; kind: "block" | "quiz" | "practical" | "board"; confidence: "high" | "medium"; note: string | null };
  const exams: Exam[] = pasted
    .split("\n")
    .map((l) => ({ l, d: /\b(\d{4}-\d{2}-\d{2})\b/.exec(l)?.[1] }))
    .filter((x) => x.d)
    .map(({ l, d }): Exam => {
      const name = l.replace(d!, "").replace(/[\s,;:–—-]+$/g, "").replace(/^[\s,;:–—-]+/g, "").trim() || "Fake exam";
      return {
        name: clip(name, 100),
        date: d!,
        course: null,
        kind: /quiz/i.test(name) ? "quiz" : /practical|osce/i.test(name) ? "practical" : /board|inbde/i.test(name) ? "board" : "block",
        confidence: "high",
        note: null,
      };
    });
  if (exams.length === 0) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 14);
    exams.push({ name: "Fake block exam", date: d.toISOString().slice(0, 10), course: null, kind: "block", confidence: "medium", note: "Made up by the fake AI." });
  }
  return { exams, year_assumed: null };
}
