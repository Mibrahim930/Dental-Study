// One interface over Claude (Anthropic) and ChatGPT (OpenAI). Every call runs on the user's own API key
// and is logged to ai_usage with an estimated cost.
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { db } from "./db";
import type { Credentials, Provider } from "./credentials";

export const MODELS: Record<Provider, string> = {
  anthropic: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
  openai: process.env.OPENAI_MODEL ?? "gpt-6.1-sol",
};

// USD per million tokens. Used only for the spending tracker, so treat totals as estimates.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
};

export type Part = { type: "text"; text: string } | { type: "image"; base64: string };
type Effort = "low" | "medium" | "high";
export type ChatTurn = { role: "user" | "assistant"; content: string };

type Usage = { input: number; cached: number; cacheWrite: number; output: number };

function logUsage(creds: Credentials, model: string, purpose: string, u: Usage, discount = 1) {
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  const cost = ((u.input * p.input + u.cached * p.cacheRead + u.cacheWrite * p.cacheWrite + u.output * p.output) / 1e6) * discount;
  db.prepare(
    "INSERT INTO ai_usage (user_id, provider, model, purpose, input_tokens, cached_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(creds.userId, creds.provider, model, purpose, u.input + u.cacheWrite, u.cached, u.output, cost);
}

// ---- Clients (one per API key) ----

const clients = new Map<string, Anthropic | OpenAI>();
function client<T extends Anthropic | OpenAI>(creds: Credentials): T {
  const k = creds.provider + crypto.createHash("sha256").update(creds.apiKey).digest("hex");
  let c = clients.get(k);
  if (!c) {
    c = creds.provider === "anthropic" ? new Anthropic({ apiKey: creds.apiKey }) : new OpenAI({ apiKey: creds.apiKey });
    clients.set(k, c);
  }
  return c as T;
}

/** Cheap call to confirm a key works (lists models; no tokens billed). */
export async function verifyKey(provider: Provider, apiKey: string): Promise<string | null> {
  try {
    if (provider === "anthropic") await new Anthropic({ apiKey }).models.list({ limit: 1 });
    else await new OpenAI({ apiKey }).models.list();
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) return "That key was rejected. Check that you copied all of it.";
    if (err instanceof Anthropic.PermissionDeniedError || err instanceof OpenAI.PermissionDeniedError) return "That key doesn't have permission to use the API.";
    return `Couldn't check the key: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---- Content conversion ----

function toAnthropic(parts: Part[] | string): Anthropic.ContentBlockParam[] | string {
  if (typeof parts === "string") return parts;
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text" as const, text: p.text }
      : { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: p.base64 } },
  );
}

function toOpenAI(parts: Part[] | string): OpenAI.Responses.ResponseInputContent[] | string {
  if (typeof parts === "string") return parts;
  return parts.map((p) =>
    p.type === "text"
      ? { type: "input_text" as const, text: p.text }
      : { type: "input_image" as const, image_url: `data:image/jpeg;base64,${p.base64}`, detail: "high" as const },
  );
}

// ---- Structured output ----

/** One call whose reply is validated against `schema` and returned parsed. */
export async function generate<S extends z.ZodType>(opts: {
  creds: Credentials;
  purpose: string;
  schema: S;
  system: string;
  content: Part[] | string;
  effort?: Effort;
  maxTokens?: number;
}): Promise<z.infer<S>> {
  const { creds } = opts;
  const model = MODELS[creds.provider];
  const effort = opts.effort ?? "medium";
  const maxTokens = opts.maxTokens ?? 32000;

  if (creds.provider === "anthropic") {
    const stream = client<Anthropic>(creds).beta.messages.stream({
      model,
      max_tokens: maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: toAnthropic(opts.content) as Anthropic.Beta.BetaContentBlockParam[] | string }],
      output_config: { effort, format: betaZodOutputFormat(opts.schema) },
      // If a safety classifier declines, the API retries on a suitable fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const msg = await stream.finalMessage();
    logUsage(creds, model, opts.purpose, {
      input: msg.usage.input_tokens,
      cached: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      output: msg.usage.output_tokens,
    });
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
    if (msg.stop_reason === "max_tokens") throw new Error("The answer was cut off (too long). Try a smaller request.");
    if (msg.parsed_output == null) throw new Error("Claude returned output that didn't match the expected format.");
    return msg.parsed_output as z.infer<S>;
  }

  const res = await client<OpenAI>(creds).responses.parse({
    model,
    instructions: opts.system,
    input: [{ role: "user", content: toOpenAI(opts.content) }],
    text: { format: zodTextFormat(opts.schema, "output") },
    reasoning: { effort },
    max_output_tokens: maxTokens,
  });
  const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
  logUsage(creds, model, opts.purpose, {
    input: (res.usage?.input_tokens ?? 0) - cached,
    cached,
    cacheWrite: 0,
    output: res.usage?.output_tokens ?? 0,
  });
  if (res.status === "incomplete") throw new Error("The answer was cut off (too long). Try a smaller request.");
  if (res.output_parsed == null) throw new Error("ChatGPT declined or returned output that didn't match the expected format.");
  return res.output_parsed as z.infer<S>;
}

// ---- Streaming chat ----

/**
 * Streams a chat reply as text chunks. The system prompt (lecture context) is the same on every turn,
 * so it's cached: Claude via cache_control, OpenAI automatically for long repeated prefixes.
 */
export async function* chatStream(opts: {
  creds: Credentials;
  purpose: string;
  system: string;
  messages: ChatTurn[];
  effort?: Effort;
}): AsyncGenerator<string> {
  const { creds } = opts;
  const model = MODELS[creds.provider];

  if (creds.provider === "anthropic") {
    const stream = client<Anthropic>(creds).beta.messages.stream({
      model,
      max_tokens: 8000,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: opts.messages,
      output_config: { effort: opts.effort ?? "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
    }
    const msg = await stream.finalMessage();
    logUsage(creds, model, opts.purpose, {
      input: msg.usage.input_tokens,
      cached: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      output: msg.usage.output_tokens,
    });
    if (msg.stop_reason === "refusal") yield "\n\n_(The tutor couldn't answer that one. Try rephrasing.)_";
    return;
  }

  const stream = await client<OpenAI>(creds).responses.create({
    model,
    instructions: opts.system,
    input: opts.messages,
    reasoning: { effort: opts.effort ?? "low" },
    max_output_tokens: 8000,
    stream: true,
  });
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") yield event.delta;
    else if (event.type === "response.completed") {
      const u = event.response.usage;
      const cached = u?.input_tokens_details?.cached_tokens ?? 0;
      logUsage(creds, model, opts.purpose, { input: (u?.input_tokens ?? 0) - cached, cached, cacheWrite: 0, output: u?.output_tokens ?? 0 });
    } else if (event.type === "error") throw new Error(event.message);
  }
}

// ---- Batch (Claude only): 50% cheaper, results arrive within minutes to an hour ----

export type BatchRequest = { customId: string; system: string; content: Part[]; effort: Effort; maxTokens: number };

export async function createBatch<S extends z.ZodType>(creds: Credentials, schema: S, requests: BatchRequest[]): Promise<string> {
  const format = zodOutputFormat(schema);
  const batch = await client<Anthropic>(creds).messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.customId,
      params: {
        model: MODELS.anthropic,
        max_tokens: r.maxTokens,
        system: r.system,
        messages: [{ role: "user", content: toAnthropic(r.content) }],
        output_config: { effort: r.effort, format: { type: format.type, schema: format.schema } },
      },
    })),
  });
  return batch.id;
}

export type BatchResult<T> = { customId: string; ok: true; value: T } | { customId: string; ok: false; error: string };

/** null while the batch is still running; otherwise every result (parsed and validated). */
export async function batchResults<S extends z.ZodType>(
  creds: Credentials,
  purpose: string,
  schema: S,
  batchId: string,
): Promise<BatchResult<z.infer<S>>[] | null> {
  const anthropic = client<Anthropic>(creds);
  const batch = await anthropic.messages.batches.retrieve(batchId);
  if (batch.processing_status !== "ended") return null;
  const out: BatchResult<z.infer<S>>[] = [];
  const total: Usage = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  for await (const r of await anthropic.messages.batches.results(batchId)) {
    if (r.result.type !== "succeeded") {
      out.push({ customId: r.custom_id, ok: false, error: r.result.type });
      continue;
    }
    const msg = r.result.message;
    total.input += msg.usage.input_tokens;
    total.output += msg.usage.output_tokens;
    total.cached += msg.usage.cache_read_input_tokens ?? 0;
    total.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const parsed = msg.stop_reason === "end_turn" ? schema.safeParse(safeJson(text)) : null;
    out.push(parsed?.success ? { customId: r.custom_id, ok: true, value: parsed.data } : { customId: r.custom_id, ok: false, error: msg.stop_reason ?? "invalid output" });
  }
  logUsage(creds, MODELS.anthropic, purpose, total, 0.5);
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Run async work over items with a fixed number in flight at once. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
