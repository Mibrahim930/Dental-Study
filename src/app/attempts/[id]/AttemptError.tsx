import Link from "next/link";
import type { AttemptView } from "@/lib/attemptView";
import { friendlyError, needsKeyFix } from "@/components/friendlyError";

/** The exam couldn't be written: why, and where to go (Settings when it was her AI key). */
export function AttemptError({ attempt }: { attempt: AttemptView["attempt"] }) {
  const keyProblem = needsKeyFix(attempt.error);
  return (
    <div className="mx-auto mt-6 flex max-w-lg flex-col gap-3">
      <section className="tile cb-coral flex flex-col gap-3 rounded-[28px]">
        <div className="text-[22px] font-extrabold tracking-tight">{keyProblem ? "Your AI key needs attention." : "Couldn't write this exam."}</div>
        <p className="text-[15px] font-medium break-words">{friendlyError(attempt.error, "Something went wrong while writing it. Start a new one from the exam page.")}</p>
        <div className="flex flex-wrap gap-2">
          {keyProblem ? (
            <>
              <Link href="/settings" className="btn-primary btn-sm">Update key</Link>
              <Link href="/help/api-keys" className="btn-ghost btn-sm text-on-coral">How to fix</Link>
            </>
          ) : (
            <Link href={`/exams/${attempt.exam_id}`} className="btn-primary btn-sm">Back to exam</Link>
          )}
        </div>
      </section>
    </div>
  );
}
