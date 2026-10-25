import fs from "fs";
import { apiAdmin, notFound, unauthorized } from "@/lib/user";
import { reportImagePath } from "@/lib/reports";

/** A report's screenshot, for the Admin page only. */
export async function GET(_request: Request, ctx: RouteContext<"/api/admin/reports/[id]/image/[n]">) {
  const admin = await apiAdmin();
  if (!admin) return unauthorized();
  const { id, n } = await ctx.params;
  const file = reportImagePath(Number(id), Number(n));
  if (!file) return notFound();
  return new Response(fs.readFileSync(file), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
}
