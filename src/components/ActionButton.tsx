"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "./Toaster";
import { ServerMessage, failureText, jsonOf, signedOut } from "./clientFetch";
import { Dialog } from "./Dialog";

/**
 * Button that POSTs to an API route, then refreshes the page. `body` is sent as JSON when given; `confirm` asks first
 * (for actions that cost money or replace something she has), and nothing is sent if she says no. The question is the
 * confirm text's first paragraph; the rest (after a blank line) explains it.
 */
export function ActionButton({
  url,
  label,
  className = "btn-secondary",
  body,
  confirm,
}: {
  url: string;
  label: string;
  className?: string;
  body?: object;
  confirm?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const [question, ...details] = (confirm ?? "").split("\n\n");

  async function run() {
    setAsking(false);
    setBusy(true);
    try {
      const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method: "POST" });
      if (signedOut(res)) return;
      if (!res.ok) {
        const json = await jsonOf<{ error?: string }>(res);
        throw new ServerMessage(typeof json?.error === "string" ? json.error : "");
      }
      router.refresh();
    } catch (err) {
      toast(failureText(err, "That didn't go through. Check your connection and try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => (confirm ? setAsking(true) : void run())}>
        {busy ? "…" : label}
      </button>
      {confirm && (
        <Dialog open={asking} onClose={() => setAsking(false)} label={question} role="alertdialog" initialFocus={keep}>
          <p className="text-[15px] font-bold">{question}</p>
          {details.map((d, i) => (
            <p key={i} className="text-[13px] font-medium text-muted-foreground">
              {d}
            </p>
          ))}
          <div className="flex flex-wrap justify-end gap-2">
            <button ref={keep} type="button" className="btn-secondary btn-lg" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary btn-lg" onClick={() => void run()}>
              {label}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
