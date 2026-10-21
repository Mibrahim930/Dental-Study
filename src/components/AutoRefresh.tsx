"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the server page every `ms` while background work is running. Paused while the tab is hidden (nobody is
 * looking, and a slide batch can run for an hour); when the tab comes back it refreshes once at once, then resumes.
 */
export function AutoRefresh({ active, ms = 4000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (!timer) timer = setInterval(() => router.refresh(), ms);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        router.refresh();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, ms, router]);
  return null;
}
