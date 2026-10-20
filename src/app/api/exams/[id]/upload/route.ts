import { NextResponse } from "next/server";
import { getExam } from "@/lib/db";
import { addDocument } from "@/lib/processing";
import { apiUser, unauthorized } from "@/lib/user";

/** Largest PDF accepted; keep in step with proxyClientMaxBodySize in next.config.ts and MAX_UPLOAD_MB in Uploader.tsx. */
const MAX_UPLOAD_MB = 100;

export async function POST(request: Request, ctx: RouteContext<"/api/exams/[id]/upload">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const examId = Number((await ctx.params).id);
  if (!getExam(examId, user.id)) return NextResponse.json({ error: "Exam not found" }, { status: 404 });
  // Bigger than the server will buffer (proxyClientMaxBodySize in next.config.ts): say so plainly instead of a cut-off body.
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_MB * 1024 * 1024) {
    return NextResponse.json({ error: `This file is over ${MAX_UPLOAD_MB} MB. Try exporting the PDF at a smaller size, or split it into two.` }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "The upload didn't arrive in one piece. Check your connection and try again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF files are supported right now" }, { status: 400 });
  }
  try {
    const id = await addDocument(examId, file.name.replace(/\.pdf$/i, ""), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ id });
  } catch (err) {
    if (String(err).includes("ENOSPC")) {
      return NextResponse.json(
        { error: "The site has run out of storage space, so this lecture couldn't be saved. The site owner needs to add space; your other lectures are safe." },
        { status: 507 },
      );
    }
    return NextResponse.json({ error: `Could not read this PDF: ${String(err)}` }, { status: 400 });
  }
}
