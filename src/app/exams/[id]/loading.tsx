/** Exam page skeleton: back link, coloured hero, study card + topic map on the left, practice + lectures on the right. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-2.5 sm:gap-4" aria-busy="true">
      <span role="status" className="sr-only">
        Loading the exam…
      </span>
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="shimmer h-6 w-24 bg-muted-strong" />
        <div className="shimmer h-[38px] w-24 rounded-xl bg-muted-strong" />
      </div>

      {/* bg-card: the page background is the muted colour, so a muted block would vanish in light themes. */}
      <section className="flex flex-col gap-5 rounded-[32px] border border-[var(--card-border)] bg-card p-6 sm:flex-row sm:items-center sm:justify-between sm:rounded-[36px] sm:p-8">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="shimmer h-4 w-28" />
          <div className="shimmer h-10 w-3/4 sm:h-12" />
          <div className="shimmer h-4 w-40" />
        </div>
        <div className="shimmer h-28 w-28 shrink-0 rounded-full" />
      </section>

      <div className="grid gap-2.5 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          <section className="card-hero flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="shimmer h-4 w-24 bg-white/15" />
              <div className="shimmer h-8 w-4/5 bg-white/15" />
            </div>
            <div className="shimmer h-[54px] w-full rounded-[18px] bg-white/15 sm:w-48" />
          </section>
          <section className="card flex flex-col gap-3">
            <div className="shimmer h-7 w-32" />
            <div className="grid gap-2.5 sm:grid-cols-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-start gap-3 rounded-[22px] bg-muted p-4">
                  <div className="shimmer h-8 w-8 shrink-0 rounded-[10px] bg-card" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="shimmer h-4 w-5/6 bg-muted-strong" />
                    <div className="shimmer h-3 w-1/3 bg-muted-strong" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
        <div className="flex flex-col gap-2.5 sm:gap-4">
          <section className="card flex flex-col gap-3">
            <div className="shimmer h-7 w-40" />
            <div className="shimmer h-[46px] w-full rounded-[14px]" />
            <div className="shimmer h-[46px] w-full rounded-[14px]" />
            <div className="shimmer h-[54px] w-full rounded-[18px]" />
          </section>
          <section className="card flex flex-col gap-3">
            <div className="shimmer h-7 w-28" />
            <div className="shimmer h-24 w-full rounded-[20px]" />
            <div className="shimmer h-16 w-full rounded-[20px]" />
          </section>
        </div>
      </div>
    </div>
  );
}
