"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, ICONS, Logo } from "./ui";

type Item = { href: string; label: string; icon: string; match: (p: string) => boolean };

const MAIN: Item[] = [
  { href: "/", label: "Exams", icon: ICONS.book, match: (p) => p === "/" || p.startsWith("/exams") || p.startsWith("/attempts") },
  { href: "/calendar", label: "Calendar", icon: ICONS.calendar, match: (p) => p.startsWith("/calendar") },
  { href: "/review", label: "Review", icon: ICONS.review, match: (p) => p.startsWith("/review") },
  { href: "/progress", label: "Progress", icon: ICONS.progress, match: (p) => p.startsWith("/progress") },
  { href: "/classes", label: "Classes", icon: ICONS.classes, match: (p) => p.startsWith("/classes") },
];

const SETTINGS: Item = { href: "/settings", label: "Settings", icon: ICONS.settings, match: (p) => p.startsWith("/settings") || p.startsWith("/help") };
const ADMIN: Item = { href: "/admin", label: "Admin", icon: ICONS.shield, match: (p) => p.startsWith("/admin") };

/**
 * Desktop: logo lockup, a centred dark pill menu, Admin/Settings buttons on the right.
 * Phone: logo + date on top, and a floating dark pill tab bar at the bottom (Review shows how many are due).
 */
export function NavBar({ isAdmin, reviewsDue, dateLabel }: { isAdmin: boolean; reviewsDue: number; dateLabel: string }) {
  const pathname = usePathname();
  const extra = isAdmin ? [ADMIN, SETTINGS] : [SETTINGS];

  return (
    <>
      <header className="mx-auto flex w-full max-w-[1280px] items-center gap-3 px-3.5 pt-4 sm:px-8 sm:pt-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Lolo's Study Buddy home">
          <Logo size={40} />
          <span className="hidden text-[18px] font-extrabold tracking-[-0.02em] lg:inline">Lolo&apos;s Study Buddy</span>
          <span className="text-[15px] font-semibold sm:hidden">{dateLabel}</span>
        </Link>

        <nav className="mx-auto hidden items-center gap-1 rounded-[22px] bg-nav p-1.5 sm:flex" aria-label="Main">
          {MAIN.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center gap-2 rounded-2xl px-4 py-2.5 text-[15px] font-bold transition-colors ${
                  active ? "bg-mint text-on-mint" : "text-nav-foreground hover:text-white"
                }`}
              >
                {item.label}
                {item.href === "/review" && reviewsDue > 0 && <span className="rounded-full bg-butter px-1.5 text-[11px] font-extrabold text-on-butter">{reviewsDue}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
          {extra.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                className={`flex h-11 w-11 items-center justify-center gap-2 rounded-[14px] text-[15px] font-bold transition-colors xl:w-auto xl:px-4 ${
                  active ? "bg-action text-action-foreground" : "bg-card text-foreground hover:bg-muted-strong"
                }`}
              >
                <Icon d={item.icon} />
                <span className="hidden xl:inline">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </header>

      <nav
        className="fixed inset-x-3.5 bottom-[calc(18px+env(safe-area-inset-bottom))] z-30 grid h-[68px] grid-cols-5 rounded-[26px] bg-nav p-1.5 shadow-[0_12px_36px_rgba(22,22,22,.2)] sm:hidden"
        aria-label="Main"
      >
        {MAIN.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-0.5 rounded-[20px] text-[11px] font-extrabold ${
                active ? "bg-mint text-on-mint" : "text-nav-foreground"
              }`}
            >
              <Icon d={item.icon} />
              {item.label}
              {item.href === "/review" && reviewsDue > 0 && (
                <span className="absolute top-1 left-[calc(50%+6px)] flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-butter px-1 text-[11px] font-extrabold text-on-butter">
                  {reviewsDue > 99 ? "99+" : reviewsDue}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
