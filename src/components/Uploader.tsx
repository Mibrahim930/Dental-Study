"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function Uploader({ examId }: { examId: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>("");
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController | null>(null);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (list.length === 0) {
      setErrors(["Please choose PDF files."]);
      return;
    }
    setErrors([]);
    const controller = new AbortController();
    abort.current = controller;
    for (const [i, file] of list.entries()) {
      if (controller.signal.aborted) break;
      setStatus(`Uploading ${i + 1} of ${list.length}: ${file.name}… (rendering slides can take a moment)`);
      const body = new FormData();
      body.append("file", file);
      try {
        const res = await fetch(`/api/exams/${examId}/upload`, { method: "POST", body, signal: controller.signal });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: res.statusText }));
          setErrors((e) => [...e, `${file.name}: ${error}`]);
        }
      } catch {
        // Cancelled. If the file already reached the server it shows in the list below, where it can be removed.
        setErrors((e) => [...e, `Cancelled ${list.length - i > 1 ? `${file.name} and the files after it` : file.name}. If it still appears below, use Remove.`]);
      }
      router.refresh();
    }
    abort.current = null;
    setStatus("");
    if (input.current) input.current.value = "";
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
      className={`flex flex-col items-center gap-2 rounded-[22px] border-2 border-dashed p-5 text-center transition-colors ${
        dragging ? "border-primary bg-primary-soft" : "border-muted-strong"
      }`}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-butter text-on-butter" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
        </svg>
      </span>
      <p className="text-[15px] font-semibold">Drop lecture PDFs here</p>
      <button type="button" className="btn-primary btn-sm" disabled={!!status} onClick={() => input.current?.click()}>
        Choose files
      </button>
      <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      {status && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-semibold text-primary">{status}</p>
          <button type="button" className="btn-secondary btn-sm" onClick={() => abort.current?.abort()}>
            Cancel upload
          </button>
        </div>
      )}
      {errors.map((e) => (
        <p key={e} className="w-full rounded-2xl bg-coral px-3 py-2 text-left text-sm font-semibold text-on-coral">{e}</p>
      ))}
    </div>
  );
}
