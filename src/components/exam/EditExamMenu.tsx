import { setArchived, updateExam } from "@/app/actions";
import type { Exam } from "@/lib/db";

/** The exam page's "Edit exam" menu: name, course, date and type, and Archive / Unarchive. */
export function EditExamMenu({ exam }: { exam: Exam }) {
  const id = exam.id;
  return (
    <details className="relative">
      <summary className="btn-secondary btn-sm cursor-pointer list-none">Edit exam</summary>
      <div className="card absolute right-0 z-20 mt-2 w-80 space-y-3 shadow-[0_12px_36px_rgba(22,22,22,.16)]">
        <form action={updateExam.bind(null, id)} className="space-y-2.5">
          <input name="name" defaultValue={exam.name} className="input" aria-label="Exam name" required />
          <input name="course" defaultValue={exam.course ?? ""} placeholder="Course" aria-label="Course" className="input" />
          <input name="exam_date" type="date" defaultValue={exam.exam_date ?? ""} aria-label="Exam date" className="input" />
          <select name="kind" defaultValue={exam.kind} aria-label="Exam type" className="input">
            <option value="block">Block exam</option>
            <option value="quiz">Quiz</option>
            <option value="practical">Practical</option>
            <option value="board">Board exam (e.g. INBDE)</option>
            <option value="other">Other</option>
          </select>
          <button className="btn-primary w-full">Save</button>
        </form>
        <form action={setArchived.bind(null, id, exam.status !== "archived")}>
          <button className="btn-secondary w-full">{exam.status === "archived" ? "Unarchive" : "Archive exam"}</button>
        </form>
      </div>
    </details>
  );
}
