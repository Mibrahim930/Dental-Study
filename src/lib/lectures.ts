// Topic maps are per lecture: each lecture (document) holds its sections, and `topics.position` walks them lecture by
// lecture. These helpers group an exam's sections under their lectures for the exam page, study session and practice
// form. Old-style topics (mapped across lectures, document_id NULL) form one group with no lecture.

export type LectureDoc = { id: number; filename: string };
export type SectionLike = { id: number; position: number; document_id: number | null };

export type LectureGroup<T extends SectionLike> = {
  /** documents.id, or null for the old-style topics that belong to no single lecture. */
  docId: number | null;
  /** 1-based lecture number in upload order (null for old-style topics). */
  no: number | null;
  /** Lecture name: the file name without ".pdf". */
  name: string;
  sections: T[];
};

export const lectureName = (filename: string) => filename.replace(/\.pdf$/i, "");

/**
 * Sections grouped by lecture, in study order (by position). Lectures are numbered by upload order among all of the
 * exam's lectures (`docs`, ordered by id), so "Lecture 3" stays Lecture 3 while a later one is still being read.
 */
export function groupByLecture<T extends SectionLike>(sections: T[], docs: LectureDoc[]): LectureGroup<T>[] {
  const sorted = [...docs].sort((a, b) => a.id - b.id);
  const no = new Map(sorted.map((d, i) => [d.id, i + 1]));
  const name = new Map(sorted.map((d) => [d.id, lectureName(d.filename)]));
  const groups = new Map<string, LectureGroup<T>>();
  for (const s of [...sections].sort((a, b) => a.position - b.position)) {
    const key = s.document_id == null ? "none" : String(s.document_id);
    let g = groups.get(key);
    if (!g) {
      g = s.document_id == null
        ? { docId: null, no: null, name: "Topics", sections: [] }
        : { docId: s.document_id, no: no.get(s.document_id) ?? null, name: name.get(s.document_id) ?? "Lecture", sections: [] };
      groups.set(key, g);
    }
    g.sections.push(s);
  }
  return [...groups.values()];
}

/** Where a section sits: its lecture and its number inside it. Used by the study session. */
export type SectionPlace = { lectureId: number | null; lectureNo: number | null; lecture: string; section: number; sections: number };

export function sectionPlaces<T extends SectionLike>(sections: T[], docs: LectureDoc[]): Map<number, SectionPlace> {
  const out = new Map<number, SectionPlace>();
  for (const g of groupByLecture(sections, docs))
    g.sections.forEach((s, i) => out.set(s.id, { lectureId: g.docId, lectureNo: g.no, lecture: g.name, section: i + 1, sections: g.sections.length }));
  return out;
}
