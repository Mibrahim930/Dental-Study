import fs from "fs";
import path from "path";
import { db, FILES_DIR } from "@/lib/db";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsPage } from "@/lib/owner";

// Serves a rendered slide image by page id.
export async function GET(_request: Request, ctx: RouteContext<"/api/pages/[id]/image">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const pageId = Number((await ctx.params).id);
  if (!ownsPage(user.id, pageId)) return notFound();
  const row = db.prepare("SELECT image_path FROM pages WHERE id = ?").get(pageId) as
    | { image_path: string }
    | undefined;
  if (!row) return new Response("Not found", { status: 404 });
  const file = path.join(FILES_DIR, row.image_path);
  if (!fs.existsSync(file)) return new Response("Not found", { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" },
  });
}
