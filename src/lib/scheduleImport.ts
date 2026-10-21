// "Paste or snap your exam schedule": one AI call reads pasted text and/or photos and returns the exams it found.
// Nothing is saved here; the student checks the list first and the confirm screen saves through createExams().
import { z } from "zod";
import type { ExamKind } from "./db";
import { generate, type Part } from "./ai";
import type { Credentials } from "./credentials";
import { isValidDate, kindOrDefault } from "./calendar";

export const ScheduleSchema = z.object({
  exams: z.array(
    z.object({
      name: z.string().describe("Short exam name as written, without the date, e.g. 'Endo Block Exam 2'"),
      date: z.string().nullable().describe("YYYY-MM-DD, or null when the schedule gives no usable date"),
      course: z.string().nullable().describe("Course name or code if shown, else null"),
      kind: z.enum(["block", "quiz", "practical", "board", "other"]),
      confidence: z.enum(["high", "medium", "low"]).describe("How sure you are about the DATE"),
      note: z.string().nullable().describe("Short plain-English note when something needs checking, else null"),
    }),
  ),
  year_assumed: z.number().nullable().describe("The year used for dates written without a year, or null"),
});
export type ScheduleResult = z.infer<typeof ScheduleSchema>;

export type ImportedExam = {
  name: string;
  date: string | null;
  course: string | null;
  kind: ExamKind;
  confidence: "high" | "medium" | "low";
  note: string | null;
};

export const SCHEDULE_SYSTEM = `You read exam schedules for a dental student and list the exams in them, so she can put them on her study calendar.

What to list:
- Only exams and other assessments: block exams, quizzes, tests, midterms, finals, practicals, OSCEs, lab practicals, board exams (INBDE, NBDE), competency or clinical assessments.
- Ignore lectures, classes, labs, clinics, holidays, breaks, office hours, review sessions and assignment due dates, unless the row clearly is an exam or assessment.
- List each exam once. If an exam runs over several days, give its first day and say so in the note.

Dates:
- Write every date as YYYY-MM-DD.
- Never invent a date. If a row has no date, says TBA/TBD, or the date can't be read, use null with confidence "low".
- Many schedules leave out the year. Work it out from context: a year printed anywhere (title, term name like "Fall 2026", other rows), term start and end dates, and weekdays printed next to dates (pick the year in which that weekday matches). Without any such clue, use the first occurrence on or after about one month before today, because schedules are for the current or coming term. Put the year you assumed for year-less dates in year_assumed.
- If day and month could be swapped (e.g. 03/04), choose the reading that fits the other rows and the term; if nothing settles it, use confidence "low" and say "Day and month could be swapped" in the note.
- If a printed weekday doesn't match the date, use confidence "low" and mention it in the note.
- confidence "high" means the date is printed clearly with enough context; "medium" means you inferred the year or read a slightly unclear photo; "low" means she must check it.

Other fields:
- kind: "block" for block, unit, module, midterm, final and written exams; "quiz" for quizzes and short tests; "practical" for practicals, OSCEs, lab or clinical assessments; "board" for INBDE/NBDE/board/licensing exams; "other" if none fit.
- course: the course name or code if the schedule shows it for that row (or for the whole schedule), else null.
- name: short and as written, no date or time in it. Add the course to the name only if the name would otherwise be vague (e.g. "Quiz 3" -> "Perio Quiz 3").
- note: one short plain-English sentence only when something needs checking (e.g. "Year not shown; assumed 2027."), otherwise null.

If there are no exams at all, return an empty list.`;

export const MAX_PASTE_CHARS = 30000;
/** Most exams one read shows (the same cap as one "Add N exams" press). */
export const MAX_IMPORTED = 60;

/** Error text from the AI provider that the student should see as-is (her key or her billing), not internal errors. */
export function isKeyProblem(msg: string): boolean {
  return /x-api-key|api[ _-]?key|authentication|unauthori[sz]ed|permission|\b401\b|\b403\b|credit balance|billing|quota/i.test(msg) && !/SQLITE|\bat \/|node:internal/i.test(msg);
}

/** One AI call over the pasted text and page images. Logged to ai_usage as "exam schedule import" by generate(). */
export async function readSchedule(opts: {
  creds: Credentials;
  today: string;
  timezone: string;
  text: string;
  images: Uint8Array[];
  pdfText?: string;
}): Promise<{ exams: ImportedExam[]; yearAssumed: number | null; cut: boolean }> {
  const weekday = new Date(`${opts.today}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const intro = `Today is ${opts.today} (${weekday}) in the student's time zone (${opts.timezone}).`;
  const parts: Part[] = [{ type: "text", text: intro }];
  if (opts.text.trim()) parts.push({ type: "text", text: `Pasted schedule:\n<<<\n${opts.text.trim()}\n>>>` });
  if (opts.pdfText?.trim()) parts.push({ type: "text", text: `Text layer of the PDF pages shown below:\n<<<\n${opts.pdfText.trim().slice(0, MAX_PASTE_CHARS)}\n>>>` });
  if (opts.images.length) parts.push({ type: "text", text: `${opts.images.length === 1 ? "A photo or page" : `${opts.images.length} photos or pages`} of the schedule:` });
  for (const img of opts.images) parts.push({ type: "image", base64: Buffer.from(img).toString("base64") });

  const result = await generate({
    creds: opts.creds,
    purpose: "exam schedule import",
    schema: ScheduleSchema,
    system: SCHEDULE_SYSTEM,
    content: parts,
    effort: "low",
    maxTokens: 8000,
  });
  const exams = cleanImported(result);
  return {
    exams,
    yearAssumed: typeof result.year_assumed === "number" && Number.isFinite(result.year_assumed) ? result.year_assumed : null,
    cut: exams.length >= MAX_IMPORTED && (result.exams?.length ?? 0) > MAX_IMPORTED,
  };
}

/** Make the AI's list safe to show: trimmed names, real dates only (anything else becomes "no date, check it"), known types. */
export function cleanImported(result: ScheduleResult | null | undefined): ImportedExam[] {
  const out: ImportedExam[] = [];
  for (const e of result?.exams ?? []) {
    const name = String(e?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) continue;
    const rawDate: string | null = typeof e.date === "string" ? e.date.trim() : null;
    const dateOk = rawDate != null && isValidDate(rawDate);
    const note = typeof e.note === "string" && e.note.trim() ? e.note.trim().slice(0, 200) : null;
    out.push({
      name,
      date: dateOk ? rawDate : null,
      course: typeof e.course === "string" && e.course.trim() ? e.course.replace(/\s+/g, " ").trim().slice(0, 80) : null,
      kind: kindOrDefault(e.kind),
      confidence: !dateOk ? "low" : e.confidence === "high" || e.confidence === "medium" ? e.confidence : "low",
      note: !dateOk && rawDate ? `Couldn't read the date ("${String(rawDate).slice(0, 30)}").` : note,
    });
    if (out.length >= MAX_IMPORTED) break;
  }
  return out;
}
