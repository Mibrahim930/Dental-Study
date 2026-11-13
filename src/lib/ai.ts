// One interface over Claude (Anthropic) and ChatGPT (OpenAI). Every call runs on the user's own API key
// and is logged to ai_usage with an estimated cost, failed calls included. AI_FAKE=1 answers from lib/aiFake.ts instead.
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { db } from "./db";
import type { Credentials, Provider } from "./credentials";
import { FAKE_MODEL, fakeAnswer, fakeAnswerNow, fakeOn, fakeRefusal, promptText } from "./aiFake";

export const MODELS: Record<Provider, string> = {
  anthropic: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
  openai: process.env.OPENAI_MODEL ?? "gpt-6.1-sol",
};

/**
 * Two tiers. "standard" does the bulk work (slide reading, lessons, checking, summaries). "quality" writes the
 * questions students are judged by (section quizzes, practice exams, case sets, "Quiz me"): Claude Opus for Anthropic
 * keys (about twice the price per token), the same model as standard for ChatGPT keys, which has no higher tier here.
 */
export type Tier = "standard" | "quality";
export const QUALITY_MODELS: Record<Provider, string> = {
  anthropic: process.env.CLAUDE_QUALITY_MODEL ?? "claude-opus-5-5",
  openai: process.env.OPENAI_QUALITY_MODEL ?? MODELS.openai,
};
export function modelFor(provider: Provider, tier: Tier = "standard"): string {
  return tier === "quality" ? QUALITY_MODELS[provider] : MODELS[provider];
}

// USD per million tokens. Used only for the spending tracker, so treat totals as estimates.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
};

export type Part = { type: "text"; text: string } | { type: "image"; base64: string };
type Effort = "low" | "medium" | "high";

type Usage = { input: number; cached: number; cacheWrite: number; output: number };

/** Prices for a model id as the API reports it, which may carry a date or version suffix ("claude-opus-5-5-20261001"). */
function priceOf(model: string) {
  const key = PRICES[model] ? model : Object.keys(PRICES).find((k) => model.startsWith(k));
  return PRICES[key ?? "claude-sonnet-5-5"];
}

/**
 * Record one call's tokens and estimated cost. `answered` is the model the reply says produced it: a server-side
 * fallback (or a model alias) can answer on a different model than the one asked for, and that is the one billed.
 * Cache writes are priced at the cache-write rate; they count as input tokens in the table. A failed call is recorded
 * too (`ok` false, `error` one short line), so the Admin page sees problems without a student's screenshot. Recording
 * never throws: a call that worked is not lost, and one that failed keeps its own error, over a logging problem.
 */
function logUsage(
  creds: Credentials,
  requested: string,
  answered: string | null | undefined,
  purpose: string,
  u: Usage,
  discount = 1,
  extra: { ok?: boolean; error?: string | null; ref?: string | null; free?: boolean } = {},
) {
  try {
    const model = answered || requested;
    const p = priceOf(model);
    const cost = extra.free ? 0 : ((u.input * p.input + u.cached * p.cacheRead + u.cacheWrite * p.cacheWrite + u.output * p.output) / 1e6) * discount;
    db.prepare(
      "INSERT INTO ai_usage (user_id, provider, model, purpose, input_tokens, cached_tokens, output_tokens, cost_usd, ok, error, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      creds.userId,
      creds.provider,
      model,
      purpose,
      u.input + u.cacheWrite,
      u.cached,
      u.output,
      cost,
      extra.ok === false ? 0 : 1,
      extra.error ?? null,
      extra.ref ?? null,
    );
  } catch (err) {
    console.error(`Recording an AI call (${purpose}) failed`, err);
  }
}

const NO_USAGE: Usage = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

/**
 * One short line on why a call failed, for ai_usage.error: the HTTP status and the provider's own short message, at
 * most 200 characters, with anything that looks like a key masked (the key itself, "sk-…" tokens, long secret-like runs).
 */
export function failureLine(err: unknown, apiKey?: string): string {
  try {
    const e = err as { status?: unknown; error?: { error?: { message?: unknown }; message?: unknown }; message?: unknown } | null;
    const status = typeof e?.status === "number" ? e.status : null;
    const provider = e?.error?.error?.message ?? e?.error?.message;
    let text = typeof provider === "string" && provider.trim() ? provider : err instanceof Error ? err.message : String(err);
    text = text.split("\n")[0].trim();
    if (status != null && !text.startsWith(String(status))) text = `${status} ${text}`;
    if (apiKey && apiKey.length >= 6) text = text.split(apiKey).join("[key]");
    text = text.replace(/sk-[\w-]+/g, "[key]").replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[key]");
    return (text || "failed").slice(0, 200);
  } catch {
    return "failed";
  }
}

