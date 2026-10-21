import Link from "next/link";
import { requireUser } from "@/lib/user";
import { userToday } from "@/lib/planner";
import { existingExamKeys } from "@/lib/examImport";
import { ExamRowsEditor } from "@/components/ExamRowsEditor";
import { Icon, ICONS } from "@/components/ui";

export const dynamic = "force-dynamic";

/** "+ Add exams": type the term's exams in a small table and add them all at once. */
export default async function AddExamsPage() {
  const user = await requireUser();
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Link href="/calendar" className="btn-ghost self-start px-0">
        <Icon d={ICONS.arrowLeft} size={18} /> Calendar
      </Link>
      <div className="flex flex-col gap-1.5">
        <h1 className="page-title">Add this term&apos;s exams</h1>
        <p className="text-[15px] text-muted-foreground">
          One row per exam. Name and date are all you need; the type and course help the calendar and your plan.
        </p>
      </div>
      <section className="card">
        <ExamRowsEditor initial={[]} existingKeys={[...existingExamKeys(user.id)]} today={userToday(user.id)} mode="manual" />
      </section>
    </div>
  );
}
