// Rows for the browser tests, written straight into the test server's database (DATA_DIR is the run's throwaway folder,
// set in playwright.config.ts before anything here is imported). Every test seeds its own student and exam, so tests
// never share state and can run in any order. Only the slides are seeded already read, with their sections; lessons,
// quizzes and practice exams are written by the fake AI (AI_FAKE=1) through the real pages.
//
// Shapes copied from tests/helpers.ts (slideNotes) on purpose: importing tests/ here would drag Vitest in.
import fs from "fs";
import path from "path";
import { db, FILES_DIR } from "@/lib/db";
import { encryptSecret, gateToken, sessionToken, GATE_COOKIE, SESSION_COOKIE } from "@/lib/auth";

export const BASE_URL = `http://localhost:${process.env.E2E_PORT ?? 3210}`;

/** A small valid JPEG (64×48, light grey), written once per slide so /api/pages/[id]/image has a real picture to send. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAAwAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGpAAAAAAAAAAAAAAAAAAAAAAAB/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQABBQJD/8QAFBEBAAAAAAAAAAAAAAAAAAAAUP/aAAgBAwEBPwFD/8QAFBEBAAAAAAAAAAAAAAAAAAAAUP/aAAgBAgEBPwFD/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQAGPwJD/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQABPyFD/9oADAMBAAIAAwAAABAAAAAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAABQ/9oACAEDAQE/EEP/xAAUEQEAAAAAAAAAAAAAAAAAAABQ/9oACAECAQE/EEP/xAAUEAEAAAAAAAAAAAAAAAAAAABQ/9oACAEBAAE/EEP/2Q==",
  "base64",
);

/** A key that decrypts with the test SECRET_KEY. The fake AI never sends it anywhere. */
const FAKE_KEY = "sk-e2e-fake-key-0000000000000000";

type Slide = { title: string; facts: string[]; concept: string; starred?: string; case?: { prompt: string; answer: string } };
type Lecture = { file: string; sections: { title: string; summary: string; slides: Slide[] }[] };

