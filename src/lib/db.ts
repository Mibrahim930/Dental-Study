import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "./data");
export const FILES_DIR = path.join(DATA_DIR, "files");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  provider TEXT,                                   -- anthropic | openai
  api_key_enc TEXT,                                -- AES-GCM encrypted with SECRET_KEY
  api_key_last4 TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,             -- the site owner (first account)
  must_change_password INTEGER NOT NULL DEFAULT 0, -- set after an admin password reset
  focus_weak INTEGER NOT NULL DEFAULT 1,           -- practice exams lean toward missed / unsure material
  theme TEXT NOT NULL DEFAULT 'blocks',            -- colour theme, see lib/themes.ts
  session_epoch INTEGER NOT NULL DEFAULT 0,        -- bumped on a password change: older sign-in cookies stop working
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  course TEXT,
  exam_date TEXT,
  kind TEXT NOT NULL DEFAULT 'block',              -- block | quiz | practical | board | other
  source_exam_id INTEGER,                          -- set when added from a classmate's shared exam
  status TEXT NOT NULL DEFAULT 'active',           -- active | archived
  topic_status TEXT NOT NULL DEFAULT 'none',       -- none | building | ready | error
  topic_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | processing | done | error
  error TEXT,
  batch_id TEXT,                                   -- Anthropic Message Batch reading this lecture's slides
  backed_up INTEGER NOT NULL DEFAULT 0,            -- original PDF copied to the backup bucket
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  batch_at TEXT                                    -- when batch_id was sent (a batch that can't be collected for a day is given up)
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL,
  aspect REAL NOT NULL DEFAULT 1.333,              -- width / height of the slide
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | done | error
  title TEXT,
  notes_json TEXT,
  emphasized INTEGER NOT NULL DEFAULT 0,
  has_case INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  is_filler INTEGER,                               -- title / agenda / thank-you slide (notes' is_filler); NULL = no notes yet
  UNIQUE(document_id, page_number)
);

-- Full-text search over every slide the student has ever uploaded (cross-exam memory).
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  page_id UNINDEXED, title, content, tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS concepts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  attempts INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  page_ids TEXT NOT NULL DEFAULT '[]',
  emphasized INTEGER NOT NULL DEFAULT 0,
  lesson_json TEXT,
  checks_json TEXT,                                -- section quiz shown after the lesson (JSON array; see lib/study.ts)
  checks_version INTEGER,                          -- how checks_json was written: NULL = old 10-question quiz,
                                                   -- 2 = 20 questions planned over the slides and checked by a second AI pass.
                                                   -- Quizzes older than QUIZ_VERSION are rewritten once on next open.
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE -- the lecture this section belongs to; NULL = old-style
                                                   -- topic from before topic maps were built per lecture
);

CREATE TABLE IF NOT EXISTS topic_concepts (
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, concept_id)
);

