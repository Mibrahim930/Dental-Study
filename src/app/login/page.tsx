"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    setBusy(false);
    if (res.ok) {
      router.push("/");
      router.refresh();
    }
    else setError("That passcode didn't work.");
  }

  return (
    <div className="mx-auto mt-20 max-w-sm">
      <form onSubmit={submit} className="card space-y-4">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <div>
          <label className="label" htmlFor="passcode">Passcode</label>
          <input id="passcode" type="password" className="input" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || !passcode}>Continue</button>
      </form>
    </div>
  );
}
