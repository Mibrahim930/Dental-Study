"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon, ICONS } from "./ui";
import { toast } from "./Toaster";
import { jsonOf, signedOut } from "./clientFetch";

/** Keep in step with lib/reports.ts. */
const MAX_IMAGES = 5;
const MAX_IMAGE_MB = 8;
const MAX_CHARS = 4000;

type Kind = "problem" | "idea";

/**
 * A small round button in the bottom-left corner of every page. It opens a corner form where the student says what
 * went wrong or what she'd like, adds screenshots, and sends it to the site owner (listed on the Admin page).
 */
export function ReportButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("problem");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_IMAGES) break;
      if (!f.type.startsWith("image/")) {
        setError("Only pictures can be added. Take a screenshot and add that.");
        continue;
      }
      if (f.size > MAX_IMAGE_MB * 1024 * 1024) {
        setError(`"${f.name}" is over ${MAX_IMAGE_MB} MB. Try a screenshot instead of a photo.`);
        continue;
      }
      next.push(f);
    }
    setFiles(next);
    if (input.current) input.current.value = "";
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    const body = new FormData();
    body.append("kind", kind);
    body.append("message", text);
    body.append("page", `${window.location.pathname}${window.location.search}`);
    body.append(
      "meta",
      JSON.stringify({
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        theme: document.documentElement.dataset.theme ?? "",
        userAgent: navigator.userAgent,
      }),
    );
    for (const f of files) body.append("files", f);
    try {
      const res = await fetch("/api/reports", { method: "POST", body });
      if (signedOut(res)) return;
      const json = await jsonOf<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || !json?.ok) {
        setError(typeof json?.error === "string" && json.error ? json.error : "Couldn't send that. Check your connection and try again.");
        return;
      }
      toast("Sent. Thank you!");
      setOpen(false);
      setMessage("");
      setFiles([]);
      setKind("problem");
    } catch {
      setError("Couldn't send that. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  // Not on the sign-in flow (the layout only mounts this when signed in, but the key-setup page has no nav either).
  if (pathname.startsWith("/account") || pathname === "/login") return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Report a problem or suggest an idea"
          title="Report a problem or suggest an idea"
          className="fixed left-3.5 bottom-[calc(100px+env(safe-area-inset-bottom))] z-30 flex h-11 w-11 items-center justify-center rounded-full bg-card text-muted-foreground shadow-[0_8px_24px_rgba(22,22,22,.18)] transition-colors hover:text-foreground sm:left-6 sm:bottom-6"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 21V4" />
            <path d="M4 4h11l-1.5 3L15 10H4" />
          </svg>
        </button>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 sm:bg-transparent" onClick={() => setOpen(false)} aria-hidden />
          <form
            onSubmit={send}
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-title"
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col gap-3 overflow-y-auto rounded-t-[28px] bg-card p-5 shadow-[0_-12px_36px_rgba(22,22,22,.18)] sm:inset-x-auto sm:left-6 sm:bottom-6 sm:w-[380px] sm:rounded-[24px] sm:shadow-[0_16px_48px_rgba(22,22,22,.22)]"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 id="report-title" className="text-[18px] font-extrabold tracking-tight">
                  Tell the site owner
                </h2>
                <p className="text-[13px] text-muted-foreground">A problem you hit, or something you&apos;d like. Screenshots help.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted" aria-label="Close">
                <Icon d={ICONS.close} size={18} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="What is this?">
              {(
                [
                  ["problem", "Something's wrong"],
                  ["idea", "An idea"],
                ] as [Kind, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  onClick={() => setKind(value)}
                  className={`h-11 rounded-2xl text-[14px] font-bold transition-colors ${kind === value ? "bg-hero text-hero-foreground" : "bg-muted text-foreground hover:bg-muted-strong"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <textarea
              ref={field}
              className="input min-h-28 resize-y py-3 leading-snug"
              placeholder={kind === "problem" ? "What were you doing, and what happened?" : "What would make studying easier?"}
              value={message}
              maxLength={MAX_CHARS}
              onChange={(e) => setMessage(e.target.value)}
              required
            />
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Screenshots to send">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-xl bg-muted px-2.5 py-1.5 text-[13px] font-semibold">
                    <span className="max-w-[140px] truncate">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => setFiles(files.filter((_, k) => k !== i))}
                      aria-label={`Remove ${f.name}`}
                      className="-mr-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
                    >
                      <Icon d={ICONS.close} size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p role="alert" className="rounded-2xl bg-coral px-4 py-3 text-sm font-semibold text-on-coral">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary min-h-11" disabled={sending || files.length >= MAX_IMAGES} onClick={() => input.current?.click()}>
                {files.length ? `Add another (${files.length}/${MAX_IMAGES})` : "Add screenshots"}
              </button>
              <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
              <button type="submit" className="btn-primary ml-auto min-h-11" disabled={sending || !message.trim()}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
