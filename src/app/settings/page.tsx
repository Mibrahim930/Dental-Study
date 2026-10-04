import { db } from "@/lib/db";
import { requireUser } from "@/lib/user";
import { MODELS } from "@/lib/ai";
import { KeyForm } from "@/components/KeyForm";
import { SignOutButton } from "@/components/SignOutButton";

export const dynamic = "force-dynamic";

const usd = (n: number) => (n < 0.01 && n > 0 ? "< $0.01" : `$${n.toFixed(2)}`);

export default async function SettingsPage() {
  const user = await requireUser();
  const total = (sql: string) => (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) c FROM ai_usage WHERE user_id = ? ${sql}`).get(user.id) as { c: number }).c;
  const month = total("AND created_at >= date('now', 'start of month')");
  const allTime = total("");
  const byPurpose = db
    .prepare(
      `SELECT purpose, SUM(cost_usd) cost, COUNT(*) calls FROM ai_usage WHERE user_id = ? AND created_at >= date('now', 'start of month')
       GROUP BY purpose ORDER BY cost DESC`,
    )
    .all(user.id) as { purpose: string; cost: number; calls: number }[];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="card space-y-3">
        <h2 className="font-semibold">Spending</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-slate-500">This month</div>
            <div className="text-2xl font-semibold">{usd(month)}</div>
          </div>
          <div>
            <div className="text-sm text-slate-500">All time</div>
            <div className="text-2xl font-semibold">{usd(allTime)}</div>
          </div>
        </div>
        {byPurpose.length > 0 && (
          <ul className="divide-y divide-slate-100 text-sm">
            {byPurpose.map((p) => (
              <li key={p.purpose} className="flex justify-between py-1.5">
                <span className="capitalize">{p.purpose} <span className="text-slate-400">· {p.calls} call{p.calls === 1 ? "" : "s"}</span></span>
                <span>{usd(p.cost)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">
          Estimated from token counts. Your {user.provider === "openai" ? "OpenAI" : "Anthropic"} billing page has the exact amount.
        </p>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">AI provider and key</h2>
        <p className="text-sm text-slate-600">
          Using <strong>{user.provider === "openai" ? "ChatGPT" : "Claude"}</strong> ({MODELS[user.provider ?? "anthropic"]}) with the key ending in{" "}
          <code className="rounded bg-slate-100 px-1">…{user.api_key_last4}</code>.
        </p>
        <details>
          <summary className="cursor-pointer text-sm font-medium text-teal-700">Replace key or switch provider</summary>
          <div className="mt-3">
            <KeyForm initialProvider={user.provider} done="/settings" />
          </div>
        </details>
      </section>

      <section className="card flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Account</h2>
          <p className="text-sm text-slate-600">{user.email}</p>
        </div>
        <SignOutButton />
      </section>
    </div>
  );
}
