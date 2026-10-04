"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
          const res = await fetch("/api/admin/backup", { method: "POST" });
          const json = await res.json();
          setBusy(false);
          setMsg(json.ok ? "Backup complete." : `Backup failed: ${json.message}`);
          router.refresh();
        }}
      >
        {busy ? "Backing up…" : "Back up now"}
      </button>
      {msg && <span className="text-sm text-slate-600">{msg}</span>}
    </div>
  );
}
