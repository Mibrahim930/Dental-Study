import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startAttempt, writingAttempt } from "@/lib/practice";
import { scopeTopicIds, type Scope } from "@/lib/practicePlan";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { ownsExam } from "@/lib/owner";
import { readJson } from "@/lib/http";

const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);

export async function POST(request: Request, ctx: RouteContext<"/api/exams/[id]/attempts">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const examId = Number((await ctx.params).id);
  if (!ownsExam(user.id, examId)) return notFound();
  const body = await readJson(request);
  // A second tap on Start while the first exam is still being written gets that exam, not a second one to pay for.
  const writing = writingAttempt(user.id, examId);
  if (writing != null) return NextResponse.json({ id: writing });
  const size = Math.min(Math.max(Number(body.size) || 25, 5), 100);

  const scopeIn = body.scope && typeof body.scope === "object" ? (body.scope as { kind?: unknown; documentIds?: unknown; topicIds?: unknown }) : undefined;
  const scope: Scope =
    scopeIn?.kind === "lectures"
      ? { kind: "lectures", documentIds: ids(scopeIn.documentIds) }
      : scopeIn?.kind === "topics" || (!scopeIn && ids(body.topicIds).length)
        ? { kind: "topics", topicIds: ids(scopeIn?.topicIds ?? body.topicIds) }
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
    // Chosen lectures: questions come only from their slides (a topic can also hold slides from other lectures).
    documentIds: scope.kind === "lectures" ? scope.documentIds : undefined,
    adaptive,
  });
  return NextResponse.json({ id });
}
