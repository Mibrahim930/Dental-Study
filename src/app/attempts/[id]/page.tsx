import { notFound } from "next/navigation";
import { attemptView } from "@/lib/attemptView";
import { AttemptRunner } from "./AttemptRunner";

export const dynamic = "force-dynamic";

export default async function AttemptPage(props: PageProps<"/attempts/[id]">) {
  const id = Number((await props.params).id);
  const view = attemptView(id);
  if (!view) notFound();
  return <AttemptRunner attemptId={id} initial={view} />;
}
