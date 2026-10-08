/** Logo and tagline shown above the sign-in and setup cards, where there is no nav bar. */
export function Brand() {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-2xl" aria-hidden>
        🦷
      </span>
      <div className="mt-3 text-xl font-semibold tracking-tight">Lolo&apos;s Study Buddy</div>
      <p className="mt-1 text-sm text-muted-foreground">Learn your own lectures, one slide at a time.</p>
    </div>
  );
}
