import Link from "next/link";

export const metadata = { title: "How to get an API key · Dental Study" };

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{n}</span>
      <div className="text-sm leading-relaxed text-foreground">{children}</div>
    </li>
  );
}

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline">
    {children}
  </a>
);

export default function ApiKeyHelpPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/setup" className="text-sm text-muted-foreground hover:underline">← Back to setup</Link>
        <h1 className="mt-1 page-title">How to get an API key</h1>
        <p className="mt-1 text-muted-foreground">
          An API key lets Dental Study use Claude or ChatGPT on your behalf. You only need one, from either company. Setup takes about 5
          minutes.
        </p>
      </div>

      <div className="card border-warning/40 bg-warning-soft text-sm text-warning">
        <strong>Heads up:</strong> a Claude Pro or ChatGPT Plus subscription does <em>not</em> include API access. The API is a separate,
        pay-as-you-go account. It&apos;s cheap for studying: reading a typical exam&apos;s lectures (around 500 slides) costs roughly $3 with
        Claude or $5 with ChatGPT, once. Each practice exam or tutor question costs a few cents.
      </div>

      <section className="card space-y-4">
        <h2 className="section-title">Claude (Anthropic) <span className="text-sm font-normal text-muted-foreground">· recommended, cheapest for reading lectures</span></h2>
        <ol className="space-y-3">
          <Step n={1}>
            Go to <A href="https://platform.claude.com">platform.claude.com</A> and sign up (or log in). This is the Claude Console, which is
            separate from the regular Claude chat app.
          </Step>
          <Step n={2}>
            Add credit: open <A href="https://platform.claude.com/settings/billing">Settings → Billing</A>, add a payment method, and buy a
            small amount of credit ($5–10 is plenty to start).
          </Step>
          <Step n={3}>
            Open <A href="https://platform.claude.com/settings/keys">Settings → API keys</A> and click <strong>Create key</strong>. Name it
            &quot;Dental Study&quot;.
          </Step>
          <Step n={4}>
            Copy the key right away. It starts with <code className="rounded bg-muted px-1">sk-ant-</code> and is only shown once.
          </Step>
          <Step n={5}>
            Back in Dental Study, choose <strong>Claude</strong>, paste the key, and click <strong>Save and continue</strong>.
          </Step>
        </ol>
      </section>

      <section className="card space-y-4">
        <h2 className="section-title">ChatGPT (OpenAI)</h2>
        <ol className="space-y-3">
          <Step n={1}>
            Go to <A href="https://platform.openai.com">platform.openai.com</A> and sign up (or log in). This is the OpenAI developer platform,
            which is separate from the ChatGPT app.
          </Step>
          <Step n={2}>
            Add credit: open <A href="https://platform.openai.com/settings/organization/billing/overview">Settings → Billing</A>, add a payment
            method, and add a small amount of credit ($5–10 to start).
          </Step>
          <Step n={3}>
            Open <A href="https://platform.openai.com/api-keys">API keys</A> and click <strong>Create new secret key</strong>. Name it
            &quot;Dental Study&quot;.
          </Step>
          <Step n={4}>
            Copy the key right away. It starts with <code className="rounded bg-muted px-1">sk-</code> and is only shown once.
          </Step>
          <Step n={5}>
            Back in Dental Study, choose <strong>ChatGPT</strong>, paste the key, and click <strong>Save and continue</strong>.
          </Step>
        </ol>
      </section>

      <section className="card space-y-2 text-sm text-foreground">
        <h2 className="section-title">Keeping your key safe</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Treat it like a password. Don&apos;t share it or post it anywhere.</li>
          <li>Dental Study stores it encrypted and uses it only for your own studying. You can see what you&apos;ve spent under Settings.</li>
          <li>Set a monthly spending limit on the Billing page of your Claude or OpenAI account so you&apos;re never surprised.</li>
          <li>If you think your key leaked, delete it on that same API keys page and create a new one. Then update it in Dental Study → Settings.</li>
        </ul>
      </section>
    </div>
  );
}
