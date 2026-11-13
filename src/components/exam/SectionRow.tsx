import Link from "next/link";
import type { Topic } from "@/lib/db";
import type { topicConceptsForExam } from "@/lib/memory";
import { Icon, ICONS, MasteryChip } from "@/components/ui";

/** The mean of the known masteries, or null when none is known yet. */
export const average = (xs: (number | null)[]): number | null => {
  const ms = xs.filter((m): m is number => m != null);
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
};

/** One section of a lecture: number (✓ once studied), title, slides, mastery, concept chips; the whole row opens it. */
export function SectionRow({
  topic: t,
  n,
  examId,
  conceptsByTopic,
  studiedIds,
  current,
}: {
  topic: Topic;
  n: number;
  examId: number;
  conceptsByTopic: ReturnType<typeof topicConceptsForExam>;
  studiedIds: Set<number>;
  current: number | null;
}) {
  const concepts = conceptsByTopic.get(t.id) ?? [];
  const isCurrent = t.position === current;
  const studied = studiedIds.has(t.id);
  const mastery = average(concepts.map((c) => c.mastery));
  return (
    <li>
      <Link
        href={`/exams/${examId}/study?topic=${t.position}`}
        className={`flex flex-col gap-2 rounded-[18px] p-3.5 transition-colors ${isCurrent ? "bg-hero text-hero-foreground" : "bg-card hover:bg-muted-strong"}`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[13px] font-extrabold ${
              studied ? "bg-mint text-on-mint" : isCurrent ? "bg-white/15" : "bg-muted"
            }`}
          >
            {studied ? (
              <>
                <Icon d={ICONS.check} size={15} />
                <span className="sr-only">Section {n}, studied:</span>
              </>
            ) : (
              n
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="leading-snug font-bold break-words">
              {t.title}
              {t.emphasized ? <span className={isCurrent ? "text-hero-accent-2" : "text-warning"} title="You emphasized this"> ★</span> : null}
            </div>
            <div className={`text-[13px] font-medium ${isCurrent ? "text-hero-muted" : "text-muted-foreground"}`}>
              {(JSON.parse(t.page_ids) as number[]).length} slides{isCurrent ? " · you're here" : ""}
            </div>
          </div>
          <MasteryChip value={mastery} className="shrink-0" />
        </div>
        {concepts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {concepts.map((c) => (
              <span
                key={c.id}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-[10px] py-0.5 pr-2 pl-0.5 text-[12px] font-semibold ${isCurrent ? "bg-white/10" : "bg-muted text-foreground"}`}
                title={c.earlier_exams.length ? `Also in: ${c.earlier_exams.join(", ")}` : "New for this exam"}
              >
                <MasteryChip value={c.mastery} className="px-1.5 py-0 text-[11px]" />
                <span className="min-w-0 break-words">{c.name}</span>
                {c.earlier_exams.length > 0 && " ↺"}
              </span>
            ))}
          </div>
        )}
        <span className={`flex items-center gap-1 self-end text-[13px] font-extrabold ${isCurrent ? "text-hero-accent" : "text-primary"}`}>
          Study this <Icon d={ICONS.arrowRight} size={15} />
        </span>
      </Link>
    </li>
  );
}
