// The AI model ids in Settings ("claude-sonnet-5-5", "gpt-6.1-sol") as the names people know them by. Free of
// "use client" and of anything server-only, so pages and tests can use it.

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

/** "claude-sonnet-5-5" → "Claude Sonnet 5.5", "claude-3-5-haiku-20241022" → "Claude Haiku 3.5", "gpt-4o-mini" → "GPT-4o Mini". */
export function modelName(id: string): string {
  const clean = id.trim().replace(/-\d{8}$/, "").replace(/-latest$/, "");
  let m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i.exec(clean);
  if (m) return `Claude ${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  m = /^claude-(\d+)(?:-(\d+))?-([a-z]+)$/i.exec(clean);
  if (m) return `Claude ${cap(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ""}`;
  m = /^gpt-([^-]+)((?:-[a-z0-9.]+)*)$/i.exec(clean);
  if (m) return `GPT-${m[1]}${m[2] ? " " + m[2].slice(1).split("-").map(cap).join(" ") : ""}`;
  return id;
}
