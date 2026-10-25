import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { imageToJpeg, sniffFile } from "@/lib/pdf";
import { createReport, REPORT_KINDS, REPORT_MAX_CHARS, REPORT_MAX_IMAGE_MB, REPORT_MAX_IMAGES, type ReportKind, type ReportMeta } from "@/lib/reports";

export const maxDuration = 60;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** "Report a problem or idea": text plus up to a few screenshots, saved for the site owner. */
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const maxBytes = (REPORT_MAX_IMAGES * REPORT_MAX_IMAGE_MB + 1) * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > maxBytes) return fail(`That's too big. Up to ${REPORT_MAX_IMAGES} screenshots of ${REPORT_MAX_IMAGE_MB} MB each.`, 413);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("That didn't arrive in one piece. Check your connection and try again.");
  }

  const message = typeof form.get("message") === "string" ? String(form.get("message")).trim() : "";
  if (!message) return fail("Write a few words about what happened or what you'd like.");
  if (message.length > REPORT_MAX_CHARS) return fail(`That's a lot of text. Keep it under ${REPORT_MAX_CHARS} characters.`);
  const kindRaw = String(form.get("kind") ?? "problem");
  const kind: ReportKind = (REPORT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as ReportKind) : "problem";
  const pageRaw = typeof form.get("page") === "string" ? String(form.get("page")) : "";
  const page = pageRaw.startsWith("/") ? pageRaw.slice(0, 500) : null;
  let meta: ReportMeta = {};
  try {
    const parsed = JSON.parse(String(form.get("meta") ?? "{}")) as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
    meta = { viewport: str(parsed.viewport, 40), theme: str(parsed.theme, 40), userAgent: str(parsed.userAgent, 400) };
  } catch {
    meta = {};
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > REPORT_MAX_IMAGES) return fail(`Add up to ${REPORT_MAX_IMAGES} screenshots.`);
  const images: Uint8Array[] = [];
  for (const file of files) {
    if (file.size > REPORT_MAX_IMAGE_MB * 1024 * 1024) return fail(`"${file.name}" is over ${REPORT_MAX_IMAGE_MB} MB. Try a screenshot instead of a photo.`, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileKind = sniffFile(bytes);
    if (fileKind === "heic") return fail(`"${file.name}" is an iPhone HEIC photo, which can't be read here yet. Take a screenshot (screenshots are PNG) and add that instead.`);
    if (fileKind === "webp") return fail(`"${file.name}" is a WebP image, which can't be read here. Take a screenshot of it or save it as JPG or PNG.`);
    if (!["jpeg", "png", "gif", "bmp", "tiff"].includes(fileKind)) return fail(`"${file.name}" isn't a picture. Add JPG or PNG screenshots.`);
    try {
      images.push(imageToJpeg(bytes, fileKind, 1600));
    } catch {
      return fail(`"${file.name}" couldn't be read as a picture. Try a screenshot.`);
    }
  }

  const id = createReport({ userId: user.id, kind, message, page, meta, images });
  return NextResponse.json({ ok: true, id });
}
