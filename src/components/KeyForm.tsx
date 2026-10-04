"use client";
import Link from "next/link";
import { useState } from "react";

type Provider = "anthropic" | "openai";

export function KeyForm({ initialProvider, done }: { initialProvider?: Provider | null; done: string }) {
  const [provider, setProvider] = useState<Provider>(initialProvider ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/account/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, apiKey }),
    });
    setBusy(false);
    if (res.ok) {
       
      window.location.assign(done);
    } else setError((await res.json()).error ?? "Couldn't save that key.");
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div>
        <div className="label">AI provider</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["anthropic", "Claude", "by Anthropic · key starts with sk-ant-"],
              ["openai", "ChatGPT", "by OpenAI · key starts with sk-"],
            ] as const
          ).map(([value, name, hint]) => (
            <label
              key={value}
              className={`cursor-pointer rounded-lg border p-3 ${provider === value ? "border-teal-600 bg-teal-50" : "border-slate-300 bg-white"}`}
            >
              <input type="radio" name="provider" className="sr-only" checked={provider === value} onChange={() => setProvider(value)} />
              <div className="font-medium">{name}</div>
              <div className="text-xs text-slate-500">{hint}</div>
            </label>
          ))}
        </div>
      </div>
      <div>
        <label className="label" htmlFor="apiKey">API key</label>
        <input
          id="apiKey"
          type="password"
          autoComplete="off"
          className="input font-mono"
          placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <p className="mt-1 text-xs text-slate-500">
          Your key is encrypted and only used for your own studying. AI usage is billed to your account with {provider === "anthropic" ? "Anthropic" : "OpenAI"}.
        </p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary w-full" disabled={busy || !apiKey.trim()}>
        {busy ? "Checking key…" : "Save and continue"}
      </button>
      <p className="text-center text-sm">
        <Link href="/help/api-keys" className="text-teal-700 underline" target="_blank">
          How do I get an API key? (step-by-step for Claude and ChatGPT)
        </Link>
      </p>
    </form>
  );
}
