// Wave 1, infrastructure (audit M1, M7, M8, M11, M12, R2, R3, R9, R11/U8, S3, S11, L5): the AI client, slide reading,
// section maps, the database file and start-up.
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type AiTopic = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[] };

const h = vi.hoisted(() => ({
  prompts: [] as string[],
  reply: null as null | ((content: string) => { topics: AiTopic[] }),
  batch: null as null | ((batchId: string) => Promise<unknown>),
  noKey: new Set<number>(),
  anthropicOptions: [] as Record<string, unknown>[],
  openaiOptions: [] as Record<string, unknown>[],
  streamParams: [] as Record<string, unknown>[],
  message: null as unknown,
  openaiResponse: null as unknown,
}));

// The SDKs, faked at the edge, so the real generate() in lib/ai.ts can be checked (cache markers, usage, retries).
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    constructor(o: Record<string, unknown>) {
      h.anthropicOptions.push(o);
    }
    beta = {
      messages: {
        stream: (p: Record<string, unknown>) => {
          h.streamParams.push(p);
          return { finalMessage: async () => h.message };
        },
      },
    };
  }
  return { default: Anthropic };
});
vi.mock("openai", () => {
  class OpenAI {
    constructor(o: Record<string, unknown>) {
      h.openaiOptions.push(o);
    }
    responses = { parse: async () => h.openaiResponse };
  }
  return { default: OpenAI };
});

vi.mock("@/lib/ai", async (orig) => {
  const real = await orig<typeof import("@/lib/ai")>();
  return {
    ...real,
    // Topic maps are answered here; anything else goes to the real generate (over the fake SDKs above).
    generate: vi.fn(async (opts: Parameters<typeof real.generate>[0]) => {
      if (opts.purpose !== "topic map") return real.generate(opts);
      const content = String(opts.content);
      h.prompts.push(content);
      return (h.reply ?? chunked(3))(content);
    }),
    batchResults: vi.fn(async (_c: unknown, _p: unknown, _s: unknown, batchId: string) => (h.batch ? h.batch(batchId) : null)),
  };
});
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => {
    if (h.noKey.has(userId)) throw new Error("No API key set up. Add one in Settings.");
    return { userId, provider: "anthropic", apiKey: "k" };
  },
}));
let currentUser = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUser ? { id: currentUser } : null),
}));

import { backfillFiller, db, examSlideKinds, type Topic } from "@/lib/db";
import { generate } from "@/lib/ai";
import { inflightCount, settle } from "@/lib/inflight";
import { addDocument, BATCH_FAILED, MAX_PDF_PAGES, parseNotes, pollBatches, resumeUnfinished } from "@/lib/processing";
import { buildTopicMap, MAP_CONCEPTS_MAX } from "@/lib/topics";
import { PdfRefused } from "@/lib/pdf";
import { POST as topicsPOST } from "@/app/api/exams/[id]/topics/route";
import { missingProductionConfig } from "@/instrumentation";
import { SlideNotes } from "@/lib/notes";
import { makeUser } from "./helpers";

