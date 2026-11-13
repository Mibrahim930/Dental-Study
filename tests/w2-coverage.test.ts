// Wave 2, coverage (audit T5). (a) Every API route file, found on disk when the test runs: signed out it answers 401
// (or its documented public behaviour), and a signed-in stranger asking for another student's row by id gets 404 (or
// 401 on an admin route, or the documented harmless answer) and changes nothing of hers. A route file in neither table
// fails the test, so a new route can't be added without saying how it is protected. (b) Happy path and one refusal
// for the routes no test imported before.
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes read the session cookie through next/headers; tests set it here.
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", async () => {
  const { SESSION_COOKIE } = await import("@/lib/auth");
  return { cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }) };
});
// No route here may reach the AI: a call fails the request loudly instead of billing anyone.
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (o: { purpose: string }) => {
    throw new Error(`unexpected AI call: ${o.purpose}`);
  }),
  verifyKey: vi.fn(async () => "not checked in tests"),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));
// "Try again" on a lecture starts reading it in the background; here we only record that it was asked for.
const reads = vi.hoisted(() => [] as number[]);
vi.mock("@/lib/processing", async (orig) => ({
  ...(await orig<typeof import("@/lib/processing")>()),
  processDocument: vi.fn(async (id: number) => void reads.push(id)),
}));
// The backup bucket: off unless a test turns it on; every command is recorded.
const bucket = vi.hoisted(() => ({ configured: false, sent: [] as string[] }));
vi.mock("@/lib/s3", () => ({
  backupConfigured: () => bucket.configured,
  s3: () => ({
    bucket: "test",
    client: {
      send: async (cmd: { constructor: { name: string } }) => {
        bucket.sent.push(cmd.constructor.name);
        return cmd.constructor.name === "ListObjectsV2Command" ? { Contents: [] } : {};
      },
    },
  }),
}));

import { db, FILES_DIR } from "@/lib/db";
import { addReviewCard } from "@/lib/practice";
import { createClass, joinClass, shareExam } from "@/lib/classes";
import { createReport } from "@/lib/reports";
import { icsToken, plannerSettings, todayIn } from "@/lib/planner";
import { QUIZ_VERSION } from "@/lib/study";
import { POST as signupPOST } from "@/app/api/account/signup/route";
import { GET as attemptGET } from "@/app/api/attempts/[id]/route";
import { POST as answerPOST } from "@/app/api/attempts/[id]/answer/route";
import { POST as finishPOST } from "@/app/api/attempts/[id]/finish/route";
import { POST as classesPOST } from "@/app/api/classes/route";
import { POST as joinPOST } from "@/app/api/classes/join/route";
import { POST as leavePOST } from "@/app/api/classes/[id]/leave/route";
import { POST as sharePOST } from "@/app/api/classes/[id]/share/route";
import { POST as addPOST } from "@/app/api/shared/[id]/add/route";
import { POST as unsharePOST } from "@/app/api/shared/[id]/unshare/route";
import { POST as retryPOST } from "@/app/api/documents/[id]/retry/route";
import { GET as imageGET } from "@/app/api/pages/[id]/image/route";
import { POST as settingsPOST } from "@/app/api/planner/settings/route";
import { POST as icsTokenPOST } from "@/app/api/planner/ics-token/route";
import { POST as taskPOST } from "@/app/api/planner/tasks/[id]/route";
import { POST as startPOST } from "@/app/api/planner/tasks/[id]/start/route";
import { POST as reviewPOST } from "@/app/api/review/[cardId]/route";
import { POST as backupPOST } from "@/app/api/admin/backup/route";
import { apiReadyUser, ctx, getReq, postJson, sessionCookie, world } from "./helpers";

const API_DIR = path.join(process.cwd(), "src/app/api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Handler = (req: Request, ctx: never) => Promise<Response>;

/** Every route file under src/app/api, as its URL path ("exams/[id]/topics"). */
function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts" || e.name === "route.tsx") out.push(path.relative(API_DIR, dir).split(path.sep).join("/"));
    }
  };
  walk(API_DIR);
  return out.sort();
}

