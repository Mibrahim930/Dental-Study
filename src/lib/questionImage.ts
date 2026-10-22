// Pictures on questions. A question that talks about a picture must show one: the writer may attach any slide that
// has an image, and anything that mentions a picture without one is dropped (or repaired, for questions already stored).
import { db, type PageRow } from "./db";
import { parseNotes } from "./processing";

/**
 * Does the question text send the student to look at a picture? Clear pointing phrases count ("in the radiograph
 * shown", "the image below", "what does the photo show"), and so does anything only a picture can carry: a diagram,
 * figure or illustration, a slide named as such ("on slide 32", "the slide's diagram"), labels ("labeled 'gp'",
 * "marked X"), arrows, and drawn things (dotted lines, shaded areas, colored outlines). A bare "radiograph" or
 * "shown" turns up in ordinary text questions ("which radiograph is best for…", "has been shown to…"), and those
 * must not lose their place.
 */
export function mentionsPicture(text: string): boolean {
  const noun = "(?:image|picture|photo|photograph|radiograph|x-?ray|micrograph|figure|illustration|diagram|drawing|schematic|chart|graph)s?";
  const det = "(?:the|this|that) (?:[\\w'’-]+ )?"; // "the image", "this clinical photo", "the slide's diagram"
  const colour = "(?:solid|double|curved|red|blue|green|yellow|orange|purple|pink|black|white|gr[ae]y|colou?red)";
  const patterns = [
    `\\b(?:shown|pictured|depicted|illustrated|seen|visible|drawn) (?:above|below|here)\\b`,
    `\\b${det}${noun} (?:shown|below|above|provided|attached|accompanying|here|pictured)\\b`,
    `\\b(?:this|the accompanying|the attached|the given|the above|the below) (?:[\\w'’-]+ )?${noun}\\b`,
    `\\b(?:in|on|from) ${det}(?:image|picture|photo|photograph|figure|illustration|diagram|drawing|schematic|chart|graph)s?\\b`,
    `\\b(?:in|on) ${det}(?:radiograph|x-?ray|micrograph)s? of (?:tooth|teeth|the|this|a|an)\\b`,
    `\\b(?:look|looking) at ${det}${noun}\\b`,
    `\\b(?:examine|study|refer to|consider|see) ${det}${noun}\\b`,
    `\\bbased on ${det}${noun}\\b`,
    `\\b${det}${noun} (?:shows?|reveals?|demonstrates?|depicts?|illustrates?)\\b`,
    `\\bwhat is (?:shown|pictured|depicted|illustrated|drawn)\\b`,
    `\\b(?:shown|pictured|depicted|illustrated|drawn) (?:in|on) ${det}${noun}\\b`,
    // Things only a picture can carry.
    `\\b(?:diagram|illustration|schematic|flow ?chart)s?\\b`,
    `\\b(?:the|an|each|both|which|these|those) arrows?\\b`,
    `\\b(?:the|this|that) (?:[\\w'’-]+ )?(?:asterisk|circle|outline|bracket)s?\\b`,
    `\\b(?:dotted|dashed|shaded|hatched) (?:line|area|region|zone|circle|box|outline|portion|part)s?\\b`,
    `\\b${colour} (?:circle|box|outline|arrow)s?\\b`,
    `\\b(?:circled|outlined|highlighted|shaded|boxed|drawn|shown) in ${colour}\\b`,
    `\\b(?:is|are|was|were) (?:drawn|shaded|highlighted|circled|outlined|colou?red|depicted|illustrated|pictured|labeled|labelled|lettered|numbered)\\b`,
    // The student is pointed at a slide: "on slide 32", "slide 32's diagram", "the slide's", "this slide".
    `\\bslides? #?\\d{1,3}\\b`,
    `\\b(?:the|this|that|on|in|from) (?:[\\w-]+ )?slides?(?:'s|’s)?\\b`,
  ];
  if (new RegExp(patterns.join("|"), "i").test(text)) return true;
  // Labels: "labeled 'gp'", "marked X", "labelled as A", "numbered 3". Case matters here ("marked as the" is prose).
  const label = `\\b(?:[Ll]abel(?:l)?ed|[Mm]arked|[Ll]ettered|[Nn]umbered|[Ii]ndicated|[Hh]ighlighted|[Cc]ircled|[Oo]utlined|[Ss]haded)(?: as| with| by)? (?:["'‘“][^"'’”]{1,24}["'’”]|[A-Z]\\b|\\d{1,2}\\b)`;
  return new RegExp(label).test(text);
}

