import { Logo } from "./ui";

/** Logo and tagline shown above the sign-in and setup cards, where there is no nav bar. */
export function Brand() {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      <Logo size={64} />
      <div className="mt-4 text-[28px] leading-none font-extrabold tracking-[-0.03em]">Lolo&apos;s Study Buddy</div>
      <p className="mt-2 text-[15px] text-muted-foreground">Learn your own lectures, one slide at a time.</p>
    </div>
  );
}