async function handlers(route: string): Promise<[string, Handler][]> {
  const file = fs.existsSync(path.join(API_DIR, route, "route.ts")) ? "route.ts" : "route.tsx";
  const mod = (await import(path.join(API_DIR, route, file))) as Record<string, unknown>;
  return METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as Handler]);
}

/** Route params for any route: every dynamic segment gets a value. */
const params = (id: number | string, extra: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ id: String(id), cardId: String(id), n: "0", token: String(id), ...extra }) }) as never;

const request = (method: string, body: unknown = {}) => (method === "GET" ? getReq("http://x/api?key=quiz:00000001&position=0") : postJson(body, "http://x/api", method));

const signIn = (userId: number | null) => void (jar.cookie = sessionCookie(userId));

// ------------------------------------------------------------------------------------------------------------------
// (a) Signed out. Every route is listed: 401, or what a public route does instead.

/** Routes anyone may call, with what they answer to an empty body and no session. */
const PUBLIC: Record<string, { status: number; why: string }> = {
  login: { status: 401, why: "checks the site passcode, not a session (an empty body is a wrong passcode)" },
  "account/signin": { status: 401, why: "signing in is how a session starts (an empty body is a wrong email or password)" },
  "account/signup": { status: 400, why: "making an account needs no session (an empty body is not a valid email)" },
  "account/signout": { status: 200, why: "clearing the cookie is always allowed" },
  "ics/[token]": { status: 404, why: "the calendar feed is reached by its secret token, not a session (an unknown token is not found)" },
};

