import { z } from "zod";
import { db, examOwner, getMeta, resetSectionQuiz, setMeta, type PageRow } from "./db";
import { credentials } from "./credentials";
import { rebuildPlan } from "./planner";
import { generate, mapLimit } from "./ai";
import { parseNotes } from "./processing";
import { upsertConcept } from "./memory";
import { cleanTopics, matchTopics, sameSlides, type SlideRef } from "./topicMerge";

const TopicFields = {
  title: z.string().describe("Short, specific name for what this section teaches"),
  summary: z.string().describe("2-3 sentences: what this section covers and why it matters clinically"),
  page_ids: z.array(z.number()).describe("IDs of the slides (the P numbers) that belong to this section, in slide order"),
  emphasized: z.boolean().describe("True if the professor/student flagged slides in this section as important"),
  concepts: z.array(z.string()).describe("3-8 canonical concept names covered by this section"),
};

const TopicMap = z.object({ topics: z.array(z.object(TopicFields)).describe("The lecture's sections, in slide order") });

// One lecture at a time: sections follow the lecture's own structure and never mix lectures.
const SYSTEM = `You split ONE lecture of a dental student's slides into study sections. The student studies the exam lecture by lecture, section by section.
Rules:
- Split this lecture into sections that follow the lecture's own structure (its headings/agenda). Typically 3-10 slides per section; a short lecture may be one section.
- Sections stay in slide order: list them in the order the lecture teaches them, each one a run of neighbouring slides.
- Every slide ID listed must appear in exactly one section. Skip none, and use only the IDs listed.
- Concepts are short canonical names (e.g. "Symptomatic irreversible pulpitis", "Cvek pulpotomy", "Inferior alveolar nerve block").
  The student already has a concept list from earlier exams. When a concept means the same thing as an existing one, reuse the existing name exactly.`;

/** How many lectures are mapped at the same time. */
const LECTURE_CONCURRENCY = 3;

type PageForMap = PageRow & { filename: string };
type Mode = "auto" | "full";
type Lecture = { docId: number; filename: string; slides: PageForMap[] };
type Section = { title: string; summary: string; page_ids: number[]; emphasized: boolean; concepts: string[]; document_id: number };

const inflight = new Map<number, { p: Promise<void>; mode: Mode }>();
/** One automatic run waiting behind an in-flight run, per exam (see buildTopicMap). */
const queuedAuto = new Map<number, Promise<void>>();

/**
 * Build or update an exam's topic map: one map per lecture, sections inside it. Concurrent calls for the same exam
 * share one run.
 * - "auto" (after lectures finish processing): lectures that are already mapped stay untouched; each new lecture is
 *   split into sections and appended at the end. With no map yet, every lecture is mapped.
 * - "full" (the Rebuild button, and the one-time upgrade to lecture maps): every lecture is mapped again, but sections
 *   whose slides mostly match an old topic keep that topic (and its lesson, quiz, answers and study progress).
 * Study order is lectures in upload order, sections in slide order; `topics.position` is that flat order.
 */
export function buildTopicMap(examId: number, mode: Mode = "auto"): Promise<void> {
  const running = inflight.get(examId);
  if (running) {
    // A Rebuild asked while a Rebuild runs shares it.
    if (mode === "full" && running.mode === "full") return running.p;
    if (mode === "auto") {
      // A lecture that finished while a run is in flight isn't in that run's snapshot of the slides, so one automatic
      // run is queued behind it (shared by every automatic request that arrives meanwhile; it costs nothing when
      // nothing new is left to map).
      let q = queuedAuto.get(examId);
      if (!q) {
        q = running.p
          .catch(() => {})
          .then(() => {
            queuedAuto.delete(examId);
            return buildTopicMap(examId, "auto");
          });
        queuedAuto.set(examId, q);
      }
      return q;
    }
    // A Rebuild asked during an automatic run runs right after it.
  }
  const p: Promise<void> = (running ? running.p.catch(() => {}) : Promise.resolve())
    .then(() => runTopicMap(examId, mode))
    .finally(() => {
      if (inflight.get(examId)?.p === p) inflight.delete(examId);
    });
  inflight.set(examId, { p, mode });
  return p;
}

type Existing = { id: number; position: number; title: string; summary: string; page_ids: string; emphasized: number; document_id: number | null };

