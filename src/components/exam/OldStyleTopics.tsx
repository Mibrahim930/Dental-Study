import { Icon, ICONS } from "@/components/ui";
import type { ExamPageData } from "@/lib/examPage";
import { SectionRow } from "./SectionRow";

/** Topics from a map made before sections were tied to one lecture, in one group of their own. */
export function OldStyleTopics({ data, oldStyle }: { data: ExamPageData; oldStyle: NonNullable<ExamPageData["oldStyle"]> }) {
  const { exam, groups, mapRow } = data;
  return (
    <details className="group rounded-[22px] bg-muted" open={!groups.some((g) => g.docId != null)}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-[22px] p-4 hover:bg-muted-strong [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="leading-snug font-bold">Topics from all lectures</div>
          <div className="text-[13px] font-medium text-muted-foreground">
            {oldStyle.sections.length} topics from an earlier version of the site, not sorted by lecture yet.
            {exam.topic_status === "building" ? "" : " “Re-split every lecture” sorts them into each lecture's sections."}
          </div>
        </div>
        <Icon d={ICONS.chevronDown} size={18} className="mt-1 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <ol className="flex flex-col gap-2 px-2.5 pb-3">
        {oldStyle.sections.map((t) => (
          <SectionRow key={t.id} topic={t} n={t.position + 1} {...mapRow} />
        ))}
      </ol>
    </details>
  );
}
