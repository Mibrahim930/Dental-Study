import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { QuizMe } from "@/components/QuizMe";
import { requireUser } from "@/lib/user";
import { Icon, ICONS } from "@/components/ui";
import { loadExamPage } from "@/lib/examPage";
import { EditExamMenu } from "@/components/exam/EditExamMenu";
import { ExamHero } from "@/components/exam/ExamHero";
import { StudyCard } from "@/components/exam/StudyCard";
import { LecturesSection } from "@/components/exam/LecturesSection";
import { PracticeSection } from "@/components/exam/PracticeSection";

export const dynamic = "force-dynamic";

export default async function ExamPage(props: PageProps<"/exams/[id]">) {
  const user = await requireUser();
  const id = Number((await props.params).id);
  const data = loadExamPage(user.id, id);
  if (!data) notFound();
  const { exam, processing, refreshMs } = data;

  return (
    <div className="flex flex-col gap-2.5 sm:gap-4">
      <AutoRefresh active={processing} ms={refreshMs} />
      {/* The panel the lecture review opens in (no text-selection pill here: nothing on this page to be quizzed on). */}
      <QuizMe examId={exam.id} selection={false} />
      <div className="flex items-center justify-between gap-3 px-1">
        <Link href="/" className="flex items-center gap-1.5 text-[15px] font-bold text-muted-foreground hover:text-foreground">
          <Icon d={ICONS.arrowLeft} size={18} /> All exams
        </Link>
        <EditExamMenu exam={exam} />
      </div>

      {/* Hero in the exam's type colour, with mastery (outer) and topics studied (inner). */}
      <ExamHero data={data} />

      <div className="grid gap-2.5 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          {/* Teal study card */}
          <StudyCard data={data} />

          {/* Lectures: upload, then each lecture's sections (its topic map), with progress. */}
          <LecturesSection data={data} />
        </div>

        <div className="flex flex-col gap-2.5 sm:gap-4">
          {/* Practice */}
          <PracticeSection data={data} focusWeak={!!user.focus_weak} />
        </div>
      </div>
    </div>
  );
}
