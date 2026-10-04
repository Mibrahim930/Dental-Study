"use client";
import { useState } from "react";

export default function ChangePasswordPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, next }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "Couldn't change your password.");
    window.location.assign(json.hasKey ? "/" : "/setup");
  }

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <form onSubmit={submit} className="card space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Choose a new password</h1>
          <p className="mt-1 text-sm text-slate-600">If an admin reset your password, enter the temporary one they gave you as your current password.</p>
        </div>
        <div>
          <label className="label" htmlFor="current">Current (or temporary) password</label>
          <input id="current" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="next">New password</label>
          <input id="next" type="password" autoComplete="new-password" minLength={8} className="input" value={next} onChange={(e) => setNext(e.target.value)} required />
          <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>Save new password</button>
      </form>
    </div>
  );
}
