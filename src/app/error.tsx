"use client"; // Error boundaries must be client components.
import Link from "next/link";
import { useEffect } from "react";

/**
 * Shown in place of a page that failed to load or crashed. The nav bar stays, the technical detail goes to the
 * browser console only, and she gets a plain way to try again or go home. Nothing here may touch the database.
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto mt-6 flex max-w-lg flex-col gap-3">
      <section className="card flex flex-col gap-3" role="alert">
        <h1 className="section-title">This page didn&apos;t load.</h1>
        <p className="text-[15px] text-muted-foreground">
          Something went wrong on our side, or the connection dropped. Your work is saved. Try again, or go back to your exams.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary btn-sm" onClick={() => retry()}>
            Try again
          </button>
          <Link href="/" className="btn-secondary btn-sm">
            Back to my exams
          </Link>
        </div>
      </section>
    </div>
  );
}
