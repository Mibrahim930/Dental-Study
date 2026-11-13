import Link from "next/link";

/** Shown for an address that doesn't exist, or an exam, lecture or practice exam that isn't hers or was removed. */
export default function NotFound() {
  return (
    <div className="mx-auto mt-6 flex max-w-lg flex-col gap-3">
      <section className="card flex flex-col gap-3">
        <h1 className="section-title">We couldn&apos;t find that page.</h1>
        <p className="text-[15px] text-muted-foreground">It may have been removed, or the link is wrong.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/" className="btn-primary btn-sm">
            Back to my exams
          </Link>
        </div>
      </section>
    </div>
  );
}
