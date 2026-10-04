import { NextResponse } from "next/server";
import { db, type Topic } from "@/lib/db";
import { apiUser, notFound, unauthorized } from "@/lib/user";
import { weakestTopics, type PlanTask } from "@/lib/planner";
import { startAttempt } from "@/lib/practice";

// Where a plan task leads: a study session at the right topic, a practice exam, or the review queue.
export async function POST(_request: Request, ctx: RouteContext<"/api/planner/tasks/[id]/start">) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const task = db.prepare("SELECT * FROM plan_tasks WHERE id = ? AND user_id = ?").get(Number((await ctx.params).id), user.id) as
    | PlanTask
    | undefined;
  if (!task) return notFound();
  const topicIds = JSON.parse(task.topic_ids) as number[];

  switch (task.kind) {
    case "review":
      return NextResponse.json({ url: "/review" });
    case "upload":
      return NextResponse.json({ url: `/exams/${task.exam_id}` });
    case "learn": {
      const topic = db.prepare("SELECT position FROM topics WHERE id = ?").get(topicIds[0]) as Pick<Topic, "position"> | undefined;
      return NextResponse.json({ url: topic ? `/exams/${task.exam_id}/study?topic=${topic.position}` : `/exams/${task.exam_id}` });
    }
    default: {
      const ids = task.kind === "weak_review" ? weakestTopics(task.exam_id!) : task.kind === "final_practice" ? [] : topicIds;
      const size = task.kind === "final_practice" ? 25 : 10;
      const id = startAttempt(task.exam_id!, { size, mode: task.kind === "final_practice" ? "timed" : "tutor", style: "mixed", topicIds: ids, taskId: task.id });
      return NextResponse.json({ url: `/attempts/${id}` });
    }
  }
}
