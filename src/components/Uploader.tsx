"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function Uploader({ examId }: { examId: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>("");
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (list.length === 0) {
      setErrors(["Please choose PDF files."]);
      return;
    }
    setErrors([]);
    for (const [i, file] of list.entries()) {
      setStatus(`Uploading ${i + 1} of ${list.length}: ${file.name}… (rendering slides can take a moment)`);
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/exams/${examId}/upload`, { method: "POST", body });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: res.statusText }));
        setErrors((e) => [...e, `${file.name}: ${error}`]);
      }
      router.refresh();
    }
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
      className={`rounded-xl border-2 border-dashed p-6 text-center transition ${
        dragging ? "border-primary bg-primary-soft" : "border-input bg-card"
      }`}
    >
      <p className="text-sm text-muted-foreground">Drag lecture PDFs here, or</p>
      <button type="button" className="btn-secondary mt-2" disabled={!!status} onClick={() => input.current?.click()}>
        Choose files
      </button>
      <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      {status && <p className="mt-3 text-sm text-primary">{status}</p>}
      {errors.map((e) => (
        <p key={e} className="mt-2 text-sm text-danger">{e}</p>
      ))}
    </div>
  );
}