async function runTopicMap(examId: number, mode: Mode) {
  db.prepare("UPDATE exams SET topic_status = 'building', topic_error = NULL WHERE id = ?").run(examId);
  try {
    const pages = db
      .prepare(
        `SELECT p.*, d.filename FROM pages p JOIN documents d ON d.id = p.document_id
         WHERE d.exam_id = ? AND p.status = 'done' AND d.status IN ('done', 'error') ORDER BY d.id, p.page_number`,
      )
      .all(examId) as PageForMap[];
    // (A lecture still being read is left out whole: mapping its first slides now would dump the rest into one
    // section later. It gets its own automatic run when it finishes.)
    if (pages.length === 0) throw new Error("No lecture has finished reading yet.");
    // Title, agenda and reference slides stay out of the study plan; everything else must land in a section.
    const content = pages.filter((p) => {
      const n = parseNotes(p);
      return n && !n.is_filler;
    });
    const existing = db
      .prepare("SELECT id, position, title, summary, page_ids, emphasized, document_id FROM topics WHERE exam_id = ? ORDER BY position")
      .all(examId) as Existing[];
    const userId = examOwner(examId);

    if (mode === "auto" && existing.length > 0) await addLectures(examId, userId, existing, lecturesOf(content));
    else await fullMap(examId, userId, existing, content);
    db.prepare("UPDATE exams SET topic_status = 'ready' WHERE id = ?").run(examId);
    rebuildPlan(userId); // new sections → new study tasks
  } catch (err) {
    db.prepare("UPDATE exams SET topic_status = 'error', topic_error = ? WHERE id = ?").run(String(err), examId);
  }
}

/** Content slides grouped by lecture, lectures in upload order (pages arrive ordered by document, then slide). */
function lecturesOf(content: PageForMap[]): Lecture[] {
  const out: Lecture[] = [];
  for (const p of content) {
    const last = out.at(-1);
    if (last?.docId === p.document_id) last.slides.push(p);
    else out.push({ docId: p.document_id, filename: p.filename, slides: [p] });
  }
  return out;
}

function slideLines(pages: PageForMap[]): string {
  return pages
    .map((p) => {
      const n = parseNotes(p)!;
      return (
        `[P${p.id}] slide ${p.page_number}: ${n.title}${n.emphasized ? " ★IMPORTANT" : ""} — ${n.summary}` +
        (n.case_prompt ? ` | case: ${n.case_prompt}` : "") +
        ` | concepts: ${n.concepts.join("; ")}`
      );
    })
    .join("\n");
}

const refs = (pages: PageForMap[]): SlideRef[] => pages.map((p) => ({ id: p.id, doc: p.document_id, n: p.page_number }));
const existingConcepts = (userId: number) =>
  (db.prepare("SELECT name FROM concepts WHERE user_id = ? ORDER BY name").all(userId) as { name: string }[]).map((c) => c.name);

/**
 * One AI call for one lecture, with only that lecture's slides. Ids outside the lecture are dropped and every slide
 * of it lands in exactly one section (`cleanTopics`); sections come back in slide order with their slides in order.
 * Returns [] when the AI placed nothing usable.
 */
async function mapLecture(userId: number, lecture: Lecture, concepts: string[]): Promise<Section[]> {
  const out = await generate({
    creds: credentials(userId),
    purpose: "topic map",
    schema: TopicMap,
    system: SYSTEM,
    effort: "medium",
    maxTokens: 32000,
    content:
      `Existing concepts from earlier exams (${concepts.length}):\n${concepts.join("\n") || "(none yet)"}\n\n` +
      `Lecture: ${lecture.filename}\nSlides of this lecture (IDs in brackets):\n${slideLines(lecture.slides)}`,
  });
  return inSlideOrder(cleanTopics(out.topics, refs(lecture.slides)), lecture);
}

/** Sort a lecture's sections (and the slides inside each) by slide number, and tag them with the lecture. */
function inSlideOrder(drafts: Omit<Section, "document_id">[], lecture: Lecture): Section[] {
  const n = new Map(lecture.slides.map((p) => [p.id, p.page_number]));
  const at = (id: number) => n.get(id) ?? Number.MAX_SAFE_INTEGER;
  return drafts
    .map((d) => ({ ...d, page_ids: [...d.page_ids].sort((a, b) => at(a) - at(b)), document_id: lecture.docId }))
    .sort((a, b) => at(a.page_ids[0]) - at(b.page_ids[0]));
}

/** The AI placed nothing usable for a new lecture: one section for the whole lecture, so no slide is lost. */
const wholeLecture = (lecture: Lecture): Section => ({
  title: lecture.filename.replace(/\.pdf$/i, ""),
  summary: `Slides from ${lecture.filename}.`,
  page_ids: lecture.slides.map((p) => p.id),
  emphasized: lecture.slides.some((p) => p.emphasized),
  concepts: [],
  document_id: lecture.docId,
});