/** Two lectures of an endodontics block, 13 slides, four sections; one slide starred, one with a case. */
export const LECTURES: Lecture[] = [
  {
    file: "Pulp and Periapical Diagnosis.pdf",
    sections: [
      {
        title: "Pulpal diagnosis",
        summary: "Telling a healthy pulp from reversible and irreversible pulpitis and necrosis",
        slides: [
          {
            title: "Normal pulp",
            concept: "Pulpal diagnosis",
            facts: ["A normal pulp responds to cold with mild pain that fades within one to two seconds", "A normal pulp gives no spontaneous pain"],
          },
          {
            title: "Reversible pulpitis",
            concept: "Pulpal diagnosis",
            facts: ["Reversible pulpitis gives sharp pain to cold that stops when the stimulus is removed", "Caries and recent restorations are the usual causes of reversible pulpitis"],
          },
          {
            title: "Symptomatic irreversible pulpitis",
            concept: "Irreversible pulpitis",
            starred: "Know how lingering cold pain separates irreversible from reversible pulpitis",
            facts: [
              "Pain to cold that lingers for more than thirty seconds means irreversible pulpitis",
              "Spontaneous or referred pain is typical of irreversible pulpitis",
              "Irreversible pulpitis is treated by pulpectomy or extraction",
            ],
          },
          {
            title: "Pulp necrosis",
            concept: "Pulp necrosis",
            facts: ["A necrotic pulp does not respond to cold or to electric pulp testing", "Pulp necrosis is usually painless until periapical disease develops"],
          },
        ],
      },
      {
        title: "Periapical diagnosis",
        summary: "Sensibility tests, apical periodontitis and abscesses",
        slides: [
          {
            title: "Pulp sensibility tests",
            concept: "Sensibility testing",
            facts: ["Refrigerant spray at minus fifty degrees is the most reliable cold test", "Electric pulp testing checks the nerve response, not the blood supply"],
          },
          {
            title: "Apical periodontitis",
            concept: "Apical periodontitis",
            case: { prompt: "A 42-year-old has pain on biting on tooth 36; cold test negative, percussion positive. What is the periapical diagnosis?", answer: "Symptomatic apical periodontitis" },
            facts: ["Symptomatic apical periodontitis hurts on biting and on percussion", "Asymptomatic apical periodontitis shows a periapical radiolucency without symptoms"],
          },
          {
            title: "Apical abscess",
            concept: "Apical abscess",
            facts: ["An acute apical abscess causes rapid swelling and severe pain", "A chronic apical abscess drains through a sinus tract"],
          },
        ],
      },
    ],
  },
  {
    file: "Root Canal Treatment.pdf",
    sections: [
      {
        title: "Cleaning and shaping",
        summary: "Access, working length and irrigation",
        slides: [
          {
            title: "Access cavity",
            concept: "Access cavity",
            facts: ["The access cavity must give straight-line access to every canal orifice", "The whole roof of the pulp chamber is removed during access"],
          },
          {
            title: "Working length",
            concept: "Working length",
            facts: ["Working length ends half a millimetre to one millimetre short of the radiographic apex", "Electronic apex locators measure the working length"],
          },
          {
            title: "Irrigation",
            concept: "Irrigation",
            facts: ["Sodium hypochlorite dissolves organic pulp tissue", "Seventeen percent EDTA removes the smear layer"],
          },
        ],
      },
      {
        title: "Obturation and follow-up",
        summary: "Filling the canal, sealing the crown and checking healing",
        slides: [
          {
            title: "Obturation",
            concept: "Obturation",
            facts: ["Gutta-percha with a sealer fills the canal in three dimensions", "Lateral and warm vertical condensation are the common filling techniques"],
          },
          {
            title: "Coronal seal",
            concept: "Coronal seal",
            facts: ["A good coronal restoration matters as much as the root filling", "Leakage through the crown is a major cause of root canal failure"],
          },
          {
            title: "Follow-up",
            concept: "Healing",
            facts: ["Healing is reviewed on a radiograph after one year", "A shrinking periapical radiolucency means the lesion is healing"],
          },
        ],
      },
    ],
  },
];

/** One slide's notes as the slide reader stores them (pages.notes_json), as tests/helpers.ts slideNotes writes them. */
function notesJson(s: Slide): string {
  return JSON.stringify({
    title: s.title,
    summary: `${s.title}: ${s.facts[0]}.`,
    image_description: null,
    key_facts: s.facts,
    annotations: [],
    emphasized: !!s.starred,
    emphasis_note: s.starred ?? null,
    case_prompt: s.case?.prompt ?? null,
    case_answer: s.case?.answer ?? null,
    case_image_box: null,
    abbreviations: [],
    concepts: [s.concept],
    is_filler: false,
  });
}

let n = 0;
/** A student (or the site owner) who can use the site: an AI key on file (ChatGPT, so slides would be read directly). */
export function seedUser(opts: { admin?: boolean; label?: string } = {}): number {
  n++;
  const email = `${opts.label ?? "student"}-${process.pid}-${Date.now()}-${n}@e2e.test`;
  const id = Number(
    db
      .prepare("INSERT INTO users (email, password_hash, provider, api_key_enc, api_key_last4, is_admin, must_change_password) VALUES (?, 'x', 'openai', ?, '0000', ?, 0)")
      .run(email, encryptSecret(FAKE_KEY), opts.admin ? 1 : 0).lastInsertRowid,
  );
  db.prepare("INSERT OR IGNORE INTO planner_settings (user_id) VALUES (?)").run(id);
  return id;
}

/** The cookies a signed-in visitor has: the passcode gate and the session, made with the server's own functions. */
export function cookiesFor(userId: number | null, opts: { gate?: boolean } = {}) {
  const url = BASE_URL;
  const out: { name: string; value: string; url: string }[] = [];
  if (opts.gate !== false) out.push({ name: GATE_COOKIE, value: gateToken(), url });
  if (userId != null) out.push({ name: SESSION_COOKIE, value: sessionToken(userId, 0), url });
  return out;
}

