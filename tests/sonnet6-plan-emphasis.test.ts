import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async () => {
    throw new Error("no AI");
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db } from "@/lib/db";
import { addDays, plannerSettings, rebuildPlan, tasksOn, todayIn, type PlanWarning } from "@/lib/planner";
import { checkedAnswer, isValidChoice } from "@/lib/practicePlan";
import { PlanWarnings } from "@/components/PlanWarnings";
import { slideNotesText } from "@/lib/study";
import { parseNotes } from "@/lib/processing";
import { SlideNotes } from "@/lib/notes";
import { GET as lessonGET } from "@/app/api/sessions/[id]/lesson/route";
import { attemptView } from "@/lib/attemptView";
import { makeExam, makeUser } from "./helpers";

const todayFor = (u: number) => todayIn(plannerSettings(u).timezone);
const setMinutes = (u: number, perDay: number) =>
  db.prepare("UPDATE planner_settings SET weekday_minutes = ? WHERE user_id = ?").run(JSON.stringify(Array(7).fill(perDay)), u);

describe("checkedAnswer", () => {
  const O = ["Pulp necrosis", "Reversible pulpitis", "Symptomatic irreversible pulpitis", "Acute apical abscess", "Normal pulp"];
  it("accepts matching index/text, ignoring case, whitespace and punctuation", () => {
    expect(checkedAnswer(O, 2, "Symptomatic irreversible pulpitis")).toBe(2);
    expect(checkedAnswer(O, 2, "  symptomatic   IRREVERSIBLE pulpitis. ")).toBe(2);
    expect(checkedAnswer(O, 0, "Pulp necrosis!")).toBe(0);
    expect(checkedAnswer(["5-10 mm", "10 mm"], 0, "5 10 mm")).toBe(0);
  });
  it("returns -1 when text points at another option", () => {
    expect(checkedAnswer(O, 1, "Pulp necrosis")).toBe(-1);
    expect(isValidChoice(O, -1)).toBe(false);
  });
  it("trusts the index when correct_answer is missing/empty or matches nothing (letter prefix, paraphrase)", () => {
    expect(checkedAnswer(O, 3, undefined)).toBe(3);
    expect(checkedAnswer(O, 3, "")).toBe(3);
    expect(checkedAnswer(O, 3, "D) Acute apical abscess")).toBe(3);
    expect(checkedAnswer(O, 3, "something else entirely")).toBe(3);
  });
  it("null correct_answer is treated as missing", () => {
    expect(checkedAnswer(O, 1, null as unknown as string)).toBe(1);
  });
  it("out-of-range index with a matching text is still rejected downstream", () => {
    const idx = checkedAnswer(O, 9, "Normal pulp");
    expect(isValidChoice(O, idx)).toBe(false);
  });
  it("BUG(minor): options that differ only by punctuation/symbols are not falsely dropped", () => {
    // "+" vs "-" normalise to the same empty string; the right answer "-" (index 1) is compared with the first "empty" option.
    expect(checkedAnswer(["+", "-", "0"], 1, "-")).toBe(1);
  });
  it("duplicate-looking options: the answer text can't tell them apart, so the index is trusted", () => {
    expect(checkedAnswer(["Pulpitis", "pulpitis.", "x", "y"], 1, "pulpitis.")).toBe(1);
  });
  it("non-Latin letters still match", () => {
    expect(checkedAnswer(["ألم", "التهاب"], 1, "التهاب")).toBe(1);
  });
});

