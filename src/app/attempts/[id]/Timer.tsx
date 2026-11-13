"use client";
import { useEffect, useState } from "react";
import { utcMs } from "./useAttempt";

/** A timed exam's countdown; at 0:00 it finishes the exam for her, retrying if the connection dropped. */
export function Timer({ startedAt, limit, onExpire }: { startedAt: string; limit: number; onExpire: (quiet: boolean) => Promise<boolean> }) {
  const end = utcMs(startedAt) + limit * 1000;
  const [left, setLeft] = useState(() => Math.max(0, end - Date.now()));
  useEffect(() => {
    let gone = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    // Time's up: finish for her. A dropped connection is retried (5 s, 10 s, 20 s, then every 30 s) with only the
    // first failure shown, so the exam doesn't sit open at 0:00 waiting for her to notice.
    const expire = async () => {
      const ok = await onExpire(tries > 0);
      if (ok || gone) return;
      tries++;
      retry = setTimeout(() => void expire(), Math.min(30_000, 5000 * 2 ** (tries - 1)));
    };
    const t = setInterval(() => {
      const l = Math.max(0, end - Date.now());
      setLeft(l);
      if (l === 0) {
        clearInterval(t);
        void expire();
      }
    }, 1000);
    return () => {
      gone = true;
      clearInterval(t);
      clearTimeout(retry);
    };
  }, [end, onExpire]);
  const s = Math.floor(left / 1000);
  return (
    <span className={`flex h-11 items-center rounded-xl px-3 font-mono text-sm font-bold ${s < 120 ? "bg-coral text-on-coral" : "bg-butter text-on-butter"}`}>
      ⏱ {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}