// ---- Clients (one per API key) ----

// A busy or briefly failing API is retried by the SDK with back-off (it honours retry-after) before the call fails.
// One request may take up to five minutes: a long section quiz or practice set is written in one go.
const CLIENT_OPTIONS = { maxRetries: 4, timeout: 5 * 60_000 };

const clients = new Map<string, Anthropic | OpenAI>();
function client<T extends Anthropic | OpenAI>(creds: Credentials): T {
  const k = creds.provider + crypto.createHash("sha256").update(creds.apiKey).digest("hex");
  let c = clients.get(k);
  if (!c) {
    c = creds.provider === "anthropic" ? new Anthropic({ apiKey: creds.apiKey, ...CLIENT_OPTIONS }) : new OpenAI({ apiKey: creds.apiKey, ...CLIENT_OPTIONS });
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

/** One call whose reply is validated against `schema` and returned parsed. Logged to ai_usage, failures included. */
export async function generate<S extends z.ZodType>(opts: {
  creds: Credentials;
  purpose: string;
  schema: S;
  system: string;
  content: Part[] | string;
  effort?: Effort;
  maxTokens?: number;
  /** "quality" for the question writers (Opus on Anthropic keys); default "standard". */
  tier?: Tier;
  /**
   * Mark the system prompt and the first content block for prompt caching (Claude only; ChatGPT caches long repeated
   * prefixes by itself). Worth it only when the same prefix is sent again within five minutes: writing the cache costs
   * a quarter more than plain input, reading it a tenth. Put the part that repeats first in `content`.
   */
  cache?: boolean;
  /** What the call is for, stored in ai_usage.ref: "topic:<id>", "attempt:<id>", "doc:<id>", "exam:<id>". */
  ref?: string;
}): Promise<z.infer<S>> {
  const { creds } = opts;
  const ref = opts.ref ?? null;
  if (fakeOn()) return fakeGenerate(opts);
  const model = modelFor(creds.provider, opts.tier);
  const effort = opts.effort ?? "medium";
  const maxTokens = opts.maxTokens ?? 32000;
  // A call that fails before a reply arrives (a refused key, a busy service, a dropped connection) bills nothing.
  const failed = (err: unknown): never => {
    logUsage(creds, model, null, opts.purpose, NO_USAGE, 1, { ok: false, error: failureLine(err, creds.apiKey), ref, free: true });
    throw err;
  };

  if (creds.provider === "anthropic") {
    const content = toAnthropic(opts.content) as Anthropic.Beta.BetaContentBlockParam[] | string;
    let msg: Awaited<ReturnType<ReturnType<Anthropic["beta"]["messages"]["stream"]>["finalMessage"]>>;
    try {
      const stream = client<Anthropic>(creds).beta.messages.stream({
        model,
        max_tokens: maxTokens,
        system: opts.cache ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }] : opts.system,
        messages: [{ role: "user", content: opts.cache ? cacheFirstBlock(content) : content }],
        output_config: { effort, format: betaZodOutputFormat(opts.schema) },
        // If a safety classifier declines, the API retries on a suitable fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      msg = await stream.finalMessage();
    } catch (err) {
      return failed(err);
    }
    // A refusal, a cut-off and an unreadable reply were all billed: their tokens and cost are logged as a failure.
    const problem = msg.stop_reason === "refusal" ? "refused" : msg.stop_reason === "max_tokens" ? "cut off" : msg.parsed_output == null ? "unreadable answer" : null;
    logUsage(
      creds,
      model,
      msg.model,
      opts.purpose,
      {
        input: msg.usage?.input_tokens ?? 0,
        cached: msg.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage?.cache_creation_input_tokens ?? 0,
        output: msg.usage?.output_tokens ?? 0,
      },
      1,
      { ok: !problem, error: problem, ref },
    );
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
    if (msg.stop_reason === "max_tokens") throw new Error("The answer was cut off (too long). Try a smaller request.");
    if (msg.parsed_output == null) throw new Error("Claude returned output that didn't match the expected format.");
    return msg.parsed_output as z.infer<S>;
  }

  let res: Awaited<ReturnType<OpenAI["responses"]["parse"]>>;
  try {
    res = await client<OpenAI>(creds).responses.parse({
      model,
      instructions: opts.system,
      input: [{ role: "user", content: toOpenAI(opts.content) }],
      text: { format: zodTextFormat(opts.schema, "output") },
      reasoning: { effort },
      max_output_tokens: maxTokens,
    });
  } catch (err) {
    return failed(err);
  }
  const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
  const refused = (res.output ?? []).some((o) => o.type === "message" && (o.content ?? []).some((c) => c.type === "refusal"));
  const problem = res.status === "incomplete" ? "cut off" : res.output_parsed == null ? (refused ? "refused" : "unreadable answer") : null;
  logUsage(
    creds,
    model,
    res.model,
    opts.purpose,
    {
      input: (res.usage?.input_tokens ?? 0) - cached,
      cached,
      cacheWrite: 0,
      output: res.usage?.output_tokens ?? 0,
    },
    1,
    { ok: !problem, error: problem, ref },
  );
  if (res.status === "incomplete") throw new Error("The answer was cut off (too long). Try a smaller request.");
  if (res.output_parsed == null) throw new Error("ChatGPT declined or returned output that didn't match the expected format.");
  return res.output_parsed as z.infer<S>;
}

/** Rough token count of a text (about four characters a token), for the fake's ai_usage rows. */
const roughTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * AI_FAKE=1 (lib/aiFake.ts): the built-in writers answer, with no network call, logged like a real call with model
 * "fake" and cost 0. Refused in production (the server won't start with it there either).
 */
async function fakeGenerate<S extends z.ZodType>(opts: { creds: Credentials; purpose: string; schema: S; system: string; content: Part[] | string; ref?: string }): Promise<z.infer<S>> {
  const ref = opts.ref ?? null;
  const refusal = fakeRefusal();
  if (refusal) throw new Error(`${refusal}.`);
  const input = roughTokens(opts.system + promptText(opts.content));
  try {
    const value = await fakeAnswer(opts);
    logUsage(opts.creds, FAKE_MODEL, FAKE_MODEL, opts.purpose, { ...NO_USAGE, input, output: roughTokens(JSON.stringify(value) ?? "") }, 1, { ref, free: true });
    return value;
  } catch (err) {
    logUsage(opts.creds, FAKE_MODEL, FAKE_MODEL, opts.purpose, { ...NO_USAGE, input }, 1, { ok: false, error: failureLine(err), ref, free: true });
    throw err;
  }
}

/** The content with a cache breakpoint on its first block (a plain string becomes one text block). */
function cacheFirstBlock(content: Anthropic.Beta.BetaContentBlockParam[] | string): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
  if (blocks[0]?.type === "text" || blocks[0]?.type === "image") blocks[0] = { ...blocks[0], cache_control: { type: "ephemeral" } };
  return blocks;
}

// ---- Batch (Claude only): 50% cheaper, results arrive within minutes to an hour ----

export type BatchRequest = { customId: string; system: string; content: Part[]; effort: Effort; maxTokens: number };

/** Fake batches (AI_FAKE=1): answered when they are created, kept in memory until collected or cancelled. */
const fakeBatches = new Map<string, { results: BatchResult<unknown>[]; input: number; output: number }>();
let fakeBatchCount = 0;

/** Send slide requests as one batch. A batch that can't be sent is logged as a failed call (under `opts.purpose`). */
export async function createBatch<S extends z.ZodType>(
  creds: Credentials,
  schema: S,
  requests: BatchRequest[],
  opts: { purpose?: string; ref?: string } = {},
): Promise<string> {
  const purpose = opts.purpose ?? "read slides (batch)";
  if (fakeOn()) {
    const refusal = fakeRefusal();
    if (refusal) throw new Error(`${refusal}.`);
    const id = `fake-batch-${++fakeBatchCount}-${Date.now()}`;
    let input = 0;
    let output = 0;
    const results = requests.map((r): BatchResult<unknown> => {
      input += roughTokens(r.system + promptText(r.content));
      try {
        const value = fakeAnswerNow({ purpose, schema, system: r.system, content: r.content });
        output += roughTokens(JSON.stringify(value) ?? "");
        return { customId: r.customId, ok: true, value };
      } catch (err) {
        return { customId: r.customId, ok: false, error: failureLine(err) };
      }
    });
    fakeBatches.set(id, { results, input, output });
    return id;
  }
  const format = zodOutputFormat(schema);
  try {
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
  } catch (err) {
    logUsage(creds, MODELS.anthropic, null, purpose, NO_USAGE, 1, { ok: false, error: failureLine(err, creds.apiKey), ref: opts.ref ?? null, free: true });
    throw err;
  }
}

/** Stop a batch that is still running (e.g. its lecture was removed), so unread slides aren't paid for. */
export async function cancelBatch(creds: Credentials, batchId: string): Promise<void> {
  if (fakeBatches.delete(batchId) || (fakeOn() && batchId.startsWith("fake-batch-"))) return;
  await client<Anthropic>(creds).messages.batches.cancel(batchId);
}

export type BatchResult<T> = { customId: string; ok: true; value: T } | { customId: string; ok: false; error: string };

/**
 * A finished batch: every result (parsed and validated), and `logUsage`, which records what it cost. The caller runs
 * `logUsage` in the same database transaction that saves the results and forgets the batch, so a batch collected again
 * after a crash or restart is never counted twice.
 */
export type BatchOutcome<T> = { results: BatchResult<T>[]; logUsage: () => void };

/** HTTP status of an error from the AI provider's SDK, if it has one. */
const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};

/**
 * null while the batch is still running; otherwise its results. Requests of the batch that failed are recorded as one
 * failed row with how many and why (`logUsage`). Collecting is retried every minute, so only a failure that will not
 * pass by itself (the key refused, the batch unknown) is recorded when collecting throws.
 */
export async function batchResults<S extends z.ZodType>(
  creds: Credentials,
  purpose: string,
  schema: S,
  batchId: string,
  ref?: string,
): Promise<BatchOutcome<z.infer<S>> | null> {
  const fake = fakeBatches.get(batchId);
  if (fake || batchId.startsWith("fake-batch-")) {
    if (!fake) throw Object.assign(new Error("The fake AI no longer has this batch (the server restarted)."), { status: 404 });
    const failures = fake.results.filter((r) => !r.ok);
    return {
      results: fake.results as BatchResult<z.infer<S>>[],
      logUsage: () => {
        fakeBatches.delete(batchId);
        logUsage(creds, FAKE_MODEL, FAKE_MODEL, purpose, { ...NO_USAGE, input: fake.input, output: fake.output }, 1, { ref, free: true });
        if (failures.length) logUsage(creds, FAKE_MODEL, FAKE_MODEL, purpose, NO_USAGE, 1, { ok: false, error: batchFailureLine(failures, fake.results.length), ref, free: true });
      },
    };
  }
  const anthropic = client<Anthropic>(creds);
  try {
    const batch = await anthropic.messages.batches.retrieve(batchId);
    if (batch.processing_status !== "ended") return null;
    const out: BatchResult<z.infer<S>>[] = [];
    // Per answering model (a fallback can answer some requests on another model).
    const totals = new Map<string, Usage>();
    for await (const r of await anthropic.messages.batches.results(batchId)) {
      if (r.result.type !== "succeeded") {
        out.push({ customId: r.custom_id, ok: false, error: r.result.type });
        continue;
      }
      const msg = r.result.message;
      const answered = msg.model || MODELS.anthropic;
      const total = totals.get(answered) ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 };
      totals.set(answered, total);
      total.input += msg.usage.input_tokens;
      total.output += msg.usage.output_tokens;
      total.cached += msg.usage.cache_read_input_tokens ?? 0;
      total.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const parsed = msg.stop_reason === "end_turn" ? schema.safeParse(safeJson(text)) : null;
      out.push(parsed?.success ? { customId: r.custom_id, ok: true, value: parsed.data } : { customId: r.custom_id, ok: false, error: msg.stop_reason ?? "invalid output" });
    }
    if (totals.size === 0) totals.set(MODELS.anthropic, { input: 0, cached: 0, cacheWrite: 0, output: 0 });
    const failures = out.filter((r) => !r.ok);
    return {
      results: out,
      logUsage: () => {
        for (const [answered, total] of totals) logUsage(creds, MODELS.anthropic, answered, purpose, total, 0.5, { ref });
        // (what the failed requests cost is in the totals above: billed tokens come with the message)
        if (failures.length) logUsage(creds, MODELS.anthropic, null, purpose, NO_USAGE, 1, { ok: false, error: batchFailureLine(failures, out.length), ref, free: true });
      },
    };
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403 || status === 404)
      logUsage(creds, MODELS.anthropic, null, purpose, NO_USAGE, 1, { ok: false, error: failureLine(err, creds.apiKey), ref, free: true });
    throw err;
  }
}

/** "3 of 40 requests failed: errored, max_tokens" (the reasons as the API gives them, each once). */
function batchFailureLine(failures: BatchResult<unknown>[], total: number): string {
  const why = [...new Set(failures.map((f) => (f.ok ? "" : f.error === "max_tokens" ? "cut off" : f.error)))].join(", ");
  return `${failures.length} of ${total} requests failed: ${why}`.slice(0, 200);
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
