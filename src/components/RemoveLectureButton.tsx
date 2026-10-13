"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "./Toaster";

/** Remove a lecture (or cancel one still being read), with an inline "are you sure?" step. */
export function RemoveLectureButton({ docId, name, reading }: { docId: number; name: string; reading: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    const res = await fetch(`/api/documents/${docId}`, { method: "DELETE" });
    setBusy(false);
    setConfirming(false);
    if (!res.ok) return toast("Couldn't remove that lecture. Try again.", "error");
    toast(reading ? "Stopped and removed" : "Lecture removed");
    router.refresh();
  }

  if (!confirming) {
    return (
      <button type="button" className="btn-ghost btn-sm min-h-8 px-2 text-[13px]" onClick={() => setConfirming(true)}>
        {reading ? "Cancel" : "Remove"}
      </button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 rounded-2xl bg-card p-3 text-sm">
      <p className="font-semibold">
        {reading ? "Stop reading and remove" : "Remove"} “{name}”?
      </p>
      <p className="text-[13px] text-muted-foreground">
        Its slides leave the topic map. Questions you&apos;ve already answered stay in your history but won&apos;t come back.
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={remove}>
          {busy ? "Removing…" : reading ? "Yes, stop it" : "Yes, remove"}
        </button>
        <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
    </div>
  );
}
