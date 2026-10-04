"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
        await fetch(url, { method: "POST" });
        setBusy(false);
        router.refresh();
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}
