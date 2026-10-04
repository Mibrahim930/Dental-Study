"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

async function post(url: string, body?: object) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, json: await res.json().catch(() => ({})) };
}

export function ClassForms() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(url: string, body: object) {
    setBusy(true);
    setError("");
    const { ok, json } = await post(url, body);
    setBusy(false);
    if (!ok) return setError(json.error ?? "Something went wrong.");
    router.refresh();
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <form
        className="card space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run("/api/classes/join", { code: f.get("code") });
          e.currentTarget.reset();
        }}
      >
        <h2 className="font-semibold">Join a class</h2>
        <input name="code" className="input font-mono uppercase" placeholder="Invite code, e.g. K7M2QX9P" required />
        <button className="btn-primary w-full" disabled={busy}>Join</button>
      </form>
      <form
        className="card space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run("/api/classes", { name: f.get("name") });
          e.currentTarget.reset();
        }}
      >
        <h2 className="font-semibold">Start a class</h2>
        <input name="name" className="input" placeholder="e.g. Class of 2028" required />
        <button className="btn-secondary w-full" disabled={busy}>Create and get an invite code</button>
      </form>
      {error && <p className="text-sm text-red-600 sm:col-span-2">{error}</p>}
    </div>
  );
}

export function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-md bg-slate-100 px-2 py-1 font-mono text-sm tracking-wider hover:bg-slate-200"
      title="Copy invite code"
      onClick={async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
      }}
    >
      {code} {copied ? "✓" : "⧉"}
    </button>
  );
}

export function ShareExamForm({ classId, exams }: { classId: number; exams: { id: number; name: string }[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  if (exams.length === 0) return <p className="text-xs text-slate-500">Exams appear here to share once their topic map is ready.</p>;
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const { ok, json } = await post(`/api/classes/${classId}/share`, { examId: Number(f.get("examId")) });
        setError(ok ? "" : (json.error ?? "Couldn't share."));
        router.refresh();
      }}
    >
      <select name="examId" className="input w-auto flex-1">
        {exams.map((e) => (
          <option key={e.id} value={e.id}>{e.name}</option>
        ))}
      </select>
      <button className="btn-secondary">Share with class</button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

export function SharedExamAction({ sharedId, addedExamId, mine }: { sharedId: number; addedExamId: number | null; mine: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (mine)
    return (
      <button
        className="text-xs text-slate-500 underline hover:text-rose-700"
        onClick={async () => {
          await post(`/api/shared/${sharedId}/unshare`);
          router.refresh();
        }}
      >
        Stop sharing
      </button>
    );
  if (addedExamId) return <Link href={`/exams/${addedExamId}`} className="text-sm text-emerald-700 hover:underline">Added ✓ Open</Link>;
  return (
    <button
      className="btn-primary px-3 py-1"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const { ok, json } = await post(`/api/shared/${sharedId}/add`);
        if (ok) router.push(`/exams/${json.examId}`);
        else {
          setBusy(false);
          window.alert(json.error ?? "Couldn't add this exam.");
        }
      }}
    >
      {busy ? "Adding…" : "Add to my exams"}
    </button>
  );
}

export function LeaveClassButton({ classId, isOwner }: { classId: number; isOwner: boolean }) {
  const router = useRouter();
  return (
    <button
      className="text-xs text-slate-500 underline hover:text-rose-700"
      onClick={async () => {
        const msg = isOwner
          ? "Delete this class for everyone? Exams people already added stay in their accounts."
          : "Leave this class? Exams you already added stay in your account.";
        if (!window.confirm(msg)) return;
        await post(`/api/classes/${classId}/leave`);
        router.refresh();
      }}
    >
      {isOwner ? "Delete class" : "Leave class"}
    </button>
  );
}
