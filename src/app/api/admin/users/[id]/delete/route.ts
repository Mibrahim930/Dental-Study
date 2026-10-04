import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { db, FILES_DIR } from "@/lib/db";
import { apiAdmin, notFound, unauthorized } from "@/lib/user";
import { sharedImageDirs } from "@/lib/classes";

// Permanently removes an account and everything it owns (exams, lectures, progress, files).
export async function POST(_request: Request, ctx: RouteContext<"/api/admin/users/[id]/delete">) {
  const admin = await apiAdmin();
  if (!admin) return unauthorized();
  const id = Number((await ctx.params).id);
  if (id === admin.id) return NextResponse.json({ error: "You can't remove your own admin account." }, { status: 400 });
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return notFound();
  const docs = db.prepare("SELECT d.id FROM documents d JOIN exams e ON e.id = d.exam_id WHERE e.user_id = ?").all(id) as { id: number }[];
  // Slide images that classmates' copied exams still use are kept.
  const keep = sharedImageDirs(docs.map((d) => d.id), id);
  db.transaction(() => {
    db.prepare(`DELETE FROM pages_fts WHERE page_id IN (SELECT p.id FROM pages p JOIN documents d ON d.id = p.document_id JOIN exams e ON e.id = d.exam_id WHERE e.user_id = ?)`).run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id); // cascades to exams, concepts, glossary, usage
  })();
  for (const d of docs.filter((d) => !keep.has(d.id))) fs.rmSync(path.join(FILES_DIR, `doc-${d.id}`), { recursive: true, force: true });
  return NextResponse.json({ ok: true });
}