describe("(a) every route refuses a signed-out request", () => {
  beforeEach(() => signIn(null));

  it("a route file exists for every public entry (the table is not stale)", () => {
    const files = new Set(routeFiles());
    expect(Object.keys(PUBLIC).filter((r) => !files.has(r))).toEqual([]);
  });

  it.each(routeFiles())("%s", async (route) => {
    const hs = await handlers(route);
    expect(hs.length, "a route file with no handler").toBeGreaterThan(0);
    for (const [method, handler] of hs) {
      const res = await handler(request(method), params("1"));
      expect(res.status, `${method} /api/${route}`).toBe(PUBLIC[route]?.status ?? 401);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// (a) A signed-in stranger asks for another student's rows by id.

/** Everything one student owns that a route can name by id. */
function ownerWorld() {
  const owner = apiReadyUser();
  const quiz = [0, 1].map((i) => ({
    id: `q${i}`,
    question: `Question ${i}?`,
    options: ["right", "w1", "w2", "w3"],
    correct_index: 0,
    explanation: "e",
    option_notes: ["r", "w", "w", "w"],
    concept: "C",
  }));
  const w = world({ userId: owner, ready: true, sections: [{ quiz }], slidesEach: 2, imagePath: "w2-cov/p1.jpg", quizVersion: QUIZ_VERSION });
  fs.mkdirSync(path.join(FILES_DIR, "w2-cov"), { recursive: true });
  fs.writeFileSync(path.join(FILES_DIR, "w2-cov", "p1.jpg"), "jpeg bytes");
  const question = Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 'Which?', ?, 0, 'e')")
      .run(w.examId, w.topicIds[0], JSON.stringify(["right", "w1", "w2", "w3"])).lastInsertRowid,
  );
  const question2 = Number(
    db
      .prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation) VALUES (?, ?, 'recall', 'And which?', ?, 1, 'e')")
      .run(w.examId, w.topicIds[0], JSON.stringify(["a", "b", "c", "d"])).lastInsertRowid,
  );
  const attempt = Number(db.prepare("INSERT INTO attempts (exam_id, mode, status) VALUES (?, 'tutor', 'ready')").run(w.examId).lastInsertRowid);
  db.prepare("INSERT INTO attempt_questions (attempt_id, question_id, position) VALUES (?, ?, 0), (?, ?, 1)").run(attempt, question, attempt, question2);
  addReviewCard(question);
  const card = (db.prepare("SELECT id FROM review_cards WHERE question_id = ?").get(question) as { id: number }).id;
  const quizme = Number(
    db
      .prepare("INSERT INTO quizme (user_id, exam_id, topic_id, text, size, questions_json, answers_json) VALUES (?, ?, ?, 'irrigation', 1, ?, '[null]')")
      .run(
        owner,
        w.examId,
        w.topicIds[0],
        JSON.stringify([{ question: "Quiz me?", options: ["right", "w1", "w2", "w3"], correct_index: 0, explanation: "e", option_notes: null, concept: "C", source_page_id: null, image_page_id: null }]),
      ).lastInsertRowid,
  );
  const today = todayIn(plannerSettings(owner).timezone);
  const task = Number(
    db
      .prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, topic_ids, minutes, title) VALUES (?, ?, ?, 'learn', ?, 30, 'Learn Topic 1')")
      .run(owner, today, w.examId, JSON.stringify([w.topicIds[0]])).lastInsertRowid,
  );
  // A busy day that repeats every day of the week, so any date is one it covers.
  const busy = Number(db.prepare("INSERT INTO busy_days (user_id, start_date, end_date, label, weekdays) VALUES (?, ?, ?, 'Clinic', 127)").run(owner, today, today).lastInsertRowid);
  const classId = createClass(owner, "Endo class");
  expect(shareExam(owner, classId, w.examId)).toBeNull();
  const shared = (db.prepare("SELECT id FROM shared_exams WHERE class_id = ? AND exam_id = ?").get(classId, w.examId) as { id: number }).id;
  const report = createReport({ userId: owner, kind: "problem", message: "it broke", page: null, meta: {}, images: [new Uint8Array([0xff, 0xd8, 0xff, 1])] });
  return { ...w, owner, question, question2, attempt, card, quizme, task, busy, classId, shared, report, today, page: w.pageIds[0][0] };
}
type Owner = ReturnType<typeof ownerWorld>;

type Probe = { id: (o: Owner) => number; body?: (o: Owner) => unknown; status?: number; why?: string };
/** How to aim each [id] route at the owner's row with a valid-looking request, and what the stranger must get. */
const STRANGER: Record<string, Probe> = {
  "admin/reports/[id]/image/[n]": { id: (o) => o.report, status: 401, why: "admin only" },
  "admin/reports/[id]/seen": { id: (o) => o.report, status: 401, why: "admin only" },
  "admin/users/[id]/delete": { id: (o) => o.owner, status: 401, why: "admin only" },
  "admin/users/[id]/reset-password": { id: (o) => o.owner, status: 401, why: "admin only" },
  "attempts/[id]": { id: (o) => o.attempt },
  "attempts/[id]/answer": { id: (o) => o.attempt, body: (o) => ({ questionId: o.question, chosen: 0 }) },
  "attempts/[id]/finish": { id: (o) => o.attempt },
  "attempts/[id]/report": { id: (o) => o.attempt, body: (o) => ({ questionId: o.question, reason: "x" }) },
  "calendar/busy/[id]/delete": { id: (o) => o.busy, status: 200, why: "deletes only the signed-in student's own busy days, so another's id is a no-op" },
  "calendar/busy/[id]/skip": { id: (o) => o.busy, body: (o) => ({ date: o.today }) },
  "classes/[id]/leave": { id: (o) => o.classId, status: 200, why: "leaving a class you are not in does nothing" },
  "classes/[id]/share": { id: (o) => o.classId, body: (o) => ({ examId: o.examId }), status: 400, why: "\"You're not in that class.\"" },
  "documents/[id]": { id: (o) => o.docIds[0] },
  "documents/[id]/retry": { id: (o) => o.docIds[0] },
  "exams/[id]/attempts": { id: (o) => o.examId, body: () => ({ size: 5 }) },
  "exams/[id]/topics": { id: (o) => o.examId, body: () => ({ mode: "full" }) },
  "exams/[id]/upload": { id: (o) => o.examId },
  "pages/[id]/image": { id: (o) => o.page },
  "planner/tasks/[id]": { id: (o) => o.task, body: () => ({ status: "done" }), status: 200, why: "ticks only the signed-in student's own tasks, so another's id is a no-op" },
  "planner/tasks/[id]/start": { id: (o) => o.task },
  "questions/[id]/flag": { id: (o) => o.question, body: () => ({ reason: "x" }) },
  "quizme/[id]": { id: (o) => o.quizme },
  "quizme/[id]/answer": { id: (o) => o.quizme, body: () => ({ index: 0, chosen: 0 }) },
  "quizme/[id]/report": { id: (o) => o.quizme, body: () => ({ index: 0, reason: "x" }) },
  "review/[cardId]": { id: (o) => o.card, body: () => ({ correct: true }) },
  "sessions/[id]/check": { id: (o) => o.sessionId, body: (o) => ({ topicId: o.topicIds[0], index: 0, chosen: 0 }) },
  "sessions/[id]/end": { id: (o) => o.sessionId },
  "sessions/[id]/lesson": { id: (o) => o.sessionId },
  "sessions/[id]/quiz": { id: (o) => o.sessionId },
  "sessions/[id]/quiz/regenerate": { id: (o) => o.sessionId, body: (o) => ({ topicId: o.topicIds[0] }) },
  "sessions/[id]/quiz/report": { id: (o) => o.sessionId, body: (o) => ({ topicId: o.topicIds[0], questionId: "q0", reason: "x" }) },
  "sessions/[id]/quiz/retake": { id: (o) => o.sessionId, body: (o) => ({ topicId: o.topicIds[0] }) },
  "sessions/[id]/shown": { id: (o) => o.sessionId, body: () => ({ position: 0 }) },
  "shared/[id]/add": { id: (o) => o.shared, status: 400, why: "\"That shared exam isn't available to you.\" (not in the class)" },
  "shared/[id]/unshare": { id: (o) => o.shared, status: 200, why: "removes only shares the signed-in student made, so another's id is a no-op" },
};
/** [id]-style routes the stranger table does not exercise, and why. */
const NOT_GENERIC: Record<string, string> = {
  "ics/[token]": "public by design: the secret token in the link is the key (refusal of an unknown token is in the signed-out table)",
};

/** Every row in the database except the stranger's own (her plan is rebuilt by some routes), as sorted JSON per table. */
function snapshot(stranger: number): Record<string, string[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%'").all() as { name: string }[]).map(
    (t) => t.name,
  );
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
    const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
    out[t] = rows
      .filter((r) => !(cols.includes("user_id") && r.user_id === stranger) && !(t === "users" && r.id === stranger))
      .map((r) => JSON.stringify(r))
      .sort();
  }
  return out;
}

