// Bulk-import lecture PDFs into an exam from the command line.
//   npm run import -- "Endo Block Exam" 2026-11-12 "/path/to/lectures" [more files or folders...]
// If an exam with that name exists, the lectures are added to it.
import fs from "fs";
import path from "path";
import { db } from "../src/lib/db";
import { addDocument, processDocument } from "../src/lib/processing";
import { buildTopicMap } from "../src/lib/topics";

async function main() {
  const [name, date, ...inputs] = process.argv.slice(2);
  if (!name || inputs.length === 0) {
    console.error('Usage: npm run import -- "Exam name" YYYY-MM-DD|- <pdf files or folders...>');
    process.exit(1);
  }
  const files = inputs.flatMap((p) =>
    fs.statSync(p).isDirectory()
      ? fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith(".pdf")).sort().map((f) => path.join(p, f))
      : [p],
  );

  let exam = db.prepare("SELECT id FROM exams WHERE name = ?").get(name) as { id: number } | undefined;
  if (!exam) {
    const id = db.prepare("INSERT INTO exams (name, exam_date) VALUES (?, ?)").run(name, date && date !== "-" ? date : null).lastInsertRowid;
    exam = { id: Number(id) };
    console.log(`Created exam "${name}" (#${exam.id})`);
  }

  const docIds: number[] = [];
  for (const file of files) {
    const id = await addDocument(exam.id, path.basename(file).replace(/\.pdf$/i, ""), fs.readFileSync(file));
    const pages = (db.prepare("SELECT page_count FROM documents WHERE id = ?").get(id) as { page_count: number }).page_count;
    console.log(`Added ${path.basename(file)} (${pages} slides)`);
    docIds.push(id);
  }

  const timer = setInterval(() => {
    const r = db
      .prepare(`SELECT SUM(p.status='done') done, SUM(p.status='error') failed, COUNT(*) total FROM pages p WHERE p.document_id IN (${docIds.join(",")})`)
      .get() as { done: number; failed: number; total: number };
    console.log(`Slides read: ${r.done}/${r.total}${r.failed ? ` (${r.failed} failed)` : ""}`);
  }, 15000);
  await Promise.all(docIds.map((id) => processDocument(id)));
  clearInterval(timer);

  console.log("Building topic map…");
  await buildTopicMap(exam.id);
  const e = db.prepare("SELECT topic_status, topic_error FROM exams WHERE id = ?").get(exam.id) as { topic_status: string; topic_error: string | null };
  const n = (db.prepare("SELECT COUNT(*) n FROM topics WHERE exam_id = ?").get(exam.id) as { n: number }).n;
  console.log(e.topic_status === "ready" ? `Done: ${n} topics.` : `Topic map failed: ${e.topic_error}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