/** Map several lectures, LECTURE_CONCURRENCY at a time; results keep the lectures' order. */
async function mapLectures(userId: number, lectures: Lecture[]): Promise<Section[][]> {
  const concepts = existingConcepts(userId);
  const results: Section[][] = lectures.map(() => []);
  // Once one lecture fails the whole build fails, so the lectures still waiting are not sent to the AI (and paid for).
  const failure: { seen: boolean; err: unknown } = { seen: false, err: undefined };
  await mapLimit(
    lectures.map((l, i) => ({ l, i })),
    LECTURE_CONCURRENCY,
    async ({ l, i }) => {
      if (failure.seen) return;
      try {
        results[i] = await mapLecture(userId, l, concepts);
      } catch (err) {
        if (!failure.seen) Object.assign(failure, { seen: true, err });
      }
    },
  );
  if (failure.seen) throw failure.err;
  return results;
}

/**
 * Renumber the exam's topics into study order: old-style topics (no lecture) first, as they were; then lectures in
 * upload order, sections in slide order inside each lecture.
 */
function renumber(examId: number) {
  const rows = db.prepare("SELECT id, position, page_ids, document_id FROM topics WHERE exam_id = ? ORDER BY position, id").all(examId) as {
    id: number;
    position: number;
    page_ids: string;
    document_id: number | null;
  }[];
  const slideNo = new Map(
    (db.prepare("SELECT p.id, p.page_number FROM pages p JOIN documents d ON d.id = p.document_id WHERE d.exam_id = ?").all(examId) as {
      id: number;
      page_number: number;
    }[]).map((p) => [p.id, p.page_number]),
  );
  const first = (r: (typeof rows)[number]) => Math.min(...(JSON.parse(r.page_ids) as number[]).map((p) => slideNo.get(p) ?? Number.MAX_SAFE_INTEGER));
  const keyed = rows.map((r, i) => ({ r, i, doc: r.document_id, first: first(r) }));
  keyed.sort((a, b) => {
    if (a.doc == null || b.doc == null) return a.doc == null && b.doc == null ? a.i - b.i : a.doc == null ? -1 : 1;
    return a.doc - b.doc || a.first - b.first || a.i - b.i;
  });
  const setPos = db.prepare("UPDATE topics SET position = ? WHERE id = ?");
  // Out of the way first, then 0..n-1, so no two topics ever share a position mid-way.
  for (const { r } of keyed) setPos.run(-1 - r.position - rows.length, r.id);
  keyed.forEach(({ r }, position) => setPos.run(position, r.id));
  db.prepare("UPDATE study_sessions SET current_position = MIN(current_position, ?) WHERE exam_id = ?").run(Math.max(0, rows.length - 1), examId);
}

/** Re-file practice questions without a topic (or whose topic is gone) under the section that now holds their source slide. */
function refileQuestions(examId: number) {
  const topics = db.prepare("SELECT id, page_ids FROM topics WHERE exam_id = ?").all(examId) as { id: number; page_ids: string }[];
  const set = db.prepare("UPDATE questions SET topic_id = ? WHERE exam_id = ? AND topic_id IS NULL AND source_page_id = ?");
  for (const t of topics) for (const p of JSON.parse(t.page_ids) as number[]) set.run(t.id, examId, p);
}

const insertTopic = () =>
  db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids, emphasized, document_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
const linkConcept = () => db.prepare("INSERT OR IGNORE INTO topic_concepts (topic_id, concept_id) VALUES (?, ?)");

/**
 * New lectures on an existing map. Lectures already mapped keep their sections untouched; each lecture with no slide
 * in the map yet is split into sections (one AI call each) and appended. A mapped lecture that gained a slide (e.g. a
 * retried slide that now reads) gets it in the section holding its nearest slide, with no AI call; that section's
 * lesson is rewritten to include it.
 */
