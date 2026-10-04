import { notFound } from "next/navigation";
import { attemptView } from "@/lib/attemptView";
import { AttemptRunner } from "./AttemptRunner";
import { requireUser } from "@/lib/user";
import { ownsAttempt } from "@/lib/owner";

export const dynamic = "force-dynamic";

export default async function AttemptPage(props: PageProps<"/attempts/[id]">) {
  const user = await requireUser();
  const id = Number((await props.params).id);
  const view = ownsAttempt(user.id, id) ? attemptView(id) : null;
  if (!view) notFound();
  return <AttemptRunner attemptId={id} initial={view} />;
}