const dynamic = (route: string) => route.includes("[");

describe("(a) a signed-in stranger asking for another student's row by id", () => {
  it("every [id]-style route is in exactly one table, and every table entry is a real route", () => {
    const files = routeFiles().filter(dynamic);
    expect(files.filter((r) => !(r in STRANGER) && !(r in NOT_GENERIC)), "routes in neither table: add them to STRANGER or NOT_GENERIC").toEqual([]);
    expect(files.filter((r) => r in STRANGER && r in NOT_GENERIC)).toEqual([]);
    expect([...Object.keys(STRANGER), ...Object.keys(NOT_GENERIC)].filter((r) => !files.includes(r)), "stale entries").toEqual([]);
  });

  it.each(routeFiles().filter((r) => r in STRANGER))("%s", async (route) => {
    const probe = STRANGER[route];
    const o = ownerWorld();
    const stranger = apiReadyUser();
    signIn(stranger);
    const before = snapshot(stranger);
    for (const [method, handler] of await handlers(route)) {
      const res = await handler(request(method, probe.body?.(o) ?? {}), params(probe.id(o)));
      expect(res.status, `${method} /api/${route}${probe.why ? ` (${probe.why})` : ""}`).toBe(probe.status ?? 404);
    }
    expect(snapshot(stranger), `${route} changed another student's data`).toEqual(before);
    expect(reads).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// (b) Routes that no test imported before: the happy path and one refusal each. (login, account/signin and the
// account/signup refusals are covered in tests/w1-auth.test.ts; the sign-up happy path is added here.)

const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;

describe("(b) account/signup", () => {
  it("a new email and a long enough password make an account and sign it in", async () => {
    const email = `w2-new-${Date.now()}@test.dev`;
    const res = await signupPOST(postJson({ email: ` ${email.toUpperCase()} `, password: "long-enough-1" }, "http://x/api/account/signup"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/study_session=/);
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE email = ?", email)).toEqual({ n: 1 });
  });

  it("refuses a password under 8 characters", async () => {
    const res = await signupPOST(postJson({ email: `w2-short-${Date.now()}@test.dev`, password: "short" }, "http://x/api/account/signup"));
    expect(res.status).toBe(400);
  });
});

describe("(b) attempts", () => {
  it("GET shows her own exam; answer records the choice; finish scores it", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    const view = await attemptGET(getReq(), ctx(o.attempt));
    expect(view.status).toBe(200);
    expect(((await view.json()) as { questions: unknown[] }).questions).toHaveLength(2);
    expect((await answerPOST(postJson({ questionId: o.question, chosen: 0, confidence: "sure" }), ctx(o.attempt))).status).toBe(200);
    expect(one("SELECT chosen_index, correct, confidence FROM attempt_questions WHERE attempt_id = ? AND question_id = ?", o.attempt, o.question)).toEqual({
      chosen_index: 0,
      correct: 1,
      confidence: "sure",
    });
    expect((await finishPOST(postJson({}), ctx(o.attempt))).status).toBe(200);
    expect(one("SELECT status, score FROM attempts WHERE id = ?", o.attempt)).toEqual({ status: "finished", score: 0.5 });
  });

  it("refusals: an answer without a question id is 400; another student's attempt is 404 to GET", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    expect((await answerPOST(postJson({ chosen: 0 }), ctx(o.attempt))).status).toBe(400);
    signIn(apiReadyUser());
    expect((await attemptGET(getReq(), ctx(o.attempt))).status).toBe(404);
    expect((await finishPOST(postJson({}), ctx(o.attempt))).status).toBe(404);
    expect(one("SELECT status FROM attempts WHERE id = ?", o.attempt)).toEqual({ status: "ready" });
  });
});

describe("(b) classes and shared exams", () => {
  it("create, join by code, share a ready exam, a classmate adds a copy, then unshare and leave", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    const made = await classesPOST(postJson({ name: "  Perio   study  " }));
    expect(made.status).toBe(200);
    const classId = ((await made.json()) as { id: number }).id;
    const code = one<{ invite_code: string }>("SELECT invite_code FROM classes WHERE id = ?", classId).invite_code;
    expect((await sharePOST(postJson({ examId: o.examId }), ctx(classId))).status).toBe(200);
    const shared = one<{ id: number }>("SELECT id FROM shared_exams WHERE class_id = ? AND exam_id = ?", classId, o.examId).id;

    const mate = apiReadyUser();
    signIn(mate);
    const joined = await joinPOST(postJson({ code: code.toLowerCase() }));
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ id: classId });
    const added = await addPOST(postJson({}), ctx(shared));
    expect(added.status).toBe(200);
    const copy = ((await added.json()) as { examId: number }).examId;
    expect(one("SELECT user_id, source_exam_id FROM exams WHERE id = ?", copy)).toEqual({ user_id: mate, source_exam_id: o.examId });

    signIn(o.owner);
    expect((await unsharePOST(postJson({}), ctx(shared))).status).toBe(200);
    expect(one("SELECT COUNT(*) n FROM shared_exams WHERE id = ?", shared)).toEqual({ n: 0 });
    expect(one("SELECT COUNT(*) n FROM exams WHERE id = ?", copy)).toEqual({ n: 1 }); // the classmate keeps her copy
    signIn(mate);
    expect((await leavePOST(postJson({}), ctx(classId))).status).toBe(200);
    expect(one("SELECT COUNT(*) n FROM class_members WHERE class_id = ? AND user_id = ?", classId, mate)).toEqual({ n: 0 });
  });

  it("refusals: a class with no name, an unknown code, and adding a share from a class you are not in", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    expect((await classesPOST(postJson({ name: "   " }))).status).toBe(400);
    expect((await joinPOST(postJson({ code: "NOPE00" }))).status).toBe(404);
    const outsider = apiReadyUser();
    signIn(outsider);
    expect((await addPOST(postJson({}), ctx(o.shared))).status).toBe(400);
    expect(one("SELECT COUNT(*) n FROM exams WHERE user_id = ?", outsider)).toEqual({ n: 0 });
    // and a member can't share an exam that isn't hers
    joinClass(outsider, one<{ invite_code: string }>("SELECT invite_code FROM classes WHERE id = ?", o.classId).invite_code);
    expect((await sharePOST(postJson({ examId: o.examId }), ctx(o.classId))).status).toBe(400);
  });
});