async function addLectures(examId: number, userId: number, existing: Existing[], lectures: Lecture[]) {
  const assigned = new Map<number, number>(); // slide id -> topic id
  for (const t of existing) for (const p of JSON.parse(t.page_ids) as number[]) assigned.set(p, t.id);
  const fresh: Lecture[] = [];
  const extras: { slide: PageForMap; lecture: Lecture }[] = [];
  for (const l of lectures) {
    const left = l.slides.filter((p) => !assigned.has(p.id));
    if (left.length === 0) continue;
    if (left.length === l.slides.length) fresh.push(l);
    else for (const slide of left) extras.push({ slide, lecture: l });
  }
  if (fresh.length === 0 && extras.length === 0) return;

  const mapped = await mapLectures(userId, fresh);
  db.transaction(() => {
    const insert = insertTopic();
    const link = linkConcept();
    fresh.forEach((l, i) => {
      const sections = mapped[i].length ? mapped[i] : [wholeLecture(l)];
      for (const s of sections) {
        const id = Number(insert.run(examId, existing.length + 1000, s.title, s.summary, JSON.stringify(s.page_ids), s.emphasized ? 1 : 0, s.document_id).lastInsertRowid);
        for (const name of s.concepts) if (name.trim()) link.run(id, upsertConcept(userId, name));
      }
    });
    // Leftover slides of lectures already in the map: next to their nearest neighbour in the same lecture.
    const grown = new Map<number, number[]>();
    for (const { slide, lecture } of extras) {
      let best: { topic: number; dist: number } | null = null;
      for (const p of lecture.slides) {
        const topic = assigned.get(p.id);
        if (topic == null) continue;
        const dist = Math.abs(p.page_number - slide.page_number);
        if (!best || dist < best.dist) best = { topic, dist };
      }
      if (best) grown.set(best.topic, [...(grown.get(best.topic) ?? []), slide.id]);
    }
    const order = new Map(lectures.flatMap((l) => l.slides.map((p) => [p.id, p.page_number] as const)));
    for (const [topicId, add] of grown) {
      const t = existing.find((e) => e.id === topicId)!;
      const ids = [...(JSON.parse(t.page_ids) as number[]), ...add].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      db.prepare("UPDATE topics SET page_ids = ?, lesson_json = NULL WHERE id = ?").run(JSON.stringify(ids), topicId);
    }
    renumber(examId);
    refileQuestions(examId);
  })();
}

/** Map every lecture again, keeping each old topic that a new section mostly matches. */
async function fullMap(examId: number, userId: number, existing: Existing[], content: PageForMap[]) {
  if (content.length === 0) throw new Error("No slides with study content yet.");
  const lectures = lecturesOf(content);
  const mapped = await mapLectures(userId, lectures);
  const empty = lectures.filter((_, i) => mapped[i].length === 0);
  if (empty.length) throw new Error(`The topic map came back empty for ${empty.map((l) => l.filename).join(", ")}. Try Rebuild again.`);
  const topics = mapped.flat();
  const old = existing.map((t) => ({ ...t, pages: JSON.parse(t.page_ids) as number[] }));
  const matched = matchTopics(
    old.map((t) => ({ id: t.id, page_ids: t.pages })),
    topics,
  );

  db.transaction(() => {
    const keep = new Set(matched.values());
    // Topics that no longer exist: their questions are re-filed by source slide below; the rows go.
    for (const t of old) {
      if (keep.has(t.id)) continue;
      db.prepare("UPDATE questions SET topic_id = NULL WHERE topic_id = ?").run(t.id);
      db.prepare("DELETE FROM topics WHERE id = ?").run(t.id);
    }
    // Free up positions before renumbering.
    for (const id of keep) db.prepare("UPDATE topics SET position = -1 - position WHERE id = ?").run(id);
    const insert = insertTopic();
    const link = linkConcept();
    topics.forEach((t, position) => {
      const oldId = matched.get(position);
      let id: number;
      if (oldId != null) {
        const before = old.find((o) => o.id === oldId)!;
        id = oldId;
        if (sameSlides(before.pages, t.page_ids)) {
          // Unchanged: keep its name, lesson and quiz; only its place in the order (and its lecture) may change.
          db.prepare("UPDATE topics SET position = ?, emphasized = ?, page_ids = ?, document_id = ? WHERE id = ?").run(
            position,
            t.emphasized || before.emphasized ? 1 : 0,
            JSON.stringify(t.page_ids),
            t.document_id,
            id,
          );
        } else {
          // Same topic, slides changed: the lesson and quiz are rewritten from the new slides. Answers and progress stay.
          db.prepare("UPDATE topics SET position = ?, title = ?, summary = ?, page_ids = ?, emphasized = ?, document_id = ?, lesson_json = NULL WHERE id = ?").run(
            position,
            t.title,
            t.summary,
            JSON.stringify(t.page_ids),
            t.emphasized ? 1 : 0,
            t.document_id,
            id,
          );
          resetSectionQuiz(id);
        }
      } else {
        id = Number(insert.run(examId, position, t.title, t.summary, JSON.stringify(t.page_ids), t.emphasized ? 1 : 0, t.document_id).lastInsertRowid);
      }
      for (const name of t.concepts) if (name.trim()) link.run(id, upsertConcept(userId, name));
    });
    // Questions whose source slide moved to a different section follow it.
    const owner = new Map<number, number>();
    (db.prepare("SELECT id, page_ids FROM topics WHERE exam_id = ?").all(examId) as { id: number; page_ids: string }[]).forEach((t) =>
      (JSON.parse(t.page_ids) as number[]).forEach((p) => owner.set(p, t.id)),
    );
    const move = db.prepare("UPDATE questions SET topic_id = ? WHERE id = ?");
    for (const q of db.prepare("SELECT id, topic_id, source_page_id FROM questions WHERE exam_id = ? AND source_page_id IS NOT NULL").all(examId) as {
      id: number;
      topic_id: number | null;
      source_page_id: number;
    }[]) {
      const t = owner.get(q.source_page_id);
      if (t != null && t !== q.topic_id) move.run(t, q.id);
    }
    refileQuestions(examId);
    renumber(examId);
  })();
}