CREATE TABLE IF NOT EXISTS glossary (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  abbr TEXT NOT NULL COLLATE NOCASE,
  meaning TEXT NOT NULL,
  UNIQUE(user_id, abbr)
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  current_position INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                              -- user | assistant
  content TEXT NOT NULL,
  topic_position INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Answers to the quick checks inside study sessions (fed into session summaries).
CREATE TABLE IF NOT EXISTS session_checks (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  correct INTEGER NOT NULL,
  check_index INTEGER,                             -- position in the topic's section quiz
  chosen INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Board-style case: one patient shared by several questions.
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  scenario TEXT NOT NULL,
  patient_box TEXT NOT NULL,                       -- JSON
  image_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  concept_id INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                              -- recall | case | image
  patient_box TEXT,                                -- JSON for case questions
  stem TEXT NOT NULL,
  options TEXT NOT NULL,                           -- JSON string[]
  correct_index INTEGER NOT NULL,
  explanation TEXT NOT NULL,
  source_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  image_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,   -- set for questions in a board-style case set
  root_question_id INTEGER,                                 -- original question this was copied from (class sharing)
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_note TEXT,
  option_notes TEXT,                               -- JSON string[]: one sentence per option (why right / why wrong), same order as options
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fact_key TEXT                                    -- the exam-plan slot key it was written for (lib/examPlan.ts factKey, or "slide:<page id>");
                                                   -- NULL for questions written before exams were planned
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,                              -- tutor | timed
  task_id INTEGER,                                 -- plan task this attempt was started from
  adaptive INTEGER NOT NULL DEFAULT 1,             -- built with "focus on weak spots" on
  plan_json TEXT,                                  -- what the exam is being built from, shown while it's written
  status TEXT NOT NULL DEFAULT 'generating',       -- generating | ready | finished | error
  error TEXT,
  time_limit_sec INTEGER,
  score REAL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  requested INTEGER,                               -- how many questions she asked for
  slots_json TEXT,                                 -- the exam plan (lib/examPlan.ts ExamPlan): every planned question and its state
  short_reason TEXT,                               -- NULL, or why writing stopped short: key | busy | interrupted
  resumed_at TEXT,                                 -- when writing the missing questions was last tried
  options_json TEXT                                -- what the exam was started with (style, scope, adaptive), so it can resume
);

CREATE TABLE IF NOT EXISTS attempt_questions (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  chosen_index INTEGER,                            -- index into questions.options (not the shuffled display order)
  correct INTEGER,
  confidence TEXT,                                 -- guess | unsure | sure, given before the answer is revealed
  option_order TEXT,                               -- JSON display order of options, for questions retried from an earlier exam
  reported INTEGER NOT NULL DEFAULT 0,             -- reported mid-exam: out of this exam and its score
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS review_cards (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
  card_json TEXT NOT NULL,
  due TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Calendar: days the student can't study (clinic, travel, holidays). Inclusive range.
-- weekdays set = repeats every week on those days (bit 0 = Monday … bit 6 = Sunday) from start_date until end_date.
CREATE TABLE IF NOT EXISTS busy_days (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'Busy',
  weekdays INTEGER
);

-- Single weeks taken out of a repeating busy day ("skip this week").
CREATE TABLE IF NOT EXISTS busy_skips (
  busy_id INTEGER NOT NULL REFERENCES busy_days(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (busy_id, date)
);

-- Study planner settings, one row per user.
CREATE TABLE IF NOT EXISTS planner_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weekday_minutes TEXT NOT NULL DEFAULT '[120,120,120,120,120,120,180]', -- Mon..Sun
  review_minutes INTEGER NOT NULL DEFAULT 15,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  ics_token TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',             -- JSON: exams the plan couldn't fully fit
  rebuilt_on TEXT,
  missed_seen_through TEXT                         -- "Re-plan from today" pressed: missed tasks up to this date are dealt with
);

-- Study time for one particular day, instead of the usual for that weekday (0 = day off).
CREATE TABLE IF NOT EXISTS day_overrides (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- Topics the student has worked through in a study session (drives the planner).
CREATE TABLE IF NOT EXISTS topic_study (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  studied_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, topic_id)
);

-- The study plan: one row per task per day. Future to-do tasks are regenerated by the planner.
CREATE TABLE IF NOT EXISTS plan_tasks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                              -- learn | practice | weak_review | final_practice | review | upload
  topic_ids TEXT NOT NULL DEFAULT '[]',
  minutes INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',             -- todo | done | missed
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS plan_tasks_user_date ON plan_tasks(user_id, date);

-- Classes: students share exams (lectures already read by AI) with classmates via an invite code.
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS class_members (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (class_id, user_id)
);

CREATE TABLE IF NOT EXISTS shared_exams (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  shared_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(class_id, exam_id)
);

CREATE TABLE IF NOT EXISTS quiz_answers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  check_index INTEGER NOT NULL,                    -- position in the topic's section quiz (checks_json)
  chosen INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, topic_id, check_index)     -- a student's progress on a section quiz, across sessions and devices
);

-- Highlights and crossed-out options a student put on a question, so they follow her between devices.
-- key: "attempt:<attemptId>:<questionId>" (practice exams) or "quiz:<quiz question id>" (section quizzes). json: lib/marks.ts Marks.
CREATE TABLE IF NOT EXISTS question_marks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- Every AI call, for the per-user spending tracker.
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ok INTEGER NOT NULL DEFAULT 1,                   -- 0 when the call failed
  error TEXT,                                      -- one short line on why it failed (never key text)
  ref TEXT                                         -- what it was for: topic:<id> | attempt:<id> | doc:<id>
);