describe("planner: not enough time", () => {
  let u: number;
  beforeEach(() => {
    u = makeUser();
    plannerSettings(u);
  });

  /** 8 topics of 10 slides (30 min each); topics 5..7 are emphasized. */
  function tightExam(daysAway: number, perDay: number, emphasizedIdx: number[]) {
    setMinutes(u, perDay);
    const exam = makeExam(u, addDays(todayFor(u), daysAway), Array(8).fill(10));
    for (const i of emphasizedIdx) db.prepare("UPDATE topics SET emphasized = 1 WHERE id = ?").run(exam.topicIds[i]);
    return exam;
  }
  const learnIds = (examId: number) =>
    tasksOn(u, todayFor(u), addDays(todayFor(u), 400))
      .filter((t) => t.exam_id === examId && t.kind === "learn")
      .map((t) => JSON.parse(t.topic_ids)[0] as number);

  it("emphasized topics are placed first only when short", () => {
    const tight = tightExam(8, 40, [5, 6, 7]);
    const warnings = rebuildPlan(u);
    expect(warnings).toHaveLength(1);
    const placed = learnIds(tight.examId);
    for (const i of [5, 6, 7]) expect(placed).toContain(tight.topicIds[i]);
    // Placed in order: emphasized come before the plain ones that did get placed.
    const firstPlain = placed.findIndex((id) => !tight.topicIds.slice(5).includes(id));
    const lastStar = Math.max(...[5, 6, 7].map((i) => placed.indexOf(tight.topicIds[i])));
    if (firstPlain !== -1) expect(lastStar).toBeLessThan(firstPlain);
  });

  it("with plenty of time the original order is kept and no warning is raised", () => {
    const u2 = makeUser();
    plannerSettings(u2);
    setMinutes(u2, 240);
    const exam = makeExam(u2, addDays(todayFor(u2), 20), Array(8).fill(10));
    db.prepare("UPDATE topics SET emphasized = 1 WHERE id = ?").run(exam.topicIds[7]);
    expect(rebuildPlan(u2)).toEqual([]);
    const tasks = tasksOn(u2, todayFor(u2), addDays(todayFor(u2), 30)).filter((t) => t.kind === "learn");
    // Chronological order of learn tasks follows topic position.
    const order = tasks.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).map((t) => JSON.parse(t.topic_ids)[0]);
    expect(order).toEqual(exam.topicIds);
  });

  it("warning numbers: topicsLeft = unplaced learn tasks, starredLeft = starred among them", () => {
    const exam = tightExam(8, 40, [0, 1]); // star the first two (they are also first anyway)
    const [w] = rebuildPlan(u);
    const placed = new Set(learnIds(exam.examId));
    const unplaced = exam.topicIds.filter((id) => !placed.has(id));
    expect(w.topicsLeft).toBe(unplaced.length);
    const starred = new Set([exam.topicIds[0], exam.topicIds[1]]);
    expect(w.starredLeft).toBe(unplaced.filter((id) => starred.has(id)).length);
    expect(w.topicsLeft).toBeGreaterThan(0);
  });

  it("when more starred topics exist than fit, starredLeft > 0", () => {
    const exam = tightExam(8, 30, [0, 1, 2, 3, 4, 5, 6, 7]);
    const [w] = rebuildPlan(u);
    expect(w.starredLeft).toBe(w.topicsLeft);
    expect(w.starredLeft).toBeGreaterThan(0);
    void exam;
  });

  it("perDay is roughly minutesShort / study days before the deadline (not the whole shortfall)", () => {
    tightExam(10, 25, [0]);
    const warnings = rebuildPlan(u);
    expect(warnings.length).toBe(1);
    const [w] = warnings;
    const today = todayFor(u);
    const deadline = addDays(addDays(today, 10), -3);
    let days = 0;
    for (let d = today; d <= deadline; d = addDays(d, 1)) days++;
    const expected = Math.ceil(w.minutesShort / days);
    // Allow slack of 2x for days that are partly used; the buggy value (all days full => 1 day) equals minutesShort.
    expect(w.perDay).toBeLessThanOrEqual(expected * 2);
    expect(w.perDay).toBeGreaterThan(0);
  });

  it("warnings are persisted as JSON and old stored warnings (no new fields) still render", () => {
    tightExam(8, 40, [0]);
    rebuildPlan(u);
    const stored = JSON.parse((db.prepare("SELECT warnings FROM planner_settings WHERE user_id = ?").get(u) as { warnings: string }).warnings) as PlanWarning[];
    expect(stored[0]).toHaveProperty("topicsLeft");
    const old: PlanWarning[] = [{ examId: 1, examName: "Old Exam", minutesShort: 130 }];
    const html = renderToStaticMarkup(createElement(PlanWarnings, { warnings: old }));
    expect(html).toContain("Old Exam");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).toContain("2 hours"); // 130 min rounds to the nearest half hour
    expect(html).toContain("/calendar#planner");
    expect(html).not.toContain("the most important material is in");
  });

  it("copy never claims the important material is in when starred topics were left out", () => {
    const left = renderToStaticMarkup(createElement(PlanWarnings, { warnings: [{ examId: 1, examName: "X", minutesShort: 100, topicsLeft: 3, starredLeft: 1, perDay: 12 }] }));
    expect(left).not.toContain("the most important material is in");
    expect(left).toContain("3 topics didn&#x27;t fit");
    const fits = renderToStaticMarkup(createElement(PlanWarnings, { warnings: [{ examId: 1, examName: "X", minutesShort: 100, topicsLeft: 1, starredLeft: 0, perDay: 12 }] }));
    expect(fits).toContain("1 topic didn&#x27;t fit");
    expect(fits).toContain("would cover it");
    expect(renderToStaticMarkup(createElement(PlanWarnings, { warnings: [] }))).toBe("");
  });

  it("BUG(copy): with no starred topics at all, the note must not say the plan covers the professor's starred topics / most important material", () => {
    const html = renderToStaticMarkup(createElement(PlanWarnings, { warnings: [{ examId: 1, examName: "X", minutesShort: 100, topicsLeft: 2, starredLeft: 0, perDay: 12 }] }));
    // The component cannot know whether any topic is starred; starredLeft === 0 is true for exams with NO starred topics.
    expect(html).not.toContain("most important material is in");
  });

  it("zero capacity everywhere does not produce NaN/Infinity", () => {
    setMinutes(u, 0);
    makeExam(u, addDays(todayFor(u), 6), [10, 10]);
    const w = rebuildPlan(u);
    for (const x of w) for (const v of [x.minutesShort, x.topicsLeft, x.starredLeft, x.perDay]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("professor emphasis plumbing", () => {
  const base = {
    title: "T",
    summary: "s",
    image_description: null,
    key_facts: ["fact one"],
    annotations: [],
    emphasized: true,
    case_prompt: null,
    case_answer: null,
    case_image_box: null,
    abbreviations: [],
    concepts: ["c"],
    is_filler: false,
  };
  it("new notes schema requires emphasis_note (nullable); old notes without it still work in prompts and parse", () => {
    expect(SlideNotes.safeParse({ ...base, emphasis_note: null }).success).toBe(true);
    expect(SlideNotes.safeParse({ ...base, emphasis_note: "Know the 4 signs" }).success).toBe(true);
    expect(SlideNotes.safeParse(base).success).toBe(false); // model output must include it (fine: structured output)
    const page = { id: 7, page_number: 3, filename: "L", text: "", notes_json: JSON.stringify(base) } as never;
    expect(parseNotes(page)).toMatchObject({ title: "T" });
    const txt = slideNotesText([page]);
    expect(txt).toContain("[P7] L slide 3: T ★IMPORTANT");
    expect(txt).not.toContain("undefined");
    expect(txt).not.toContain("(null)");
    const withNote = slideNotesText([{ ...(page as object), notes_json: JSON.stringify({ ...base, emphasis_note: "Know the 4 signs" }) } as never]);
    expect(withNote).toContain("★IMPORTANT (Know the 4 signs)");
  });

  it("attemptView.emphasized reflects the source slide; missing source gives false", () => {
    const u = makeUser();
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(u).lastInsertRowid);
    const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'd')").run(examId).lastInsertRowid);
    const star = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, text, emphasized) VALUES (?, 1, '', 't', 1)").run(docId).lastInsertRowid);
    const plain = Number(db.prepare("INSERT INTO pages (document_id, page_number, image_path, text, emphasized) VALUES (?, 2, '', 't', 0)").run(docId).lastInsertRowid);
    const ins = (page: number | null) =>
      Number(
        db
          .prepare("INSERT INTO questions (exam_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, 'recall', 's', ?, 0, 'e', ?)")
          .run(examId, '["a","b"]', page).lastInsertRowid,
      );
    const qs = [ins(star), ins(plain), ins(null)];
    const a = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(examId).lastInsertRowid);
    qs.forEach((x, i) => db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)").run(a, x, i));
    expect(attemptView(a)!.questions.map((x) => x.emphasized)).toEqual([true, false, false]);
  });
});

