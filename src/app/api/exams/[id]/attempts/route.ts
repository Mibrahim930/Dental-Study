import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startAttempt, type Mode, type Style } from "@/lib/practice";
import { scopeTopicIds, type Scope } from "@/lib/practicePlan";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsExam } from "@/lib/owner";

const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);

export async function POST(request: Request, ctx: RouteContext<"/api/exams/[id]/attempts">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const examId = Number((await ctx.params).id);
  if (!ownsExam(user.id, examId)) return notFound();
  const body = (await request.json()) as {
    size?: number;
    mode?: Mode;
    style?: Style;
    scope?: { kind?: string; documentIds?: unknown; topicIds?: unknown };
    topicIds?: unknown;
    adaptive?: boolean;
  };
  const size = Math.min(Math.max(Number(body.size) || 25, 5), 100);

  const scope: Scope =
    body.scope?.kind === "lectures"
      ? { kind: "lectures", documentIds: ids(body.scope.documentIds) }
      : body.scope?.kind === "topics" || (!body.scope && ids(body.topicIds).length)
        ? { kind: "topics", topicIds: ids(body.scope?.topicIds ?? body.topicIds) }
        : { kind: "all" };
  const topicIds = scopeTopicIds(examId, scope);
  if (scope.kind !== "all" && topicIds.length === 0) return NextResponse.json({ error: "Choose at least one lecture or topic." }, { status: 400 });

  // Remember the "focus on my weak spots" choice for next time.
  let adaptive: boolean | undefined;
  if (typeof body.adaptive === "boolean") {
    adaptive = body.adaptive;
    db.prepare("UPDATE users SET focus_weak = ? WHERE id = ?").run(adaptive ? 1 : 0, user.id);
  }

  const id = startAttempt(examId, {
    size,
    mode: body.mode === "timed" ? "timed" : "tutor",
    style: body.style === "recall" || body.style === "case" || body.style === "caseset" ? body.style : "mixed",
    topicIds,
    adaptive,
  });
  return NextResponse.json({ id });
}
