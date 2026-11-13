// Test helper for scripted lesson writers. The lesson writer now says, per entry, which numbered facts (F1…Fn) it
// explains. Tests written before that script whole lessons without them: `claimAll` fills in, for every entry that has
// no `facts` list, all the fact numbers the prompt lists under that slide (a writer that explains everything it was given).

/** The prompt as one string (a cached call sends it as text blocks). */
export function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n\n");
  return "";
}

/** The F numbers the prompt lists under each slide ([P12] … then "- F7: …" lines). */
export function factIdsInPrompt(content: unknown): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let page: number | null = null;
  for (const line of promptText(content).split("\n")) {
    const p = /^\[P(\d+)\]/.exec(line);
    if (p) {
      page = Number(p[1]);
      if (!out.has(page)) out.set(page, []);
      continue;
    }
    const f = /^- F(\d+): /.exec(line);
    if (f && page != null) out.get(page)!.push(Number(f[1]));
  }
  return out;
}

/** The slides a call was asked to write (in prompt order). */
export const slidesInPrompt = (content: unknown) => [...factIdsInPrompt(content).keys()];

/** The writer's output with `facts` filled in for every entry that has none: all the facts its slide lists in the prompt. */
export function claimAll<T>(content: unknown, out: T): T {
  if (out instanceof Promise) return out.then((o: unknown) => claimAll(content, o)) as T;
  if (!out || typeof out !== "object" || !Array.isArray((out as { slides?: unknown }).slides)) return out;
  const ids = factIdsInPrompt(content);
  return {
    ...out,
    slides: (out as unknown as { slides: { page_id: number; facts?: unknown }[] }).slides.map((s) =>
      s && typeof s === "object" && !Array.isArray(s.facts) ? { ...s, facts: ids.get(s.page_id) ?? [] } : s,
    ),
  } as T;
}
