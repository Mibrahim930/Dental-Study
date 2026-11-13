"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ServerMessage, failureText, jsonOf, signedOut } from "./clientFetch";

export function AdminUserActions({ userId, email, isSelf }: { userId: number; email: string; isSelf: boolean }) {
  const router = useRouter();
  const [temp, setTemp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reset() {
    if (!window.confirm(`Reset the password for ${email}? They'll need the temporary password to sign in.`)) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-password`, { method: "POST" });
      if (signedOut(res)) return;
      const json = await jsonOf<{ tempPassword?: string; error?: string }>(res);
      if (!res.ok || typeof json?.tempPassword !== "string") throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      setTemp(json.tempPassword);
    } catch (err) {
      setError(failureText(err, "Couldn't reset the password. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const typed = window.prompt(`This permanently deletes ${email} and all their exams, lectures and progress.\n\nType the email to confirm:`);
    if (typed?.trim().toLowerCase() !== email.toLowerCase()) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${userId}/delete`, { method: "POST" });
      if (signedOut(res)) return;
      if (!res.ok) {
        const json = await jsonOf<{ error?: string }>(res);
        throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      }
      router.refresh();
    } catch (err) {
      setError(failureText(err, "Couldn't remove the account. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button className="btn-secondary px-3 py-1" onClick={reset} disabled={busy}>Reset password</button>
        {!isSelf && (
          <button className="btn px-3 py-1 text-danger hover:bg-danger-soft" onClick={remove} disabled={busy}>Remove</button>
        )}
      </div>
      {error && (
        <p className="text-xs font-semibold text-danger" role="alert">
          {error}
        </p>
      )}
      {temp && (
        <p className="text-xs text-foreground">
          Temporary password: <code className="rounded bg-warning-soft px-1 font-mono text-sm">{temp}</code>. Give it to them privately. It&apos;s shown only once.
        </p>
      )}
    </div>
  );
}