/** The slide number the question names ("on slide 32", "slide #7"), if any. */
export function slideNumberIn(text: string): number | null {
  const m = /\bslides? #?(\d{1,3})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

export type Picture = { page_id: number; aspect: number; crop: { x: number; y: number; width: number; height: number } | null };

/**
 * What the student sees for a slide: its clinical-image crop when the notes marked one, otherwise the whole slide
 * when the notes say it carries an image. With `whole`, a slide the notes didn't mark is still shown in full
 * (every slide has a rendered image), for a question that sends the student to it anyway.
 */
export function pictureOf(page: Pick<PageRow, "id" | "aspect" | "notes_json">, whole = false): Picture | null {
  const n = parseNotes(page);
  if (n?.case_image_box) return { page_id: page.id, aspect: page.aspect, crop: n.case_image_box };
  if (n?.image_description || whole) return { page_id: page.id, aspect: page.aspect, crop: null };
  return null;
}

/**
 * The picture for a question: the slide the writer named, if it has one; else the slide the question's text names
 * by number ("slide 32", when exactly one of the pages has that number); else the slide the question was written
 * from, if that has one; else nothing. When the question text is given, the question is known to need a picture,
 * so the first of those slides that exists is shown whole rather than leaving the student with a picture they
 * can't see.
 */
export function pictureFor(
  pages: Pick<PageRow, "id" | "aspect" | "notes_json" | "page_number">[] | Pick<PageRow, "id" | "aspect" | "notes_json">[],
  named: number | null | undefined,
  source: number | null | undefined,
  stem?: string,
): Picture | null {
  const n = stem != null ? slideNumberIn(stem) : null;
  const numbered = n != null ? pages.filter((p) => "page_number" in p && p.page_number === n) : [];
  const candidates = [named, numbered.length === 1 ? numbered[0].id : null, source];
  const found = candidates.map((id) => (id != null ? pages.find((p) => p.id === id) : undefined)).filter((p): p is (typeof pages)[number] => !!p);
  for (const page of found) {
    const pic = pictureOf(page);
    if (pic) return pic;
  }
  return stem != null && found.length ? pictureOf(found[0], true) : null;
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

export const PICTURE_RULES = `Pictures: slides marked [IMAGE] or [IMAGE-CASE] have a picture the student can be shown. A question that sends the student to look at something ("in the radiograph shown", "the image below", "the diagram", "labeled X", "the dotted line", "the arrow") must set image_page_id to the slide that holds it, normally one of those marked slides; otherwise never mention a picture, diagram, label, arrow or drawing, because the student won't see it. Never write "slide 12", "the slide's" or "this slide" in a question: the student sees no slide numbers. With [IMAGE-CASE] the student sees only the clinical picture; with [IMAGE] (or any other slide named in image_page_id) they see the whole slide, so don't write a picture question whose answer is printed on that slide.`;

/**
 * A picture for a stored question by slide id: the named slide is always shown (cropped when marked, else whole,
 * since the question was stored pointing at it); failing that, the source slide when it has a marked picture.
 */
export function pictureForIds(named: number | null | undefined, source: number | null | undefined): Picture | null {
  const ids = [named, source].filter((x): x is number => x != null);
  if (ids.length === 0) return null;
  const pages = db.prepare(`SELECT id, aspect, notes_json FROM pages WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Pick<PageRow, "id" | "aspect" | "notes_json">[];
  const namedPage = named != null ? pages.find((p) => p.id === named) : undefined;
  if (namedPage) return pictureOf(namedPage, true);
  return pictureFor(pages, null, source);
}

/** The slides of a topic, for finding one by its number. */
function topicSlides(topicId: number | null | undefined): Pick<PageRow, "id" | "aspect" | "notes_json" | "page_number">[] {
  if (topicId == null) return [];
  const t = db.prepare("SELECT page_ids FROM topics WHERE id = ?").get(topicId) as { page_ids: string } | undefined;
  const ids = t ? (JSON.parse(t.page_ids) as number[]) : [];
  if (ids.length === 0) return [];
  return db.prepare(`SELECT id, aspect, notes_json, page_number FROM pages WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Pick<PageRow, "id" | "aspect" | "notes_json" | "page_number">[];
}

/**
 * The picture to attach to a stored question that mentions one but has none: the slide its text names by number
 * (among the topic's slides, shown whole: the student was told to look at it), else the slide it was written from
 * when the notes marked a picture there. No other whole-slide fallback here: nothing has checked that the slide
 * doesn't print the answer.
 */
function repairPicture(stem: string, topicId: number | null | undefined, source: number | null | undefined): Picture | null {
  const n = slideNumberIn(stem);
  const numbered = n != null ? topicSlides(topicId).filter((p) => p.page_number === n) : [];
  return pictureForIds(numbered.length === 1 ? numbered[0].id : null, source);
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
        `SELECT q.id, q.stem, q.topic_id, q.source_page_id, q.case_id, c.image_page_id AS case_image FROM questions q LEFT JOIN cases c ON c.id = q.case_id
         WHERE q.image_page_id IS NULL AND q.flagged = 0`,
      )
      .all() as { id: number; stem: string; topic_id: number | null; source_page_id: number | null; case_id: number | null; case_image: number | null }[];
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
      const pic = repairPicture(r.stem, r.topic_id, r.source_page_id);
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
        const pic = repairPicture(q.question, t.id, q.source_page_id);
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
