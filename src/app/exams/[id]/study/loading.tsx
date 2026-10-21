/** Study page skeleton: topic list (desktop), topic hero + lesson shimmer, and the tutor column (desktop). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-2.5 sm:gap-4" aria-busy="true">
      <span role="status" className="sr-only">
        Opening your study session…
      </span>
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="shimmer h-6 w-40 bg-muted-strong" />
        <div className="shimmer h-[38px] w-28 rounded-xl bg-muted-strong" />
      </div>
      <div className="shimmer h-2 w-full rounded-full lg:hidden bg-muted-strong" />

      <div className="grid grid-cols-1 gap-2.5 sm:gap-4 lg:grid-cols-[240px_minmax(0,1fr)_380px]">
        <div className="card hidden flex-col gap-2 p-2.5 lg:flex">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="shimmer h-10 w-full rounded-[16px]" />
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          <section className="card-hero flex flex-col gap-3">
            <div className="shimmer h-4 w-28 bg-white/15" />
            <div className="shimmer h-9 w-4/5 bg-white/15" />
          </section>
          <section className="card flex flex-col gap-3">
            <div className="shimmer h-4 w-11/12" />
            <div className="shimmer h-4 w-10/12" />
            <div className="shimmer h-4 w-9/12" />
            <div className="shimmer h-40 w-full" />
          </section>
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <div className="shimmer h-[54px] rounded-[18px] bg-muted-strong" />
            <div className="shimmer h-[54px] rounded-[18px] bg-muted-strong" />
          </div>
        </div>

        <div className="hidden h-[calc(100vh-2rem)] rounded-[28px] bg-nav lg:block" />
      </div>
    </div>
  );
}
