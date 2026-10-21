/** Shown at once on every tap into a page without its own skeleton; shaped like Home (hero, three tiles, Today, Exams). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-2.5 sm:gap-4" aria-busy="true">
      <span role="status" className="sr-only">
        Loading…
      </span>
      <div className="grid gap-2.5 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="card-hero flex flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <div className="shimmer h-9 w-1/2 bg-white/15 sm:h-12" />
            <div className="shimmer h-9 w-5/6 bg-white/15 sm:h-12" />
          </div>
          <div className="flex items-center gap-[18px]">
            <div className="shimmer h-24 w-24 shrink-0 rounded-full bg-white/15" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="shimmer h-4 w-3/4 bg-white/15" />
              <div className="shimmer h-4 w-1/2 bg-white/15" />
            </div>
          </div>
          <div className="shimmer h-[54px] w-full rounded-[18px] bg-white/15" />
        </section>
        <div className="grid grid-cols-3 gap-2.5 lg:grid-cols-1 lg:gap-4">
          <div className="tile shimmer h-28 rounded-[26px]" />
          <div className="tile shimmer h-28 rounded-[26px]" />
          <div className="tile shimmer h-28 rounded-[26px]" />
        </div>
      </div>
      <div className="grid gap-2.5 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-2.5 sm:gap-4">
          <section className="card flex flex-col gap-3">
            <div className="shimmer h-7 w-28" />
            <div className="shimmer h-14 w-full" />
            <div className="shimmer h-14 w-full" />
          </section>
          <div className="shimmer h-[118px] w-full rounded-[28px]" />
          <div className="shimmer h-[118px] w-full rounded-[28px]" />
        </div>
        <aside className="card flex flex-col gap-3">
          <div className="shimmer h-7 w-32" />
          <div className="shimmer h-[50px] w-full" />
          <div className="shimmer h-[50px] w-full" />
          <div className="shimmer h-[54px] w-full rounded-[18px]" />
        </aside>
      </div>
    </div>
  );
}
