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
  theme TEXT NOT NULL DEFAULT 'classic',           -- colour theme, see lib/themes.ts
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  checks_json TEXT                                 -- 10-question section quiz shown after the lesson
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,                              -- tutor | timed
  task_id INTEGER,                                 -- plan task this attempt was started from
  adaptive INTEGER NOT NULL DEFAULT 1,             -- built with "focus on weak spots" on
  status TEXT NOT NULL DEFAULT 'generating',       -- generating | ready | finished | error
  error TEXT,
  time_limit_sec INTEGER,
  score REAL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS attempt_questions (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  chosen_index INTEGER,                            -- index into questions.options (not the shuffled display order)
  correct INTEGER,
  confidence TEXT,                                 -- guess | unsure | sure, given before the answer is revealed
  option_order TEXT,                               -- JSON display order of options, for questions retried from an earlier exam
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
CREATE TABLE IF NOT EXISTS busy_days (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'Busy'
);

-- Study planner settings, one row per user.
CREATE TABLE IF NOT EXISTS planner_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weekday_minutes TEXT NOT NULL DEFAULT '[120,120,120,120,120,120,180]', -- Mon..Sun
  review_minutes INTEGER NOT NULL DEFAULT 15,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  ics_token TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',             -- JSON: exams the plan couldn't fully fit
  rebuilt_on TEXT
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** Upgrade databases created before user accounts existed. Old rows get user_id NULL and are claimed by the first account. */
function migrate(db: Database.Database) {
  if (!columns(db, "exams").includes("user_id")) db.exec("ALTER TABLE exams ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
  if (!columns(db, "documents").includes("batch_id")) db.exec("ALTER TABLE documents ADD COLUMN batch_id TEXT");
  if (!columns(db, "questions").includes("case_id")) {
    db.exec(`CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE, scenario TEXT NOT NULL,
      patient_box TEXT NOT NULL, image_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.exec("ALTER TABLE questions ADD COLUMN case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE");
    db.exec("ALTER TABLE questions ADD COLUMN root_question_id INTEGER");
  }
  if (!columns(db, "exams").includes("source_exam_id")) db.exec("ALTER TABLE exams ADD COLUMN source_exam_id INTEGER");
  if (!columns(db, "attempts").includes("task_id")) db.exec("ALTER TABLE attempts ADD COLUMN task_id INTEGER");
  if (!columns(db, "exams").includes("kind")) db.exec("ALTER TABLE exams ADD COLUMN kind TEXT NOT NULL DEFAULT 'block'");
  if (!columns(db, "documents").includes("backed_up")) db.exec("ALTER TABLE documents ADD COLUMN backed_up INTEGER NOT NULL DEFAULT 0");
  if (!columns(db, "users").includes("is_admin")) {
    db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
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
  if (!columns(db, "users").includes("focus_weak")) db.exec("ALTER TABLE users ADD COLUMN focus_weak INTEGER NOT NULL DEFAULT 1");
  if (!columns(db, "users").includes("theme")) db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'classic'");
  if (!columns(db, "attempts").includes("adaptive")) db.exec("ALTER TABLE attempts ADD COLUMN adaptive INTEGER NOT NULL DEFAULT 1");
  if (!columns(db, "attempt_questions").includes("confidence")) {
    db.exec("ALTER TABLE attempt_questions ADD COLUMN confidence TEXT");
    db.exec("ALTER TABLE attempt_questions ADD COLUMN option_order TEXT");
  }
  if (!columns(db, "topics").includes("checks_json")) db.exec("ALTER TABLE topics ADD COLUMN checks_json TEXT");
  if (!columns(db, "session_checks").includes("check_index")) {
    db.exec("ALTER TABLE session_checks ADD COLUMN check_index INTEGER");
    db.exec("ALTER TABLE session_checks ADD COLUMN chosen INTEGER");
  }
  if (!columns(db, "glossary").includes("user_id")) {
    db.exec(`
      CREATE TABLE glossary_new (user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, abbr TEXT NOT NULL COLLATE NOCASE, meaning TEXT NOT NULL, UNIQUE(user_id, abbr));
      INSERT INTO glossary_new (abbr, meaning) SELECT abbr, meaning FROM glossary;
      DROP TABLE glossary;
      ALTER TABLE glossary_new RENAME TO glossary;`);
  }
}

declare global {
  var __db: Database.Database | undefined;
}

function open(): Database.Database {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "study.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Old databases: add the new columns before running SCHEMA (its indexes may reference them).
  const hasExams = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'exams'").get();
  if (hasExams) {
    db.exec(SCHEMA.slice(0, SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS exams"))); // users table first
    migrate(db);
  }
  db.exec(SCHEMA);
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
};

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
