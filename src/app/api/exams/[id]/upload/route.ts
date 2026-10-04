import { NextResponse } from "next/server";
import { getExam } from "@/lib/db";
import { addDocument } from "@/lib/processing";
import { apiUser, unauthorized } from "@/lib/user";

export async function POST(request: Request, ctx: RouteContext<"/api/exams/[id]/upload">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const examId = Number((await ctx.params).id);
  if (!getExam(examId, user.id)) return NextResponse.json({ error: "Exam not found" }, { status: 404 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF files are supported right now" }, { status: 400 });
  }
  try {
    const id = await addDocument(examId, file.name.replace(/\.pdf$/i, ""), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json({ error: `Could not read this PDF: ${String(err)}` }, { status: 400 });
  }
}
