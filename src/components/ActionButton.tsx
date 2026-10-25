"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "./Toaster";

/** Button that POSTs to an API route, then refreshes the page. */
export function ActionButton({ url, label, className = "btn-secondary" }: { url: string; label: string; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(url, { method: "POST" });
          if (!res.ok) throw new Error(String(res.status));
          router.refresh();
        } catch {
          toast("That didn't go through. Check your connection and try again.", "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}
