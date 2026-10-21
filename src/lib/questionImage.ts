// Pictures on questions. A question that talks about a picture must show one: the writer may attach any slide that
// has an image, and anything that mentions a picture without one is dropped (or repaired, for questions already stored).
import { db, type PageRow } from "./db";
import { parseNotes } from "./processing";

/**
 * Does the question text send the student to look at a picture? Only clear pointing phrases count ("in the radiograph
 * shown", "the image below", "what does the photo show"): a bare "radiograph" or "shown" turns up in ordinary text
 * questions ("which radiograph is best for…", "has been shown to…"), and those must not lose their place.
 */
export function mentionsPicture(text: string): boolean {
  const noun = "(?:image|picture|photo|photograph|radiograph|x-?ray|micrograph|figure|illustration|diagram)s?";
  const det = "(?:the|this) (?:[\\w-]+ )?"; // "the image", "this clinical photo", "the periapical radiograph"
  const patterns = [
    `\\b(?:shown|pictured|depicted|illustrated|seen|visible) (?:above|below|here)\\b`,
    `\\b${det}${noun} (?:shown|below|above|provided|attached|accompanying|here|pictured)\\b`,
    `\\b(?:this|the accompanying|the attached|the given|the above|the below) (?:[\\w-]+ )?${noun}\\b`,
    `\\b(?:in|on|from) ${det}(?:image|picture|photo|photograph|figure|illustration|diagram)s?\\b`,
    `\\b(?:in|on) ${det}(?:radiograph|x-?ray|micrograph)s? of (?:tooth|teeth|the|this|a|an)\\b`,
    `\\b(?:look|looking) at ${det}${noun}\\b`,
    `\\b(?:examine|study|refer to|consider) ${det}${noun}\\b`,
    `\\bbased on ${det}${noun}\\b`,
    `\\b${det}${noun} (?:shows?|reveals?|demonstrates?|depicts?|illustrates?)\\b`,
    `\\bwhat is (?:shown|pictured|depicted|illustrated)\\b`,
    `\\b(?:shown|pictured|depicted|illustrated) in ${det}${noun}\\b`,
    `\\b(?:the|an) arrows?\\b`,
    `\\b(?:labeled|labelled|marked) (?:as |with )?["']?[A-Z0-9]\\b`,
  ];
  return new RegExp(patterns.join("|"), "i").test(text);
}

export type Picture = { page_id: number; aspect: number; crop: { x: number; y: number; width: number; height: number } | null };

/** What the student sees for a slide: its clinical-image crop when the notes marked one, otherwise the whole slide. */
export function pictureOf(page: Pick<PageRow, "id" | "aspect" | "notes_json">): Picture | null {
  const n = parseNotes(page);
  if (!n?.image_description && !n?.case_image_box) return null;
  return { page_id: page.id, aspect: page.aspect, crop: n.case_image_box ?? null };
}

/**
 * The picture for a question: the slide the writer named, if it has one; else the slide the question was written
 * from, if that has one; else nothing.
 */
export function pictureFor(pages: Pick<PageRow, "id" | "aspect" | "notes_json">[], named: number | null | undefined, source: number | null | undefined): Picture | null {
  for (const id of [named, source]) {
    const page = id != null ? pages.find((p) => p.id === id) : undefined;
    const pic = page && pictureOf(page);
    if (pic) return pic;
  }
  return null;
}

/** Tag slides in the notes text: [IMAGE-CASE] when only the clinical picture is shown, [IMAGE] when the whole slide is. */
export function markPictures(notes: string, pages: Pick<PageRow, "id" | "aspect" | "notes_json">[]): string {
  const tag = new Map<number, string>();
  for (const p of pages) {
    const n = parseNotes(p);
    if (n?.case_image_box) tag.set(p.id, "[IMAGE-CASE]");
    else if (n?.image_description) tag.set(p.id, "[IMAGE]");
  }
  return notes.replace(/\[P(\d+)\]/g, (m, id) => (tag.has(Number(id)) ? `${m} ${tag.get(Number(id))}` : m));
}

export const PICTURE_RULES = `Pictures: slides marked [IMAGE] or [IMAGE-CASE] have a picture the student can be shown. A question may refer to a picture ("in the radiograph shown", "the image below") ONLY if it sets image_page_id to one of those slides; otherwise never mention a picture. With [IMAGE-CASE] the student sees only the clinical picture; with [IMAGE] they see the whole slide, so don't write a picture question whose answer is printed on that slide.`;

/** A picture for a stored question by slide id (whichever of the named or source slide has one). */
export function pictureForIds(named: number | null | undefined, source: number | null | undefined): Picture | null {
  const ids = [named, source].filter((x): x is number => x != null);
  if (ids.length === 0) return null;
  const pages = db.prepare(`SELECT id, aspect, notes_json FROM pages WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Pick<PageRow, "id" | "aspect" | "notes_json">[];
  return pictureFor(pages, named, source);
}

/**
 * One-time repair for questions written before pictures were enforced: a question that mentions a picture but has
 * none gets the picture of the slide it was written from when that slide has one; otherwise it goes (practice
 * questions never answered are deleted, answered ones are retired; quiz questions are hidden in place).
 * Safe to run any number of times. Returns how many questions were changed.
 */
export function repairPictureQuestions(): number {
  let changed = 0;
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT q.id, q.stem, q.source_page_id, q.case_id, c.image_page_id AS case_image FROM questions q LEFT JOIN cases c ON c.id = q.case_id
         WHERE q.image_page_id IS NULL AND q.flagged = 0`,
      )
      .all() as { id: number; stem: string; source_page_id: number | null; case_id: number | null; case_image: number | null }[];
    const attach = db.prepare("UPDATE questions SET image_page_id = ? WHERE id = ?");
    const retire = db.prepare("UPDATE questions SET flagged = 1, flag_note = 'No picture to show' WHERE id = ?");
    const del = db.prepare("DELETE FROM questions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.question_id = questions.id AND aq.chosen_index IS NOT NULL)");
    for (const r of rows) {
      if (!mentionsPicture(r.stem)) continue;
      if (r.case_id != null) {
        // A case set's picture belongs to the case: hand it to the question, and never break up a set by removing one question.
        if (r.case_image != null) {
          attach.run(r.case_image, r.id);
          changed++;
        }
        continue;
      }
      const pic = pictureForIds(null, r.source_page_id);
      if (pic) attach.run(pic.page_id, r.id);
      else if (del.run(r.id).changes === 0) retire.run(r.id);
      changed++;
    }
    const topics = db.prepare("SELECT id, checks_json FROM topics WHERE checks_json IS NOT NULL").all() as { id: number; checks_json: string }[];
    const save = db.prepare("UPDATE topics SET checks_json = ? WHERE id = ?");
    for (const t of topics) {
      let qs: { question: string; source_page_id?: number | null; image_page_id?: number | null; hidden?: boolean; report_note?: string | null }[];
      try {
        qs = JSON.parse(t.checks_json);
      } catch {
        continue;
      }
      let touched = false;
      for (const q of qs) {
        if (q.hidden || q.image_page_id != null || !mentionsPicture(q.question)) continue;
        const pic = pictureForIds(null, q.source_page_id);
        if (pic) q.image_page_id = pic.page_id;
        else {
          q.hidden = true;
          q.report_note = q.report_note ?? "No picture to show";
        }
        touched = true;
        changed++;
      }
      if (touched) save.run(JSON.stringify(qs), t.id);
    }
  })();
  return changed;
}
