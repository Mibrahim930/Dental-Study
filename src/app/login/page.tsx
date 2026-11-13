"use client";
import { useState } from "react";
import { Brand } from "@/components/Brand";
import { ServerMessage, failureText, jsonOf } from "@/components/clientFetch";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (res.status === 401) throw new ServerMessage("That passcode didn't work.");
      if (!res.ok) {
        const json = await jsonOf<{ error?: string }>(res);
        throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      }
      // Full page load: client-side navigation could reuse a cached "redirect to /login" from before sign-in.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/account");
    } catch (err) {
      setError(failureText(err, "Couldn't reach the site. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-8 sm:mt-14 max-w-sm">
      <Brand />
      <form onSubmit={submit} className="card space-y-4">
        <h1 className="section-title">Sign in</h1>
        <div>
          <label className="label" htmlFor="passcode">Passcode</label>
          <input id="passcode" type="password" className="input" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || !passcode}>Continue</button>
      </form>
    </div>
  );
}