/** Meta key marking an exam as done by the one-time upgrade to lecture-based topic maps. */
export const lectureMapsKey = (examId: number) => `lecture_maps_v1:${examId}`;

/**
 * One-time upgrade (run at startup): every exam whose topic map still has old-style topics (no lecture) and that has
 * at least one read lecture is re-mapped by lecture with a full rebuild, one exam at a time (the owner's own key, text
 * only). Matching topics keep their lesson, quiz and progress. Each exam is recorded in `meta` once it has been tried,
 * so it never runs twice for an exam and a restart picks up with the exams not reached yet. A failure is logged, the
 * old map stays in place (and stays usable), and the exam is not tried again automatically; Rebuild still works.
 * The plan is rebuilt by the map build itself after each exam. Returns how many exams were re-mapped.
 */
export async function rebuildLectureMaps(): Promise<number> {
  const exams = db
    .prepare(
      `SELECT DISTINCT t.exam_id id FROM topics t
       WHERE t.document_id IS NULL AND EXISTS (SELECT 1 FROM documents d WHERE d.exam_id = t.exam_id AND d.status = 'done')
       ORDER BY t.exam_id`,
    )
    .all() as { id: number }[];
  let done = 0;
  for (const { id } of exams) {
    const key = lectureMapsKey(id);
    const prior = getMeta(key);
    // A failed exam is tried again on the next start (an AI outage shouldn't leave it on the old map for good), up
    // to LECTURE_MAP_TRIES times; after that it stays as it is until someone presses Rebuild.
    const failures = prior?.startsWith("failed") ? Number(prior.split(":")[1] ?? LECTURE_MAP_TRIES) : 0;
    if (prior === "done" || failures >= LECTURE_MAP_TRIES) continue;
    // The student may have pressed Rebuild while this exam waited its turn: then there is nothing left to do.
    if (!db.prepare("SELECT 1 FROM topics WHERE exam_id = ? AND document_id IS NULL LIMIT 1").get(id)) {
      setMeta(key, "done");
      continue;
    }
    const failed = (why: unknown) => {
      console.error(`Reorganising exam ${id}'s topics by lecture failed (try ${failures + 1} of ${LECTURE_MAP_TRIES}); its old topic map stays:`, why);
      setMeta(key, `failed:${failures + 1}`);
    };
    try {
      await buildTopicMap(id, "full");
      const s = db.prepare("SELECT topic_status, topic_error FROM exams WHERE id = ?").get(id) as { topic_status: string; topic_error: string | null } | undefined;
      if (s?.topic_status === "error") {
        // The old map is still there and works: show it as ready, not as a failed build the student didn't ask for.
        const left = db.prepare("SELECT COUNT(*) n FROM topics WHERE exam_id = ?").get(id) as { n: number };
        if (left.n > 0) db.prepare("UPDATE exams SET topic_status = 'ready', topic_error = NULL WHERE id = ?").run(id);
        failed(s.topic_error);
      } else {
        setMeta(key, "done");
        done++;
      }
    } catch (err) {
      failed(err);
    }
  }
  return done;
}

/** How many server starts may try to re-map an exam by lecture before giving up (Rebuild still works by hand). */
const LECTURE_MAP_TRIES = 3;
