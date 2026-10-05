"use client";
import { useState } from "react";
import { Brand } from "@/components/Brand";

export default function AccountPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(`/api/account/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "Something went wrong.");
     
    window.location.assign(json.mustChangePassword ? "/account/password" : mode === "signup" || !json.hasKey ? "/setup" : "/");
  }

  return (
    <div className="mx-auto mt-8 sm:mt-14 max-w-sm">
      <Brand />
      <form onSubmit={submit} className="card space-y-4">
        <div className="flex rounded-lg bg-muted p-1 text-sm">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(""); }}
              className={`flex-1 rounded-md py-1.5 ${mode === m ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
            >
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === "signup" ? 8 : undefined}
            required
          />
          {mode === "signup" && <p className="mt-1 text-xs text-muted-foreground">At least 8 characters.</p>}
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
