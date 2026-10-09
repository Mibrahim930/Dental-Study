"use client";
import { useEffect, useState } from "react";
import { Icon, ICONS } from "./ui";

type Toast = { id: number; message: string; kind: "success" | "error" };

/** Show a short message at the bottom of the screen (above the phone tab bar). One at a time, 4 seconds. */
export function toast(message: string, kind: Toast["kind"] = "success") {
  window.dispatchEvent(new CustomEvent("study-toast", { detail: { message, kind } }));
}

export function Toaster() {
  const [current, setCurrent] = useState<Toast | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onToast = (e: Event) => {
      const { message, kind } = (e as CustomEvent<Omit<Toast, "id">>).detail;
      clearTimeout(timer);
      setCurrent({ id: Date.now(), message, kind });
      timer = setTimeout(() => setCurrent(null), 4000);
    };
    window.addEventListener("study-toast", onToast);
    return () => {
      window.removeEventListener("study-toast", onToast);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center px-4 sm:inset-x-auto sm:right-6 sm:bottom-6">
      {current && (
        <div
          key={current.id}
          className={`pointer-events-auto flex min-h-14 items-center gap-3 rounded-[18px] px-4 py-3 text-[15px] font-bold shadow-[0_12px_36px_rgba(22,22,22,.16)] ${
            current.kind === "error" ? "bg-coral text-on-coral" : "bg-nav text-white"
          }`}
        >
          {current.kind === "success" ? (
            <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-mint text-on-mint">
              <Icon d={ICONS.check} size={16} />
            </span>
          ) : null}
          {current.message}
        </div>
      )}
    </div>
  );
}
