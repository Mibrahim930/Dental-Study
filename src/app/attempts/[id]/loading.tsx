/** Practice exam skeleton: back link + Finish, title, question number strip, a question card and Back/Next. */
export default function Loading() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2.5 sm:gap-3" aria-busy="true">
      <span role="status" className="sr-only">
        Loading the practice exam…
      </span>
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="shimmer h-6 w-36 bg-muted-strong" />
        <div className="shimmer h-[38px] w-28 rounded-xl bg-muted-strong" />
      </div>
      <div className="px-1">
        <div className="shimmer h-8 w-64 max-w-full bg-muted-strong" />
      </div>
      <div className="flex flex-wrap gap-1.5 px-1">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
          <div key={i} className="shimmer h-9 w-9 rounded-[11px] bg-muted-strong" />
        ))}
      </div>
      <section className="card flex flex-col gap-3">
        <div className="shimmer h-4 w-32" />
        <div className="shimmer h-5 w-full" />
        <div className="shimmer h-5 w-4/5" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="shimmer h-14 w-full" />
        ))}
      </section>
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <div className="shimmer h-[54px] rounded-[18px] bg-muted-strong" />
        <div className="shimmer h-[54px] rounded-[18px] bg-muted-strong" />
      </div>
    </div>
  );
}