describe("(b) documents/[id]/retry", () => {
  beforeEach(() => void reads.splice(0));

  it("starts reading her lecture again", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    expect((await retryPOST(postJson({}), ctx(o.docIds[0]))).status).toBe(200);
    expect(reads).toEqual([o.docIds[0]]);
  });

  it("another student's lecture is 404 and nothing is read", async () => {
    const o = ownerWorld();
    signIn(apiReadyUser());
    expect((await retryPOST(postJson({}), ctx(o.docIds[0]))).status).toBe(404);
    expect(reads).toEqual([]);
  });
});

describe("(b) pages/[id]/image", () => {
  it("serves her slide's picture as a private, cacheable JPEG", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    const res = await imageGET(getReq(), ctx(o.page));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("jpeg bytes");
  });

  it("a slide whose picture is missing on disk is 404", async () => {
    const o = ownerWorld();
    db.prepare("UPDATE pages SET image_path = 'w2-cov/never-written.jpg' WHERE id = ?").run(o.pageIds[0][1]);
    signIn(o.owner);
    expect((await imageGET(getReq(), ctx(o.pageIds[0][1]))).status).toBe(404);
  });
});

describe("(b) planner routes", () => {
  it("settings: saves minutes, review time and a real time zone, and answers with the plan's warnings", async () => {
    const u = apiReadyUser();
    signIn(u);
    const res = await settingsPOST(postJson({ weekdayMinutes: [10, 20, 30, 40, 50, 60, 2000], reviewMinutes: 15, timezone: "Europe/Paris" }));
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { warnings: unknown }).warnings)).toBe(true);
    const s = plannerSettings(u);
    expect(JSON.parse(s.weekday_minutes)).toEqual([10, 20, 30, 40, 50, 60, 960]); // capped at 16 hours
    expect([s.review_minutes, s.timezone]).toEqual([15, "Europe/Paris"]);
  });

  it("settings: an unknown time zone keeps the saved one", async () => {
    const u = apiReadyUser();
    signIn(u);
    const tz = plannerSettings(u).timezone;
    expect((await settingsPOST(postJson({ timezone: "Mars/Olympus" }))).status).toBe(200);
    expect(plannerSettings(u).timezone).toBe(tz);
  });

  it("ics-token: a new feed link replaces the old one, and the old one stops working", async () => {
    const u = apiReadyUser();
    signIn(u);
    const old = icsToken(u);
    expect((await icsTokenPOST()).status).toBe(200);
    expect(icsToken(u)).not.toBe(old);
    signIn(null);
    expect((await icsTokenPOST()).status).toBe(401);
  });

  it("tasks/[id]: ticks her task done and back; a body without a status is refused", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    expect((await taskPOST(postJson({ status: "done" }), ctx(o.task))).status).toBe(200);
    expect(one("SELECT status FROM plan_tasks WHERE id = ?", o.task)).toEqual({ status: "done" });
    expect(one("SELECT COUNT(*) n FROM topic_study WHERE user_id = ? AND topic_id = ?", o.owner, o.topicIds[0])).toEqual({ n: 1 });
    expect((await taskPOST(postJson({ status: "todo" }), ctx(o.task))).status).toBe(200);
    expect(one("SELECT status FROM plan_tasks WHERE id = ?", o.task)).toEqual({ status: "todo" });
    expect((await taskPOST(postJson({}), ctx(o.task))).status).toBe(400);
    expect(one("SELECT status FROM plan_tasks WHERE id = ?", o.task)).toEqual({ status: "todo" });
  });

  it("tasks/[id]/start: a learn task leads to the study page at its section; a review task to the review; an unknown task is 404", async () => {
    const o = ownerWorld();
    signIn(o.owner);
    const res = await startPOST(postJson({}), ctx(o.task));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: `/exams/${o.examId}/study?topic=0` });
    const review = Number(
      db.prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, minutes, title) VALUES (?, ?, NULL, 'review', 10, 'Review')").run(o.owner, o.today).lastInsertRowid,
    );
    expect(await (await startPOST(postJson({}), ctx(review))).json()).toEqual({ url: "/review" });
    expect((await startPOST(postJson({}), ctx(999999))).status).toBe(404);
  });
});

