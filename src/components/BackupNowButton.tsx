"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { jsonOf, signedOut } from "./clientFetch";

export function BackupNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <div className="flex items-center gap-3">
      <button
        className="btn-secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg("");
          try {
            const res = await fetch("/api/admin/backup", { method: "POST" });
            if (signedOut(res)) return;
            const json = await jsonOf<{ ok?: boolean; message?: string }>(res);
            // Admin only: the backup's own message is kept, since the owner needs it to fix the backup settings.
            setMsg(json?.ok ? "Backup complete." : `Backup failed${typeof json?.message === "string" && json.message ? `: ${json.message}` : ". Try again in a minute."}`);
            router.refresh();
          } catch {
            setMsg("Couldn't reach the site. Check your connection and try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Backing up…" : "Back up now"}
      </button>
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
    </div>
  );
}
