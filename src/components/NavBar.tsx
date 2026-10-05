"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; icon: React.ReactNode; match: (p: string) => boolean };

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
    <path d={d} />
  </svg>
);

const MAIN: Item[] = [
  {
    href: "/",
    label: "Exams",
    icon: icon("M4 19.5V5a2 2 0 0 1 2-2h14v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H20v-5"),
    match: (p) => p === "/" || p.startsWith("/exams") || p.startsWith("/attempts"),
  },
  {
    href: "/calendar",
    label: "Calendar",
    icon: icon("M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"),
    match: (p) => p.startsWith("/calendar"),
  },
  {
    href: "/review",
    label: "Review",
    icon: icon("M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"),
    match: (p) => p.startsWith("/review"),
  },
  {
    href: "/progress",
    label: "Progress",
    icon: icon("M3 3v18h18M7 15l4-4 3 3 6-6"),
    match: (p) => p.startsWith("/progress"),
  },
  {
    href: "/classes",
    label: "Classes",
    icon: icon("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"),
    match: (p) => p.startsWith("/classes"),
  },
];

const SETTINGS: Item = {
  href: "/settings",
  label: "Settings",
  icon: icon("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"),
  match: (p) => p.startsWith("/settings") || p.startsWith("/help"),
};

const ADMIN: Item = {
  href: "/admin",
  label: "Admin",
  icon: icon("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"),
  match: (p) => p.startsWith("/admin"),
};

/** Top bar on wide screens; on phones a slim top bar plus a tab bar along the bottom. */
export function NavBar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const extra = isAdmin ? [ADMIN, SETTINGS] : [SETTINGS];

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-border bg-card/85 backdrop-blur">
        <nav className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-4 text-sm">
          <Link href="/" className="mr-4 flex shrink-0 items-center gap-2 text-base font-semibold tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-soft text-sm" aria-hidden>🦷</span>
            Dental Study
          </Link>
          <div className="hidden items-center gap-1 sm:flex">
            {MAIN.map((item) => (
              <TopLink key={item.href} item={item} active={item.match(pathname)} />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {extra.map((item) => (
              <TopLink key={item.href} item={item} active={item.match(pathname)} iconOnlyOnPhone />
            ))}
          </div>
        </nav>
      </header>

      <nav
        className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
        aria-label="Main"
      >
        <div className="grid grid-cols-5">
          {MAIN.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active ? "text-primary" : "text-muted-foreground"}`}
              >
                {item.icon}
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

function TopLink({ item, active, iconOnlyOnPhone }: { item: Item; active: boolean; iconOnlyOnPhone?: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={iconOnlyOnPhone ? item.label : undefined}
      className={`flex items-center gap-2 rounded-lg px-3 py-1.5 font-medium transition-colors ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {iconOnlyOnPhone ? <span className="sm:hidden">{item.icon}</span> : null}
      <span className={iconOnlyOnPhone ? "hidden sm:inline" : undefined}>{item.label}</span>
    </Link>
  );
}
