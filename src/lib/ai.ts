import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const MODEL = process.env.AI_MODEL ?? "claude-opus-5-5";

declare global {
  var __anthropic: Anthropic | undefined;
}

export const anthropic: Anthropic = globalThis.__anthropic ?? (globalThis.__anthropic = new Anthropic());

type Effort = "low" | "medium" | "high";

/**
 * One structured-output call: Claude's reply is validated against `schema` and returned parsed.
 * Streams under the hood so long outputs (topic maps, question sets) don't hit HTTP timeouts.
 */
export async function generate<S extends z.ZodType>(opts: {
  schema: S;
  system: string;
  content: Anthropic.ContentBlockParam[] | string;
  effort?: Effort;
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 32000,
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
    output_config: { effort: opts.effort ?? "medium", format: zodOutputFormat(opts.schema) },
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined this request (${message.stop_details?.category ?? "no category"}).`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude's answer was cut off (max_tokens). Try a smaller request.");
  }
  if (message.parsed_output == null) throw new Error("Claude returned output that didn't match the expected format.");
  return message.parsed_output as z.infer<S>;
}

/** Run async work over items with a fixed number in flight at once. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