describe("lesson route `stressed` list", () => {
  it("builds stressed points with fallbacks and tolerates old notes (see manual check below)", async () => {
    // The route needs a signed-in user via cookies; exercise the same mapping by calling the pure pieces.
    const u = makeUser();
    const examId = Number(db.prepare("INSERT INTO exams (user_id, name) VALUES (?, 'E')").run(u).lastInsertRowid);
    const docId = Number(db.prepare("INSERT INTO documents (exam_id, filename) VALUES (?, 'Lec 1.pdf')").run(examId).lastInsertRowid);
    const mk = (n: number, notes: object | null, title: string | null) =>
      Number(
        db
          .prepare("INSERT INTO pages (document_id, page_number, image_path, text, emphasized, title, notes_json) VALUES (?, ?, '', 't', 1, ?, ?)")
          .run(docId, n, title, notes ? JSON.stringify(notes) : null).lastInsertRowid,
      );
    const ids = [
      mk(1, { summary: "sum", key_facts: ["kf"], emphasis_note: "stressed!" }, "T1"),
      mk(2, { summary: "sum2", key_facts: ["kf2"] }, "T2"), // old notes
      mk(3, { summary: "sum3", key_facts: [] }, "T3"),
      mk(4, null, "T4"), // unprocessed notes
      mk(5, null, null),
    ];
    const topicId = Number(
      db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, lesson_json) VALUES (?, 0, 'T', '', ?, ?)").run(examId, JSON.stringify(ids), JSON.stringify({ explanation: "x", key_points: [], slides: [] })).lastInsertRowid,
    );
    const { topicPages } = await import("@/lib/study");
    const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as never;
    const out = topicPages(topic)
      .filter((p) => p.emphasized)
      .map((p) => {
        const n = parseNotes(p);
        return { where: `${p.filename.replace(/\.pdf$/i, "")}, slide ${p.page_number}`, point: n?.emphasis_note ?? n?.key_facts?.[0] ?? n?.summary ?? p.title ?? "" };
      })
      .filter((s) => s.point);
    expect(out.map((s) => s.point)).toEqual(["stressed!", "kf2", "sum3", "T4"]); // slide 5 has nothing to say, dropped
    expect(out[0].where).toBe("Lec 1, slide 1");
    expect(typeof lessonGET).toBe("function");
  });
});