const notesOf = (title: string, filler = false): SlideNotes => ({
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

function exam() {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  return { userId, examId };
}

/** A read lecture of `n` slides. */
function lecture(examId: number, name: string, n: number, status = "done") {
  const doc = Number(db.prepare("INSERT INTO documents (exam_id, filename, status, page_count) VALUES (?, ?, ?, ?)").run(examId, name, status, n).lastInsertRowid);
  const pages = Array.from({ length: n }, (_, i) => addSlide(doc, i + 1, name));
  return { doc, pages };
}
const addSlide = (doc: number, n: number, name = "L") =>
  Number(
    db
      .prepare("INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (?, ?, ?, 'done', ?)")
      .run(doc, n, `doc-${doc}/p${n}.jpg`, JSON.stringify(notesOf(`${name} s${n}`))).lastInsertRowid,
  );

const idsIn = (content: string) => [...content.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
const chunked = (size: number) => (content: string) => {
  const ids = idsIn(content);
  const out: AiTopic[] = [];
  for (let i = 0; i < ids.length; i += size) out.push({ title: `S${ids[i]}`, summary: "s", page_ids: ids.slice(i, i + size), emphasized: false, concepts: [`k${ids[i]}`] });
  return { topics: out };
};
const topics = (examId: number) => db.prepare("SELECT * FROM topics WHERE exam_id = ? ORDER BY position").all(examId) as Topic[];
const status = (examId: number) => (db.prepare("SELECT topic_status FROM exams WHERE id = ?").get(examId) as { topic_status: string }).topic_status;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;

beforeEach(() => {
  h.prompts.length = 0;
  h.reply = null;
  h.batch = null;
  h.noKey.clear();
  h.streamParams.length = 0;
  currentUser = 0;
});

describe("M1: the sections route takes a mode; a restart re-runs interrupted builds in 'auto'", () => {
  it("no body and {mode:'auto'} map only lectures with no section (no AI call when all are mapped); {mode:'full'} re-splits every lecture", async () => {
    const w = exam();
    lecture(w.examId, "A.pdf", 4);
    lecture(w.examId, "B.pdf", 4);
    await buildTopicMap(w.examId);
    expect(h.prompts).toHaveLength(2);
    const before = topics(w.examId).map((t) => t.id);
    currentUser = w.userId;

    h.prompts.length = 0;
    expect((await topicsPOST(new Request("http://x/t", { method: "POST" }), ctx(w.examId))).status).toBe(200);
    await settle(5000);
    expect((await topicsPOST(new Request("http://x/t", { method: "POST", body: JSON.stringify({ mode: "auto" }) }), ctx(w.examId))).status).toBe(200);
    await settle(5000);
    expect(h.prompts).toHaveLength(0);
    expect(topics(w.examId).map((t) => t.id)).toEqual(before);

    expect((await topicsPOST(new Request("http://x/t", { method: "POST", body: JSON.stringify({ mode: "full" }) }), ctx(w.examId))).status).toBe(200);
    await settle(5000);
    expect(h.prompts).toHaveLength(2);
    expect(status(w.examId)).toBe("ready");
  });

  it("an unknown mode is refused; a stranger gets 404 and starts nothing", async () => {
    const w = exam();
    lecture(w.examId, "A.pdf", 3);
    currentUser = w.userId;
    expect((await topicsPOST(new Request("http://x/t", { method: "POST", body: JSON.stringify({ mode: "cut" }) }), ctx(w.examId))).status).toBe(400);
    currentUser = makeUser();
    expect((await topicsPOST(new Request("http://x/t", { method: "POST", body: JSON.stringify({ mode: "full" }) }), ctx(w.examId))).status).toBe(404);
    await settle(5000);
    expect(h.prompts).toHaveLength(0);
  });

  it("an exam left 'building' by a restart is built again in 'auto': mapped lectures untouched, only the unmapped one goes to the AI", async () => {
    const w = exam();
    const a = lecture(w.examId, "A.pdf", 4);
    await buildTopicMap(w.examId);
    const before = topics(w.examId);
    db.prepare("UPDATE topics SET lesson_json = 'kept' WHERE exam_id = ?").run(w.examId);
    const b = lecture(w.examId, "B.pdf", 3);
    db.prepare("UPDATE exams SET topic_status = 'building' WHERE id = ?").run(w.examId);
    h.prompts.length = 0;

    resumeUnfinished();
    expect(inflightCount()).toBeGreaterThan(0); // tracked, so a deploy waits for it
    await settle(5000);

    expect(status(w.examId)).toBe("ready");
    expect(h.prompts.map(idsIn)).toEqual([b.pages]);
    const after = topics(w.examId);
    expect(after.slice(0, before.length).map((t) => [t.id, t.page_ids, t.lesson_json])).toEqual(before.map((t) => [t.id, t.page_ids, "kept"]));
    expect(after.slice(before.length).every((t) => t.document_id === b.doc)).toBe(true);
    expect(after.flatMap((t) => JSON.parse(t.page_ids) as number[])).toEqual([...a.pages, ...b.pages]);
  });
});

describe("M8: the concept list sent with each lecture", () => {
  it("is the 150 most recently seen (then newest), and comes after the slide list", async () => {
    const w = exam();
    const ins = db.prepare("INSERT INTO concepts (user_id, name, last_seen, created_at) VALUES (?, ?, ?, ?)");
    // 100 seen (c-seen-0 oldest … c-seen-99 newest), 100 never seen (c-new-0 oldest … c-new-99 newest).
    for (let i = 0; i < 100; i++) ins.run(w.userId, `c-seen-${i}`, `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, "2025-01-01 00:00:00");
    for (let i = 0; i < 100; i++) ins.run(w.userId, `c-new-${i}`, null, `2026-02-01 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`);
    lecture(w.examId, "A.pdf", 3);
    await buildTopicMap(w.examId);
    expect(h.prompts).toHaveLength(1);
    const content = h.prompts[0];
    const list = content.slice(content.indexOf("Existing concepts")).split("\n").slice(1);
    expect(MAP_CONCEPTS_MAX).toBe(150);
    expect(list).toHaveLength(150);
    expect(list.slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => `c-seen-${99 - i}`));
    expect(list.slice(100)).toEqual(Array.from({ length: 50 }, (_, i) => `c-new-${99 - i}`));
    expect(content.indexOf("Slides of this lecture")).toBeLessThan(content.indexOf("Existing concepts"));
  });
});

describe("M11: a section that gains a retried slide", () => {
  async function grown(answered: boolean) {
    const w = exam();
    const l = lecture(w.examId, "A.pdf", 3);
    // Slide 4 failed to read at first; it reads on retry later.
    await buildTopicMap(w.examId);
    const [t] = topics(w.examId);
    db.prepare("UPDATE topics SET lesson_json = 'L', checks_json = '[1]', checks_version = 3 WHERE id = ?").run(t.id);
    if (answered) db.prepare("INSERT INTO quiz_answers (user_id, topic_id, check_index, chosen, correct) VALUES (?, ?, 0, 1, 1)").run(w.userId, t.id);
    const extra = addSlide(l.doc, 4);
    h.prompts.length = 0;
    await buildTopicMap(w.examId);
    expect(h.prompts).toHaveLength(0); // placed with no AI call
    const after = db.prepare("SELECT * FROM topics WHERE id = ?").get(t.id) as Topic;
    expect(JSON.parse(after.page_ids)).toEqual([...l.pages, extra]);
    expect(after.lesson_json).toBeNull();
    return { after, answers: (db.prepare("SELECT COUNT(*) n FROM quiz_answers WHERE topic_id = ?").get(t.id) as { n: number }).n };
  }

  it("with no answers from anyone, its quiz is reset too", async () => {
    const { after } = await grown(false);
    expect(after.checks_json).toBeNull();
    expect(after.checks_version).toBeNull();
  });

  it("with answers, its quiz and the answers are left alone", async () => {
    const { after, answers } = await grown(true);
    expect(after.checks_json).toBe("[1]");
    expect(after.checks_version).toBe(3);
    expect(answers).toBe(1);
  });
});

describe("R2 / M12: collecting slide batches", () => {
  function batched(batchAt: string | null = null) {
    const w = exam();
    const l = lecture(w.examId, "A.pdf", 2, "processing");
    db.prepare("UPDATE pages SET status = 'pending', notes_json = NULL WHERE document_id = ?").run(l.doc);
    db.prepare(`UPDATE documents SET batch_id = 'b-${l.doc}', batch_at = COALESCE(?, datetime('now')) WHERE id = ?`).run(batchAt, l.doc);
    return { ...w, ...l };
  }
  const doc = (id: number) => db.prepare("SELECT status, error, batch_id FROM documents WHERE id = ?").get(id) as { status: string; error: string | null; batch_id: string | null };
  const failWith = (status: number) => async () => {
    throw Object.assign(new Error(`HTTP ${status}`), { status });
  };

  it("a refused key (401/403) fails the lecture with a plain message and forgets the batch", async () => {
    const one = batched();
    const two = batched();
    h.batch = async (id) => (id === `b-${one.doc}` ? failWith(401)() : failWith(403)());
    await pollBatches();
    expect(doc(one.doc)).toEqual({ status: "error", error: BATCH_FAILED.keyRefused, batch_id: null });
    expect(doc(two.doc)).toEqual({ status: "error", error: BATCH_FAILED.keyRefused, batch_id: null });
  });

  it("a batch the API no longer knows (404) fails the lecture; a removed key fails it without asking the API", async () => {
    const gone = batched();
    const noKey = batched();
    h.noKey.add(noKey.userId);
    const asked: string[] = [];
    h.batch = async (id) => {
      asked.push(id);
      return failWith(404)();
    };
    await pollBatches();
    expect(doc(gone.doc)).toEqual({ status: "error", error: BATCH_FAILED.gone, batch_id: null });
    expect(doc(noKey.doc)).toEqual({ status: "error", error: BATCH_FAILED.noKey, batch_id: null });
    expect(asked).not.toContain(`b-${noKey.doc}`);
  });

  it("a network or server error keeps the batch for the next minute, until it is over 26 hours old", async () => {
    const young = batched();
    const old = batched(new Date(Date.now() - 27 * 3600_000).toISOString().replace("T", " ").slice(0, 19));
    h.batch = async () => {
      throw Object.assign(new Error("socket hang up"), { status: 500 });
    };
    await pollBatches();
    expect(doc(young.doc)).toEqual({ status: "processing", error: null, batch_id: `b-${young.doc}` });
    expect(doc(old.doc)).toEqual({ status: "error", error: BATCH_FAILED.tooLong, batch_id: null });
    h.batch = async () => {
      throw new Error("fetch failed"); // no status at all
    };
    await pollBatches();
    expect(doc(young.doc).batch_id).toBe(`b-${young.doc}`);
  });

  it("results, forgetting the batch and the usage record are one transaction: a failure leaves all three undone, the retry does them once", async () => {
    const w = batched();
    let logged = 0;
    let failLog = true;
    h.batch = async (id) => {
      if (id !== `b-${w.doc}`) return null; // other tests' batches: still running
      return {
        results: w.pages.map((p, i) => ({ customId: String(p), ok: true, value: notesOf(`slide ${i + 1}`, i === 0) })),
        logUsage: () => {
          if (failLog) throw new Error("disk full");
          logged++;
        },
      };
    };
    await pollBatches();
    expect(doc(w.doc).batch_id).toBe(`b-${w.doc}`);
    expect((db.prepare("SELECT COUNT(*) n FROM pages WHERE document_id = ? AND status = 'done'").get(w.doc) as { n: number }).n).toBe(0);

    failLog = false;
    await pollBatches();
    await pollBatches(); // nothing left to collect
    await settle(5000);
    expect(logged).toBe(1);
    expect(doc(w.doc)).toMatchObject({ status: "done", batch_id: null });
    // R11 / U8: the saved notes fill is_filler.
    expect(db.prepare("SELECT page_number, is_filler FROM pages WHERE document_id = ? ORDER BY page_number").all(w.doc)).toEqual([
      { page_number: 1, is_filler: 1 },
      { page_number: 2, is_filler: 0 },
    ]);
  });
});

describe("M7 / M12: the AI client", () => {
  const schema = z.object({ ok: z.number() });
  const creds = (userId: number) => ({ userId, provider: "anthropic" as const, apiKey: `key-${userId}-${Math.random()}` });

  it("`cache: true` marks the system prompt and the first content block; without it nothing is marked", async () => {
    const userId = makeUser();
    h.message = { model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn", parsed_output: { ok: 1 } };
    await generate({ creds: creds(userId), purpose: "t", schema, system: "SYS", content: "hello", cache: true });
    await generate({
      creds: creds(userId),
      purpose: "t",
      schema,
      system: "SYS",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      cache: true,
    });
    await generate({ creds: creds(userId), purpose: "t", schema, system: "SYS", content: "hello" });
    const [a, b, c] = h.streamParams as { system: unknown; messages: { content: unknown }[] }[];
    expect(a.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    expect(a.messages[0].content).toEqual([{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
    expect(b.messages[0].content).toEqual([
      { type: "text", text: "first", cache_control: { type: "ephemeral" } },
      { type: "text", text: "second" },
    ]);
    expect(c.system).toBe("SYS");
    expect(c.messages[0].content).toBe("hello");
    // Both SDK clients retry and allow long requests.
    expect(h.anthropicOptions.at(-1)).toMatchObject({ maxRetries: 4, timeout: 300_000 });
  });

  it("usage is priced by the model that answered (a fallback, a dated id), cache writes at the cache-write rate", async () => {
    const userId = makeUser();
    h.message = {
      model: "claude-opus-5-5-20261101",
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 },
      stop_reason: "end_turn",
      parsed_output: { ok: 1 },
    };
    await generate({ creds: creds(userId), purpose: "priced", schema, system: "S", content: "c" });
    const row = db.prepare("SELECT model, input_tokens, cached_tokens, output_tokens, cost_usd FROM ai_usage WHERE user_id = ?").get(userId) as Record<string, number | string>;
    // Opus: input 4, cache read 0.2, cache write 5, output 20 per million.
    expect(row).toMatchObject({ model: "claude-opus-5-5-20261101", input_tokens: 1500, cached_tokens: 2000, output_tokens: 100 });
    expect(row.cost_usd).toBeCloseTo((1000 * 4 + 2000 * 0.2 + 500 * 5 + 100 * 20) / 1e6, 10);
  });

  it("ChatGPT: priced by the response's model too; the flag is ignored", async () => {
    const userId = makeUser();
    h.openaiResponse = { model: "gpt-6.1-sol-2026", status: "completed", output_parsed: { ok: 1 }, usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 400 } } };
    await generate({ creds: { userId, provider: "openai", apiKey: `o-${userId}` }, purpose: "gpt", schema, system: "S", content: "c", cache: true });
    const row = db.prepare("SELECT model, cost_usd FROM ai_usage WHERE user_id = ?").get(userId) as { model: string; cost_usd: number };
    expect(row.model).toBe("gpt-6.1-sol-2026");
    expect(row.cost_usd).toBeCloseTo((600 * 2 + 400 * 0.2 + 10 * 10) / 1e6, 10);
    expect(h.openaiOptions.at(-1)).toMatchObject({ maxRetries: 4, timeout: 300_000 });
  });
});

describe("R9: parseNotes", () => {
  it("gives null for missing or damaged notes instead of throwing", () => {
    expect(parseNotes({ notes_json: null })).toBeNull();
    expect(parseNotes({ notes_json: "" })).toBeNull();
    expect(parseNotes({ notes_json: "{broken" })).toBeNull();
    expect(parseNotes({ notes_json: "[1,2]" })).toBeNull();
    expect(parseNotes({ notes_json: "null" })).toBeNull();
    expect(parseNotes({ notes_json: JSON.stringify(notesOf("x")) })?.title).toBe("x");
  });

  it("a slide with damaged notes is left out of the map instead of failing the build", async () => {
    const w = exam();
    const l = lecture(w.examId, "A.pdf", 3);
    db.prepare("UPDATE pages SET notes_json = '{oops' WHERE id = ?").run(l.pages[1]);
    await buildTopicMap(w.examId);
    expect(status(w.examId)).toBe("ready");
    expect(topics(w.examId).flatMap((t) => JSON.parse(t.page_ids) as number[])).toEqual([l.pages[0], l.pages[2]]);
  });
});

describe("S3: page limit", () => {
  function makePdf(n: number): Buffer {
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font("Helvetica"), "Latin");
    for (let i = 0; i < n; i++) doc.insertPage(-1, doc.addPage([0, 0, 96, 72], 0, font, ""));
    return Buffer.from(doc.saveToBuffer("").asUint8Array());
  }

  it("a PDF over 400 pages is refused with a plain message and nothing is saved", async () => {
    const w = exam();
    const docs = () => (db.prepare("SELECT COUNT(*) n FROM documents WHERE exam_id = ?").get(w.examId) as { n: number }).n;
    expect(MAX_PDF_PAGES).toBe(400);
    const err = await addDocument(w.examId, "Huge", makePdf(401)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRefused);
    expect((err as Error).message).toBe("This PDF has 401 pages. The most one lecture can have is 400. Split it and upload the parts.");
    expect(docs()).toBe(0);
  });
});

describe("R11 / U8: is_filler", () => {
  it("is back-filled from the notes for older rows; damaged or missing notes stay NULL; examSlideKinds counts in SQL", () => {
    const w = exam();
    const l = lecture(w.examId, "A.pdf", 5);
    const set = db.prepare("UPDATE pages SET notes_json = ?, is_filler = NULL WHERE id = ?");
    set.run(JSON.stringify(notesOf("title", true)), l.pages[0]);
    set.run(JSON.stringify(notesOf("content")), l.pages[1]);
    set.run("{broken", l.pages[2]);
    set.run(null, l.pages[3]);
    set.run(JSON.stringify({ title: "no flag" }), l.pages[4]);
    expect(backfillFiller()).toBeGreaterThanOrEqual(3);
    const kinds = db.prepare("SELECT id, is_filler FROM pages WHERE document_id = ? ORDER BY page_number").all(l.doc);
    expect(kinds).toEqual([
      { id: l.pages[0], is_filler: 1 },
      { id: l.pages[1], is_filler: 0 },
      { id: l.pages[2], is_filler: null },
      { id: l.pages[3], is_filler: null },
      { id: l.pages[4], is_filler: 0 },
    ]);
    expect(backfillFiller()).toBe(0); // nothing left to fill
    expect(examSlideKinds(w.examId)).toEqual([
      { id: l.pages[0], is_filler: 1 },
      { id: l.pages[1], is_filler: 0 },
      { id: l.pages[4], is_filler: 0 },
    ]);
  });
});

describe("S11: production configuration", () => {
  const prod = { NODE_ENV: "production", SECRET_KEY: "s", APP_PASSCODE: "p", DATA_DIR: "/data" } as unknown as NodeJS.ProcessEnv;
  it("names what is missing in production only, and never during next build", () => {
    expect(missingProductionConfig(prod)).toBeNull();
    expect(missingProductionConfig({ ...prod, SECRET_KEY: "" })).toBe("SECRET_KEY is empty");
    expect(missingProductionConfig({ ...prod, APP_PASSCODE: " ", DATA_DIR: undefined })).toBe("APP_PASSCODE is empty, DATA_DIR is not set");
    expect(missingProductionConfig({ ...prod, DATA_DIR: "./data" })).toBe("DATA_DIR is not an absolute path (./data)");
    expect(missingProductionConfig({ ...prod, NODE_ENV: "development", SECRET_KEY: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(missingProductionConfig({ ...prod, NODE_ENV: "test", SECRET_KEY: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(missingProductionConfig({ ...prod, SECRET_KEY: "", NEXT_PHASE: "phase-production-build" })).toBeNull();
  });
});

describe("L5: one schema", () => {
  const names = (sql: string) => (db.prepare(sql).all() as { name: string }[]).map((r) => r.name);

  it("the indexes exist and busy_timeout is set", () => {
    const idx = names("SELECT name FROM sqlite_master WHERE type = 'index'");
    for (const n of ["questions_exam", "questions_topic", "attempt_questions_question", "topics_exam", "documents_exam", "ai_usage_user_created", "attempts_exam", "quizme_open", "reported_questions_topic"]) {
      expect(idx).toContain(n);
    }
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("db.ts defines the three modules' tables with every column, and the modules' own statements are then no-ops", async () => {
    const before = ["quizme", "lecture_review_done", "reports", "report_images", "reported_questions"].map((t) => names(`PRAGMA table_info(${t})`));
    expect(before[0]).toEqual(["id", "user_id", "exam_id", "topic_id", "text", "size", "questions_json", "answers_json", "created_at", "finished_at", "kind", "document_id"]);
    expect(before[1]).toEqual(["user_id", "ref", "done_at", "stem"]);
    await import("@/lib/quizMe");
    await import("@/lib/reports");
    await import("@/lib/reportedQuestions");
    const after = ["quizme", "lecture_review_done", "reports", "report_images", "reported_questions"].map((t) => names(`PRAGMA table_info(${t})`));
    expect(after).toEqual(before);
  });

  // Last in the file: it swaps the database module for one opened on another file.
  it("a database made by the old db.ts plus the three modules' old statements still opens and gets the new columns and indexes", async () => {
    const OLD = "58b536f";
    const show = (f: string) => execSync(`git show ${OLD}:${f}`, { encoding: "utf8" });
    const dbSrc = show("src/lib/db.ts");
    const oldSchema = dbSrc.slice(dbSrc.indexOf("const SCHEMA = `") + 16, dbSrc.indexOf("`;", dbSrc.indexOf("const SCHEMA")));
    const execs = (src: string) => [...src.matchAll(/db\.exec\(`([\s\S]*?)`\);/g)].map((m) => m[1]).filter((sql) => !sql.includes("${"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w1-l5-"));
    const old = new Database(path.join(dir, "study.db"));
    old.exec(oldSchema);
    // quizMe's first version (before kind / document_id / stem were added), reports, reported questions.
    for (const f of ["src/lib/quizMe.ts", "src/lib/reports.ts", "src/lib/reportedQuestions.ts"]) for (const sql of execs(show(f))) old.exec(sql);
    old.exec(`INSERT INTO users (email, password_hash) VALUES ('a@x', 'x');
      INSERT INTO exams (user_id, name) VALUES (1, 'E');
      INSERT INTO quizme (user_id, exam_id, text, size, questions_json, answers_json) VALUES (1, 1, 'hi', 3, '[]', '[]');
      INSERT INTO documents (exam_id, filename, status) VALUES (1, 'L', 'done');
      INSERT INTO pages (document_id, page_number, image_path, status, notes_json) VALUES (1, 1, 'x', 'done', '{"is_filler":true}');`);
    expect(old.prepare("PRAGMA table_info(quizme)").all().map((c) => (c as { name: string }).name)).not.toContain("kind");
    old.close();

    vi.resetModules();
    const prevDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    const saved = (globalThis as { __db?: unknown }).__db;
    delete (globalThis as { __db?: unknown }).__db;
    try {
      const fresh = (await import("@/lib/db")).db;
      const cols = (t: string) => (fresh.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols("quizme")).toEqual(expect.arrayContaining(["kind", "document_id"]));
      expect(cols("lecture_review_done")).toContain("stem");
      expect(cols("pages")).toContain("is_filler");
      expect(cols("documents")).toContain("batch_at");
      expect(fresh.prepare("SELECT kind, document_id FROM quizme").get()).toEqual({ kind: "highlight", document_id: null });
      expect(fresh.prepare("SELECT is_filler FROM pages").get()).toEqual({ is_filler: 1 });
      const idx = (fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
      expect(idx).toEqual(expect.arrayContaining(["questions_exam", "topics_exam", "ai_usage_user_created", "quizme_open", "reported_questions_topic"]));
      // The modules still run their own statements on import: no error.
      await import("@/lib/quizMe");
      await import("@/lib/reports");
      await import("@/lib/reportedQuestions");
      expect(fresh.pragma("foreign_key_check")).toEqual([]);
      fresh.close();
    } finally {
      (globalThis as { __db?: unknown }).__db = saved;
      process.env.DATA_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
