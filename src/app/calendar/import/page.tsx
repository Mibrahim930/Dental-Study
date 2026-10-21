import Link from "next/link";
import { requireUser } from "@/lib/user";
import { userToday } from "@/lib/planner";
import { existingExamKeys } from "@/lib/examImport";
import { ImportSchedule } from "@/components/ImportSchedule";
import { Icon, ICONS } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Import the year's exams from a pasted schedule, a photo or PDF, or a school calendar file — then check and add them. */
export default async function ImportPage() {
  const user = await requireUser();
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Link href="/calendar" className="btn-ghost self-start px-0">
        <Icon d={ICONS.arrowLeft} size={18} /> Calendar
      </Link>
      <div className="flex flex-col gap-1.5">
        <h1 className="page-title">Import your exams</h1>
        <p className="text-[15px] text-muted-foreground">
          Rather type them?{" "}
          <Link href="/calendar/add" className="font-semibold text-foreground underline underline-offset-4">
            Add exams in a table
          </Link>
          .
        </p>
      </div>
      <ImportSchedule existingKeys={[...existingExamKeys(user.id)]} today={userToday(user.id)} />
    </div>
  );
}
