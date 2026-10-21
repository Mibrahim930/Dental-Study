/** Plain page skeleton (title + two cards) for pages that don't look like Home: Progress, Review, Classes, Settings… */
export function PageSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 sm:gap-4" aria-busy="true">
      <span role="status" className="sr-only">
        {label}
      </span>
      <div className="shimmer h-10 w-56 max-w-full bg-muted-strong sm:h-12" />
      <section className="card flex flex-col gap-3">
        <div className="shimmer h-7 w-40" />
        <div className="shimmer h-4 w-full" />
        <div className="shimmer h-4 w-5/6" />
        <div className="shimmer h-14 w-full" />
      </section>
      <section className="card flex flex-col gap-3">
        <div className="shimmer h-7 w-32" />
        <div className="shimmer h-14 w-full" />
        <div className="shimmer h-14 w-full" />
      </section>
    </div>
  );
}
