// Perf fix #3: practice exams write sections in parallel. Audit M3 lowered the limits to 4 sections (3 case sets) at
// once: 8 parallel calls on the expensive model hit rate limits on small keys. Since exams are planned
// (docs/EXAM-PLAN.md), a rate-limited section is not backfilled from the others: the exam is short for "busy" and
// finishes itself later.
import { beforeEach, describe, expect, it, vi } from "vitest";

let inFlight = 0;
let maxInFlight = 0;
let counter = 0;
let calls = 0;
const rateLimited = new Set<string>();
/** The planned questions a prompt lists, with their case number in case sets. */
const planned = (content: string) => [...content.matchAll(/^Q(\d+): slide P(\d+)(?: — case (\d+))?/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]), caseN: m[3] ? Number(m[3]) : null }));
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    inFlight++;
    calls++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 15));
      const title = /Topic: (Topic \d+)/.exec(opts.content)?.[1] ?? "";
      if (rateLimited.has(title)) {
        // Shaped like the Anthropic SDK's RateLimitError.
        throw Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), { status: 429 });
      }
      const slots = planned(opts.content);
      if (opts.purpose === "case sets") {
        return {
          cases: [...new Set(slots.map((s) => s.caseN))].map((caseN) => ({
            scenario: `scenario ${++counter}`,
            patient_box: { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" },
            image_page_id: null,
            questions: slots
              .filter((s) => s.caseN === caseN)
              .map((s, i) => ({
                slot: s.n,
                stem: `case-q ${++counter}-${i}`,
                options: ["A", "B", "C", "D", "E"],
                correct_index: 0,
                explanation: "e",
                source_page_id: s.page,
                concept: "Gen concept",
              })),
          })),
        };
      }
      return {
        questions: slots.map((s) => ({
          slot: s.n,
          type: "recall",
          image_page_id: null,
          patient_box: null,
          stem: `generated ${++counter}`,
          options: ["A", "B", "C", "D", "E"],
          correct_index: 0,
          explanation: "e",
          source_page_id: s.page,
          concept: "Gen concept",
        })),
      };
    } finally {
      inFlight--;
    }
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db } from "@/lib/db";
import { startAttempt } from "@/lib/practice";
import { makeUser, slideNotes, world as makeWorld } from "./helpers";

/** `topics` sections of two slides, each slide with three facts of its own. */
function world(topics: number) {
  const w = makeWorld({
    userId: makeUser(),
    sections: topics,
    slidesEach: 2,
    linkLectures: false,
    session: false,
    notes: (n) => slideNotes({ key_facts: [`fact ${n}a`, `fact ${n}b`, `fact ${n}c`] }),
  });
  return { examId: w.examId, topicIds: w.topicIds };
}

async function ready(attemptId: number) {
  for (let i = 0; i < 1000; i++) {
    const a = db.prepare("SELECT status, error FROM attempts WHERE id = ?").get(attemptId) as { status: string; error: string | null };
    if (a.status !== "generating") return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("stuck generating");
}
const members = (attemptId: number) =>
  db
    .prepare("SELECT q.topic_id, q.case_id FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = ?")
    .all(attemptId) as { topic_id: number; case_id: number | null }[];

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
  calls = 0;
  rateLimited.clear();
});

describe("practice exams write sections in parallel", () => {
  it("4 sections are written at the same time", async () => {
    const w = world(8);
    const id = startAttempt(w.examId, { size: 16, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(members(id)).toHaveLength(16);
    expect(maxInFlight).toBe(4);
  });

  it("never more than 4 at once on a bigger exam", async () => {
    const w = world(20);
    const id = startAttempt(w.examId, { size: 25, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(members(id)).toHaveLength(25);
    expect(maxInFlight).toBe(4);
  });

  it("3 of 8 sections rate-limited (429): ready but short ('busy') with the other five sections' questions; one follow-up each", async () => {
    const w = world(8);
    rateLimited.add("Topic 2").add("Topic 5").add("Topic 7");
    const id = startAttempt(w.examId, { size: 16, mode: "tutor", style: "recall", adaptive: false });
    const st = await ready(id);
    expect(st.status).toBe("ready");
    const rows = members(id);
    expect(rows).toHaveLength(10);
    const limited = new Set([w.topicIds[1], w.topicIds[4], w.topicIds[6]]);
    expect(rows.some((r) => limited.has(r.topic_id))).toBe(false);
    expect(new Set(rows.map((r) => r.topic_id)).size).toBe(5);
    expect(calls).toBe(8 + 3);
    expect((db.prepare("SELECT short_reason FROM attempts WHERE id = ?").get(id) as { short_reason: string }).short_reason).toBe("busy");
  });

  it("every section rate-limited: the exam fails with the rate-limit error instead of hanging", async () => {
    const w = world(4);
    for (let t = 1; t <= 4; t++) rateLimited.add(`Topic ${t}`);
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "recall", adaptive: false });
    const st = await ready(id);
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/429|rate/i);
  });

  it("case sets: 3 at once, and rate-limited ones don't sink the exam", async () => {
    const w = world(8);
    // 32 questions → 8 case sets, one per section.
    const id = startAttempt(w.examId, { size: 32, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(maxInFlight).toBe(3);

    maxInFlight = 0;
    const w2 = world(8);
    rateLimited.add("Topic 3").add("Topic 6");
    const id2 = startAttempt(w2.examId, { size: 32, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id2)).status).toBe("ready");
    const rows = members(id2);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.case_id != null)).toBe(true);
  });
});
