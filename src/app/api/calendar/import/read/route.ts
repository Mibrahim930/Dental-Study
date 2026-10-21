import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { credentials, type Credentials } from "@/lib/credentials";
import { plannerSettings, todayIn } from "@/lib/planner";
import { imageToJpeg, openPdf, renderPage, sniffFile } from "@/lib/pdf";
import { isKeyProblem, MAX_PASTE_CHARS, readSchedule } from "@/lib/scheduleImport";

export const maxDuration = 120;

/** Keep in step with MAX_IMPORT_MB in ImportSchedule.tsx. */
const MAX_IMPORT_MB = 20;
const MAX_FILES = 4;
const MAX_IMAGES = 4;
const PDF_PAGES = 3;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * "Paste or snap your exam schedule": pasted text and/or photos and PDFs → the exams the AI found, for the confirm screen.
 * Saves nothing. One AI call on the student's own key (about 1–2 cents), logged as "exam schedule import".
 */
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  if (Number(request.headers.get("content-length")) > MAX_IMPORT_MB * 1024 * 1024) {
    return fail(`That's over ${MAX_IMPORT_MB} MB. Try a smaller photo, a screenshot, or paste the text instead.`, 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("That didn't arrive in one piece. Check your connection and try again.");
  }

  const text = typeof form.get("text") === "string" ? String(form.get("text")) : "";
  if (text.length > MAX_PASTE_CHARS) return fail("That's a lot of text. Paste just the part with the exams (up to about 30,000 characters).");
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!text.trim() && files.length === 0) return fail("Paste the schedule or add a photo first.");
  if (files.length > MAX_FILES) return fail(`Add up to ${MAX_FILES} files at a time.`);
  if (files.reduce((s, f) => s + f.size, 0) > MAX_IMPORT_MB * 1024 * 1024) return fail(`That's over ${MAX_IMPORT_MB} MB. Try a smaller photo, a screenshot, or paste the text instead.`, 413);

  // Every file becomes JPEG page images (photos resized, PDFs: the first pages rendered) plus any PDF text layer.
  const images: Uint8Array[] = [];
  const pdfText: string[] = [];
  let pdfCut = false;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffFile(bytes);
    if (kind === "heic") {
      return fail(
        `"${file.name}" is an iPhone HEIC photo, which can't be read here yet. Take a screenshot of the photo (screenshots are PNG) and add that instead.`,
      );
    }
    if (kind === "webp") return fail(`"${file.name}" is a WebP image, which can't be read here. Take a screenshot of it or save it as JPG or PNG.`);
    if (kind === "unknown") return fail(`"${file.name}" isn't a photo or a PDF. Use a JPG or PNG photo, a PDF, or paste the text.`);
    try {
      if (kind === "pdf") {
        const doc = openPdf(bytes);
        try {
          const pages = doc.countPages();
          if (pages > PDF_PAGES) pdfCut = true;
          for (let i = 0; i < Math.min(PDF_PAGES, pages); i++) {
            const page = renderPage(doc, i);
            images.push(page.jpeg);
            if (page.text) pdfText.push(page.text);
          }
        } finally {
          doc.destroy();
        }
      } else {
        images.push(imageToJpeg(bytes, kind));
      }
    } catch (err) {
      console.error("Schedule import: couldn't open", file.name, err);
      return fail(`We couldn't open "${file.name}". Try another photo, or paste the text instead.`);
    }
  }
  if (images.length > MAX_IMAGES) return fail(`That's more than ${MAX_IMAGES} pages or photos. Add the pages with the exams only.`);

  let creds: Credentials;
  try {
    creds = credentials(user.id);
  } catch {
    return fail("Add your AI key in Settings to read a schedule, or type the exams in the table instead.");
  }
  const timezone = plannerSettings(user.id).timezone;
  try {
    const { exams, yearAssumed, cut } = await readSchedule({ creds, today: todayIn(timezone), timezone, text, images, pdfText: pdfText.join("\n\n") });
    return NextResponse.json({
      exams,
      yearAssumed,
      pdfCut,
      cut,
      message: exams.length === 0 ? "We couldn't find any exam dates in that. Try a clearer photo or paste the text." : null,
    });
  } catch (err) {
    // Technical detail to the server log; the student sees a plain message (key and billing problems are worth saying).
    console.error("Schedule import failed", err);
    const msg = err instanceof Error ? err.message : String(err);
    return fail(isKeyProblem(msg) ? msg :"The AI couldn't read that just now. Try again in a moment, or type the exams in the table.", 502);
  }
}
