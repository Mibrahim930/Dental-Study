"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "./Toaster";
import { ServerMessage, failureText, jsonOf, signedOut } from "./clientFetch";

/**
 * Button that POSTs to an API route, then refreshes the page. `body` is sent as JSON when given; `confirm` asks first
 * (for actions that cost money or replace something she has), and nothing is sent if she says no.
 */
export function ActionButton({
  url,
  label,
  className = "btn-secondary",
  body,
  confirm,
}: {
  url: string;
  label: string;
  className?: string;
  body?: object;
  confirm?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method: "POST" });
          if (signedOut(res)) return;
          if (!res.ok) {
            const json = await jsonOf<{ error?: string }>(res);
            throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
          }
          router.refresh();
        } catch (err) {
          toast(failureText(err, "That didn't go through. Check your connection and try again."), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}