export type SeededExam = {
  userId: number;
  examId: number;
  docIds: number[];
  /** Section ids in study order. */
  topicIds: number[];
  /** Slide ids per section. */
  pageIds: number[][];
  /** The seeded content, section by section (same order as topicIds). */
  sections: Lecture["sections"];
};

/** An exam with both lectures read and split into sections (no lessons, quizzes or practice exams yet). */
export function seedExam(opts: { userId?: number; name?: string } = {}): SeededExam {
  const userId = opts.userId ?? seedUser();
  const date = new Date(Date.now() + 21 * 86400_000).toISOString().slice(0, 10);
  const examId = Number(
    db
      .prepare("INSERT INTO exams (user_id, name, course, exam_date, topic_status) VALUES (?, ?, 'Endodontics', ?, 'ready')")
      .run(userId, opts.name ?? "Endodontics block", date).lastInsertRowid,
  );
  const docIds: number[] = [];
  const topicIds: number[] = [];
  const pageIds: number[][] = [];
  const insertPage = db.prepare(
    "INSERT INTO pages (document_id, page_number, text, image_path, aspect, status, title, notes_json, emphasized, has_case, is_filler) VALUES (?, ?, ?, ?, 1.333, 'done', ?, ?, ?, ?, 0)",
  );
  const insertFts = db.prepare("INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)");
  const insertTopic = db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, emphasized, document_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const concept = db.prepare("INSERT OR IGNORE INTO concepts (user_id, name) VALUES (?, ?)");
  const conceptId = db.prepare("SELECT id FROM concepts WHERE user_id = ? AND name = ?");
  const link = db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");
  db.transaction(() => {
    let position = 0;
    for (const lecture of LECTURES) {
      const slides = lecture.sections.flatMap((s) => s.slides);
      const doc = Number(
        db.prepare("INSERT INTO documents (exam_id, filename, page_count, status) VALUES (?, ?, ?, 'done')").run(examId, lecture.file, slides.length).lastInsertRowid,
      );
      docIds.push(doc);
      fs.mkdirSync(path.join(FILES_DIR, `doc-${doc}`), { recursive: true });
      let pageNo = 0;
      for (const section of lecture.sections) {
        const ids = section.slides.map((s) => {
          pageNo++;
          const rel = path.join(`doc-${doc}`, `p${pageNo}.jpg`);
          fs.writeFileSync(path.join(FILES_DIR, rel), JPEG);
          const text = [s.title, ...s.facts].join("\n");
          const id = Number(insertPage.run(doc, pageNo, text, rel, s.title, notesJson(s), s.starred ? 1 : 0, s.case ? 1 : 0).lastInsertRowid);
          insertFts.run(id, s.title, [`${s.title}.`, ...s.facts, s.case?.prompt, s.case?.answer].filter(Boolean).join("\n"));
          return id;
        });
        pageIds.push(ids);
        const topic = Number(
          insertTopic.run(examId, position++, section.title, section.summary, JSON.stringify(ids), section.slides.some((s) => s.starred) ? 1 : 0, doc).lastInsertRowid,
        );
        topicIds.push(topic);
        for (const name of new Set(section.slides.map((s) => s.concept))) {
          concept.run(userId, name);
          link.run(topic, (conceptId.get(userId, name) as { id: number }).id);
        }
      }
    }
  })();
  return { userId, examId, docIds, topicIds, pageIds, sections: LECTURES.flatMap((l) => l.sections) };
}

/** Whether the section counts as studied (topic_study), as the exam page and planner read it. */
export const isStudied = (userId: number, topicId: number) => !!db.prepare("SELECT 1 FROM topic_study WHERE user_id = ? AND topic_id = ?").get(userId, topicId);

export { db };