-- "Quiz me" (lib/quizMe.ts): questions on what she highlighted, or a review of a whole lecture.
CREATE TABLE IF NOT EXISTS quizme (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  topic_id INTEGER,                                -- the section she was studying, when known (not a foreign key: maps get rebuilt)
  text TEXT NOT NULL,                              -- what she highlighted
  size INTEGER NOT NULL,                           -- 3, 5 or 10 asked for (questions_json may hold fewer)
  questions_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,                      -- chosen option index per question, null until answered
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  kind TEXT NOT NULL DEFAULT 'highlight',          -- highlight | lecture
  document_id INTEGER                              -- the lecture, for a lecture review
);
CREATE INDEX IF NOT EXISTS quizme_open ON quizme(user_id, exam_id, finished_at);
-- Lecture reviews: a question she got right in one doesn't come back in the next (unless she misses it again later).
CREATE TABLE IF NOT EXISTS lecture_review_done (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,                               -- "quiz:<topic>:<index>" or "quizme:<id>:<index>"
  done_at TEXT NOT NULL DEFAULT (datetime('now')),
  stem TEXT,                                       -- normalised question text: the same question from another quiz is done too
  PRIMARY KEY (user_id, ref)
);

-- Problem reports and ideas sent from any page (lib/reports.ts), with optional screenshots.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'problem',            -- problem | idea
  message TEXT NOT NULL,
  page TEXT,                                       -- path of the page she was on
  meta_json TEXT,                                  -- viewport, theme, user agent
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT
);
CREATE TABLE IF NOT EXISTS report_images (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,                              -- 1-based position in the report
  path TEXT NOT NULL,                              -- relative to FILES_DIR
  UNIQUE(report_id, n)
);

-- Questions a student reported as wrong or unclear (lib/reportedQuestions.ts).
CREATE TABLE IF NOT EXISTS reported_questions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
  topic_id INTEGER,                                -- the section the question tests (not a foreign key: maps get rebuilt)
  source TEXT NOT NULL,                            -- quiz | practice | review | quizme | lecture_review
  ref TEXT NOT NULL,                               -- where it came from: "quiz:<topic>:<question id>", "question:<id>", "quizme:<id>:<index>"
  question_json TEXT NOT NULL,                     -- the question as the student saw it (see ReportedQuestion)
  reason TEXT,                                     -- the optional one-liner from the report dialog
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS reported_questions_topic ON reported_questions(topic_id);

