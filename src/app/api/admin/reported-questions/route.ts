import { listReportedQuestions } from "@/lib/reportedQuestions";
import { apiAdmin, notFound } from "@/lib/user";

/** Every reported question as one JSON file, for the owner to download from the Admin page. */
export async function GET() {
  const admin = await apiAdmin();
  if (!admin) return notFound();
  const rows = listReportedQuestions(5000).map((r) => ({ ...r, reporter: r.email, email: undefined, user_id: undefined }));
  return new Response(JSON.stringify({ exported_at: new Date().toISOString(), count: rows.length, reported_questions: rows }, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="reported-questions-${new Date().toISOString().slice(0, 10)}.json"` },
  });
}