describe("(b) review/[cardId]", () => {
  it("grades her card, moves its due date, and ticks today's review task once nothing is due", async () => {
    const o = ownerWorld();
    db.prepare("UPDATE review_cards SET due = datetime('now', '-1 day') WHERE id = ?").run(o.card);
    const review = Number(
      db.prepare("INSERT INTO plan_tasks (user_id, date, exam_id, kind, minutes, title) VALUES (?, ?, NULL, 'review', 10, 'Review')").run(o.owner, o.today).lastInsertRowid,
    );
    const due = one<{ due: string }>("SELECT due FROM review_cards WHERE id = ?", o.card).due;
    signIn(o.owner);
    expect((await reviewPOST(postJson({ correct: true, confidence: "easy" }), ctx(o.card))).status).toBe(200);
    expect(one<{ due: string }>("SELECT due FROM review_cards WHERE id = ?", o.card).due).not.toBe(due);
    expect(one("SELECT status FROM plan_tasks WHERE id = ?", review)).toEqual({ status: "done" });
  });

  it("an answer without `correct` is refused and the card is untouched", async () => {
    const o = ownerWorld();
    const before = one("SELECT * FROM review_cards WHERE id = ?", o.card);
    signIn(o.owner);
    expect((await reviewPOST(postJson({ confidence: "easy" }), ctx(o.card))).status).toBe(400);
    expect(one("SELECT * FROM review_cards WHERE id = ?", o.card)).toEqual(before);
  });
});

describe("(b) admin/backup", () => {
  beforeEach(() => {
    bucket.configured = false;
    bucket.sent.splice(0);
  });

  it("the site owner runs a backup to the bucket; without the bucket settings she gets a plain message", async () => {
    signIn(apiReadyUser(true));
    const off = await backupPOST();
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ ok: false, message: expect.stringMatching(/aren't configured/) });
    expect(bucket.sent).toEqual([]);
    bucket.configured = true;
    const on = await backupPOST();
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ ok: true });
    expect(bucket.sent).toContain("PutObjectCommand");
  });

  it("a student who is not the owner gets 401 and nothing is sent", async () => {
    signIn(apiReadyUser());
    bucket.configured = true;
    expect((await backupPOST()).status).toBe(401);
    expect(bucket.sent).toEqual([]);
  });
});
