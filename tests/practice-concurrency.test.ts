// Perf fix #3: practice exams write 8 sections (6 case sets) at once; rate-limited sections are backfilled.
import { beforeEach, describe, expect, it, vi } from "vitest";

let inFlight = 0;
let maxInFlight = 0;
let counter = 0;
const rateLimited = new Set<string>();
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 15));
      const title = /Topic: (Topic \d+)/.exec(opts.content)?.[1] ?? "";
      if (rateLimited.has(title)) {
        // Shaped like the Anthropic SDK's RateLimitError.
        throw Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), { status: 429 });
      }
      const asked = Number(/Write (\d+) /.exec(opts.content)?.[1] ?? 1);
      const page = Number(/\[P(\d+)\]/.exec(opts.content)?.[1] ?? 0);
      if (opts.purpose === "case sets") {
        return {
          cases: Array.from({ length: asked }, () => ({
            scenario: `scenario ${++counter}`,
            patient_box: { patient: "p", chief_complaint: "c", medical_history: "m", medications: "m", allergies: "a", dental_history: "d", findings: "f" },
            image_page_id: null,
            questions: Array.from({ length: 3 }, (_, i) => ({
              stem: `case-q ${++counter}-${i}`,
              options: ["A", "B", "C", "D", "E"],
              correct_index: 0,
              explanation: "e",
              source_page_id: page,
              concept: "Gen concept",
            })),
          })),
        };
      }
      return {
        questions: Array.from({ length: asked }, () => ({
          type: "recall",
          image_page_id: null,
          patient_box: null,
          stem: `generated ${++counter}`,
          options: ["A", "B", "C", "D", "E"],
          correct_index: 0,
          explanation: "e",
          source_page_id: page,
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
import { makeUser } from "./helpers";

function world(topics: number) {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(userId).lastInsertRowid);
  const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'lec.pdf')").run(examId).lastInsertRowid);
  let pn = 0;
  const topicIds: number[] = [];
  for (let t = 0; t < topics; t++) {
    const pages = Array.from({ length: 2 }, () =>
      Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, text) VALUES (?, ?, '', 'slide text')").run(docId, ++pn).lastInsertRowid),
    );
    topicIds.push(Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, ?, ?, '', ?)").run(examId, t, `Topic ${t + 1}`, JSON.stringify(pages)).lastInsertRowid));
  }
  return { examId, topicIds };
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
  rateLimited.clear();
});

describe("practice exams write sections in parallel", () => {
  it("8 sections are written at the same time", async () => {
    const w = world(8);
    const id = startAttempt(w.examId, { size: 16, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(members(id)).toHaveLength(16);
    expect(maxInFlight).toBe(8);
  });

  it("never more than 8 at once on a bigger exam", async () => {
    const w = world(20);
    const id = startAttempt(w.examId, { size: 25, mode: "tutor", style: "recall", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(members(id)).toHaveLength(25);
    expect(maxInFlight).toBe(8);
  });

  it("3 of 8 sections rate-limited (429): the exam still forms at full size from the other 5", async () => {
    const w = world(8);
    rateLimited.add("Topic 2").add("Topic 5").add("Topic 7");
    const id = startAttempt(w.examId, { size: 16, mode: "tutor", style: "recall", adaptive: false });
    const st = await ready(id);
    expect(st.status).toBe("ready");
    const rows = members(id);
    expect(rows).toHaveLength(16);
    const limited = new Set([w.topicIds[1], w.topicIds[4], w.topicIds[6]]);
    expect(rows.some((r) => limited.has(r.topic_id))).toBe(false);
    // The backfill spreads the shortfall over the sections that delivered.
    expect(new Set(rows.map((r) => r.topic_id)).size).toBe(5);
  });

  it("every section rate-limited: the exam fails with the rate-limit error instead of hanging", async () => {
    const w = world(4);
    for (let t = 1; t <= 4; t++) rateLimited.add(`Topic ${t}`);
    const id = startAttempt(w.examId, { size: 8, mode: "tutor", style: "recall", adaptive: false });
    const st = await ready(id);
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/429|rate/i);
  });

  it("case sets: 6 at once, and rate-limited ones don't sink the exam", async () => {
    const w = world(8);
    // 32 questions → 8 case sets, one per section.
    const id = startAttempt(w.examId, { size: 32, mode: "tutor", style: "caseset", adaptive: false });
    expect((await ready(id)).status).toBe("ready");
    expect(maxInFlight).toBe(6);

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