-- Lookups every page makes (by exam, by section, by question, a student's spending).
CREATE INDEX IF NOT EXISTS questions_exam ON questions(exam_id);
CREATE INDEX IF NOT EXISTS questions_topic ON questions(topic_id);
CREATE INDEX IF NOT EXISTS questions_topic_fact ON questions(topic_id, fact_key);
CREATE INDEX IF NOT EXISTS attempt_questions_question ON attempt_questions(question_id);
CREATE INDEX IF NOT EXISTS topics_exam ON topics(exam_id);
CREATE INDEX IF NOT EXISTS documents_exam ON documents(exam_id);
CREATE INDEX IF NOT EXISTS ai_usage_user_created ON ai_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS attempts_exam ON attempts(exam_id);
`;

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/**
 * Add a column unless the table already has it. Two processes can open the same database at once (next build's
 * workers, or two app instances), so a column another one just added is not an error. A table that doesn't exist yet is
 * left alone: SCHEMA creates it whole.
 */
function addColumn(db: Database.Database, table: string, column: string, definition: string) {
  const have = columns(db, table);
  if (have.length === 0 || have.includes(column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column/i.test(String(err))) throw err;
  }
}

/** Upgrade databases created before user accounts existed. Old rows get user_id NULL and are claimed by the first account. */
function migrate(db: Database.Database) {
  addColumn(db, "exams", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE");
  addColumn(db, "documents", "batch_id", "TEXT");
  if (!columns(db, "questions").includes("case_id")) {
    db.exec(`CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE, scenario TEXT NOT NULL,
      patient_box TEXT NOT NULL, image_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  }
  addColumn(db, "questions", "case_id", "INTEGER REFERENCES cases(id) ON DELETE CASCADE");
  addColumn(db, "questions", "root_question_id", "INTEGER");
  addColumn(db, "exams", "source_exam_id", "INTEGER");
  addColumn(db, "attempts", "task_id", "INTEGER");
  addColumn(db, "attempt_questions", "reported", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "exams", "kind", "TEXT NOT NULL DEFAULT 'block'");
  addColumn(db, "documents", "backed_up", "INTEGER NOT NULL DEFAULT 0");
  if (!columns(db, "users").includes("is_admin")) {
    addColumn(db, "users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)");
  }
  if (!columns(db, "concepts").includes("user_id")) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE concepts_new (
        id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL COLLATE NOCASE,
        attempts INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, last_seen TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, name));
      INSERT INTO concepts_new (id, name, attempts, correct, last_seen, created_at) SELECT id, name, attempts, correct, last_seen, created_at FROM concepts;
      DROP TABLE concepts;
      ALTER TABLE concepts_new RENAME TO concepts;`);
    db.pragma("foreign_keys = ON");
  }
  addColumn(db, "users", "focus_weak", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "users", "theme", "TEXT NOT NULL DEFAULT 'classic'");
  addColumn(db, "users", "session_epoch", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "questions", "option_notes", "TEXT");
  addColumn(db, "attempts", "adaptive", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "attempts", "plan_json", "TEXT");
  addColumn(db, "attempt_questions", "confidence", "TEXT");
  addColumn(db, "attempt_questions", "option_order", "TEXT");
  addColumn(db, "topics", "checks_json", "TEXT");
  addColumn(db, "topics", "checks_version", "INTEGER");
  addColumn(db, "topics", "document_id", "INTEGER REFERENCES documents(id) ON DELETE CASCADE");
  addColumn(db, "session_checks", "check_index", "INTEGER");
  addColumn(db, "session_checks", "chosen", "INTEGER");
  addColumn(db, "busy_days", "weekdays", "INTEGER");
  addColumn(db, "planner_settings", "missed_seen_through", "TEXT");
  if (!columns(db, "glossary").includes("user_id")) {
    db.exec(`
      CREATE TABLE glossary_new (user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, abbr TEXT NOT NULL COLLATE NOCASE, meaning TEXT NOT NULL, UNIQUE(user_id, abbr));
      INSERT INTO glossary_new (abbr, meaning) SELECT abbr, meaning FROM glossary;
      DROP TABLE glossary;
      ALTER TABLE glossary_new RENAME TO glossary;`);
  }
  // Tables that lib/quizMe.ts used to create (and extend) on import.
  addColumn(db, "lecture_review_done", "stem", "TEXT");
  addColumn(db, "quizme", "kind", "TEXT NOT NULL DEFAULT 'highlight'");
  addColumn(db, "quizme", "document_id", "INTEGER");
  addColumn(db, "pages", "is_filler", "INTEGER");
  addColumn(db, "documents", "batch_at", "TEXT");
  // Practice exams written to a plan (docs/EXAM-PLAN.md) and AI activity.
  addColumn(db, "questions", "fact_key", "TEXT");
  addColumn(db, "attempts", "requested", "INTEGER");
  addColumn(db, "attempts", "slots_json", "TEXT");
  addColumn(db, "attempts", "short_reason", "TEXT");
  addColumn(db, "attempts", "resumed_at", "TEXT");
  addColumn(db, "attempts", "options_json", "TEXT");
  addColumn(db, "ai_usage", "ok", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "ai_usage", "error", "TEXT");
  addColumn(db, "ai_usage", "ref", "TEXT");
}

/** SQL for "this slide is a title / agenda / thank-you slide" on the pages row `alias`: 1 or 0, NULL when it has no readable notes. */
export const pageIsFillerSql = (alias = "p") =>
  `COALESCE(${alias}.is_filler, CASE WHEN json_valid(${alias}.notes_json) THEN CASE WHEN json_type(${alias}.notes_json) = 'object' THEN COALESCE(json_extract(${alias}.notes_json, '$.is_filler'), 0) != 0 END END)`;

/**
 * Fill `pages.is_filler` from the notes for slides read before the column existed (or copied without it). Slides
 * without notes, or with damaged notes, stay NULL. One UPDATE in a transaction; only rows still NULL are looked at.
 */
export function backfillFiller(d: Database.Database = db): number {
  return d.transaction(
    () => d.prepare(`UPDATE pages SET is_filler = ${pageIsFillerSql("pages")} WHERE is_filler IS NULL AND notes_json IS NOT NULL AND ${pageIsFillerSql("pages")} IS NOT NULL`).run().changes,
  )();
}

/**
 * An exam's read slides that have notes, each with whether it is a title / agenda / thank-you slide, for counting
 * "slides not in a section yet" without parsing every slide's notes.
 */
export function examSlideKinds(examId: number): { id: number; is_filler: 0 | 1 }[] {
  return db
    .prepare(
      `SELECT p.id, ${pageIsFillerSql("p")} AS is_filler FROM pages p JOIN documents d ON d.id = p.document_id
       WHERE d.exam_id = ? AND p.status = 'done' AND ${pageIsFillerSql("p")} IS NOT NULL`,
    )
    .all(examId) as { id: number; is_filler: 0 | 1 }[];
}

declare global {
  var __db: Database.Database | undefined;
}

function open(): Database.Database {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "study.db"));
  // Build workers and a background job can write at the same moment: wait for the lock instead of failing at once.
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Old databases: add the new columns before running SCHEMA (its indexes may reference them).
  const hasExams = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'exams'").get();
  if (hasExams) {
    db.exec(SCHEMA.slice(0, SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS exams"))); // users table first
    migrate(db);
  }
  db.exec(SCHEMA);
  // One-time switch to the Color blocks redesign: everyone moves to it once; they can still pick another theme in Settings.
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'theme_default_blocks'").get()) {
    db.prepare("UPDATE users SET theme = 'blocks'").run();
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('theme_default_blocks', '1')").run();
  }
  backfillFiller(db);
  return db;
}

// Reuse one connection across hot reloads in dev.
export const db: Database.Database = globalThis.__db ?? (globalThis.__db = open());

export type User = {
  id: number;
  email: string;
  password_hash: string;
  provider: "anthropic" | "openai" | null;
  api_key_enc: string | null;
  api_key_last4: string | null;
  is_admin: number;
  must_change_password: number;
  focus_weak: number;
  theme: string;
  session_epoch: number;
  created_at: string;
};

export function getMeta(key: string): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}

export function setMeta(key: string, value: string) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export type ExamKind = "block" | "quiz" | "practical" | "board" | "other";

export type Exam = {
  id: number;
  user_id: number;
  name: string;
  course: string | null;
  exam_date: string | null;
  kind: ExamKind;
  status: "active" | "archived";
  topic_status: "none" | "building" | "ready" | "error";
  topic_error: string | null;
  created_at: string;
};

export type DocumentRow = {
  id: number;
  exam_id: number;
  filename: string;
  page_count: number;
  status: "pending" | "processing" | "done" | "error";
  error: string | null;
};

export type PageRow = {
  id: number;
  document_id: number;
  page_number: number;
  text: string;
  image_path: string;
  aspect: number;
  status: "pending" | "done" | "error";
  title: string | null;
  notes_json: string | null;
  emphasized: number;
  has_case: number;
  /** 1 for a title / agenda / thank-you slide, 0 otherwise; null until the slide has notes. */
  is_filler?: number | null;
};

export type Topic = {
  id: number;
  exam_id: number;
  position: number;
  title: string;
  summary: string;
  page_ids: string;
  emphasized: number;
  lesson_json: string | null;
  checks_json: string | null;
  checks_version: number | null;
  /** The lecture (documents.id) this section belongs to; null for old-style topics mapped across lectures. */
  document_id: number | null;
};

/**
 * Throw away a topic's section quiz so it's written again. Answers already given stay (summaries, mastery, history)
 * but are detached from the old question positions, so they never show against a different question.
 */
export function resetSectionQuiz(topicId: number) {
  db.prepare("UPDATE topics SET checks_json = NULL, checks_version = NULL WHERE id = ?").run(topicId);
  db.prepare("UPDATE session_checks SET check_index = NULL WHERE topic_id = ?").run(topicId);
  // Per-student progress on the old questions goes too (it would point at different questions otherwise).
  db.prepare("DELETE FROM quiz_answers WHERE topic_id = ?").run(topicId);
}

export type Question = {
  id: number;
  exam_id: number;
  topic_id: number | null;
  concept_id: number | null;
  type: "recall" | "case" | "image";
  patient_box: string | null;
  case_id: number | null;
  root_question_id: number | null;
  stem: string;
  options: string;
  option_notes: string | null;
  correct_index: number;
  explanation: string;
  source_page_id: number | null;
  image_page_id: number | null;
  flagged: number;
};

/** An exam, only if it belongs to this user. */
export function getExam(id: number, userId: number): Exam | undefined {
  return db.prepare("SELECT * FROM exams WHERE id = ? AND user_id = ?").get(id, userId) as Exam | undefined;
}

/** Owner of an exam (for background jobs that run without a request). */
export function examOwner(examId: number): number {
  return (db.prepare("SELECT user_id FROM exams WHERE id = ?").get(examId) as { user_id: number }).user_id;
}
