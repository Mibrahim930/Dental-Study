"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AdminUserActions({ userId, email, isSelf }: { userId: number; email: string; isSelf: boolean }) {
  const router = useRouter();
  const [temp, setTemp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reset() {
    if (!window.confirm(`Reset the password for ${email}? They'll need the temporary password to sign in.`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/users/${userId}/reset-password`, { method: "POST" });
    setBusy(false);
    if (res.ok) setTemp((await res.json()).tempPassword);
  }

  async function remove() {
    const typed = window.prompt(`This permanently deletes ${email} and all their exams, lectures and progress.\n\nType the email to confirm:`);
    if (typed?.trim().toLowerCase() !== email.toLowerCase()) return;
    setBusy(true);
    const res = await fetch(`/api/admin/users/${userId}/delete`, { method: "POST" });
    setBusy(false);
    if (!res.ok) window.alert((await res.json()).error ?? "Couldn't remove the account.");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button className="btn-secondary px-3 py-1" onClick={reset} disabled={busy}>Reset password</button>
        {!isSelf && (
          <button className="btn px-3 py-1 text-rose-700 hover:bg-rose-50" onClick={remove} disabled={busy}>Remove</button>
        )}
      </div>
      {temp && (
        <p className="text-xs text-slate-700">
          Temporary password: <code className="rounded bg-amber-100 px-1 font-mono text-sm">{temp}</code>. Give it to them privately. It&apos;s shown only once.
        </p>
      )}
    </div>
  );
}
