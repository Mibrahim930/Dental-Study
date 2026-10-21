/** Calendar skeleton: title + Year/Month switch, twelve month cards, and the day / planner cards on the side. */
export default function Loading() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]" aria-busy="true">
      <span role="status" className="sr-only">
        Loading the calendar…
      </span>
      <section className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="shimmer h-10 w-48 bg-muted-strong" />
          <div className="shimmer h-9 w-32 rounded-lg bg-muted-strong" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-4 xl:grid-cols-3">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="card flex flex-col gap-2 p-2.5 sm:p-3.5">
              <div className="shimmer h-4 w-20" />
              <div className="shimmer aspect-[7/6] w-full rounded-lg" />
            </div>
          ))}
        </div>
      </section>
      <aside className="space-y-4">
        <section className="card space-y-3">
          <div className="shimmer h-7 w-40" />
          <div className="shimmer h-14 w-full" />
          <div className="shimmer h-[50px] w-full" />
        </section>
        <section className="card space-y-3">
          <div className="shimmer h-7 w-36" />
          <div className="shimmer h-4 w-full" />
          <div className="shimmer h-4 w-5/6" />
          <div className="shimmer h-[50px] w-full" />
        </section>
      </aside>
    </div>
  );
}
