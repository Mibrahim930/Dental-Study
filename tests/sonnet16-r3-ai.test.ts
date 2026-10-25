// Sonnet QA 16: ai.ts model tiers and usage logging (Release 3 Job B), with the provider SDKs replaced by fakes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const anthropicCalls: { model: string; max_tokens: number }[] = [];
const openaiCalls: { model: string }[] = [];
let anthropicUsage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 };

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    beta = {
      messages: {
        stream: (p: { model: string; max_tokens: number }) => {
          anthropicCalls.push({ model: p.model, max_tokens: p.max_tokens });
          return { finalMessage: async () => ({ usage: anthropicUsage, stop_reason: "end_turn", parsed_output: { ok: true } }) };
        },
      },
    };
    static AuthenticationError = class extends Error {};
    static PermissionDeniedError = class extends Error {};
  }
  return { default: Anthropic };
});
vi.mock("openai", () => {
  class OpenAI {
    responses = {
      parse: async (p: { model: string }) => {
        openaiCalls.push({ model: p.model });
        return { usage: { input_tokens: 2000, output_tokens: 400, input_tokens_details: { cached_tokens: 500 } }, status: "completed", output_parsed: { ok: true } };
      },
    };
    static AuthenticationError = class extends Error {};
    static PermissionDeniedError = class extends Error {};
  }
  return { default: OpenAI };
});

import { db } from "@/lib/db";
import { makeUser } from "./helpers";

const schema = z.object({ ok: z.boolean() });
type Ai = typeof import("@/lib/ai");
const usage = (userId: number) => db.prepare("SELECT provider, model, purpose, input_tokens, cached_tokens, output_tokens, cost_usd FROM ai_usage WHERE user_id = ? ORDER BY id").all(userId) as {
  provider: string; model: string; purpose: string; input_tokens: number; cached_tokens: number; output_tokens: number; cost_usd: number;
}[];

beforeEach(() => {
  anthropicCalls.length = 0;
  openaiCalls.length = 0;
  anthropicUsage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 };
  delete process.env.CLAUDE_QUALITY_MODEL;
  delete process.env.OPENAI_QUALITY_MODEL;
  delete process.env.CLAUDE_MODEL;
  delete process.env.OPENAI_MODEL;
});

describe("ai.ts tiers", () => {
  it("modelFor: anthropic quality = opus, standard = sonnet; openai both = the standard model; default tier is standard", async () => {
    const ai = await import("@/lib/ai");
    expect(ai.modelFor("anthropic", "quality")).toBe("claude-opus-5-5");
    expect(ai.modelFor("anthropic", "standard")).toBe("claude-sonnet-5-5");
    expect(ai.modelFor("anthropic")).toBe("claude-sonnet-5-5");
    expect(ai.modelFor("openai", "quality")).toBe(ai.MODELS.openai);
    expect(ai.modelFor("openai", "standard")).toBe(ai.MODELS.openai);
    expect(ai.modelFor("openai")).toBe(ai.MODELS.openai);
  });

  it("env overrides are read at load: CLAUDE_QUALITY_MODEL / OPENAI_QUALITY_MODEL / CLAUDE_MODEL", async () => {
    process.env.CLAUDE_QUALITY_MODEL = "claude-custom-q";
    process.env.OPENAI_QUALITY_MODEL = "gpt-custom-q";
    process.env.CLAUDE_MODEL = "claude-custom-s";
    vi.resetModules();
    const ai: Ai = await import("@/lib/ai");
    expect(ai.modelFor("anthropic", "quality")).toBe("claude-custom-q");
    expect(ai.modelFor("anthropic", "standard")).toBe("claude-custom-s");
    expect(ai.modelFor("openai", "quality")).toBe("gpt-custom-q");
    expect(ai.modelFor("openai", "standard")).toBe(ai.MODELS.openai);
    vi.resetModules();
  });

  it("generate() sends the quality model for tier quality and logs usage with that model and the opus price", async () => {
    vi.resetModules();
    const ai: Ai = await import("@/lib/ai");
    const userId = makeUser();
    const creds = { userId, provider: "anthropic" as const, apiKey: "k" };
    await ai.generate({ creds, purpose: "section quiz", schema, system: "s", content: "c", tier: "quality" });
    await ai.generate({ creds, purpose: "lesson", schema, system: "s", content: "c" });
    expect(anthropicCalls.map((c) => c.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    const rows = usage(userId);
    expect(rows.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    // input 1000 + cacheWrite 100 = 1100 stored; cost = (1000*4 + 200*0.2 + 100*5 + 500*20) / 1e6
    expect(rows[0].cost_usd).toBeCloseTo((1000 * 4 + 200 * 0.2 + 100 * 5 + 500 * 20) / 1e6, 10);
    expect(rows[1].cost_usd).toBeCloseTo((1000 * 2 + 200 * 0.2 + 100 * 2.5 + 500 * 10) / 1e6, 10);
    expect(rows[0].cost_usd).toBeGreaterThan(rows[1].cost_usd);
  });

  it("ChatGPT users: both tiers use the same model and the same price", async () => {
    vi.resetModules();
    const ai: Ai = await import("@/lib/ai");
    const userId = makeUser();
    const creds = { userId, provider: "openai" as const, apiKey: "k" };
    await ai.generate({ creds, purpose: "section quiz", schema, system: "s", content: "c", tier: "quality" });
    await ai.generate({ creds, purpose: "lesson", schema, system: "s", content: "c" });
    expect(openaiCalls[0].model).toBe(openaiCalls[1].model);
    const rows = usage(userId);
    expect(rows[0].model).toBe(rows[1].model);
    expect(rows[0].cost_usd).toBeCloseTo(rows[1].cost_usd, 12);
    expect(rows[0].cost_usd).toBeCloseTo((1500 * 2 + 500 * 0.2 + 400 * 10) / 1e6, 10);
  });

  it("a custom quality model name that is not in PRICES is billed at the sonnet price (the spend tracker under-reports)", async () => {
    process.env.CLAUDE_QUALITY_MODEL = "claude-opus-5-6";
    vi.resetModules();
    const ai: Ai = await import("@/lib/ai");
    const userId = makeUser();
    await ai.generate({ creds: { userId, provider: "anthropic", apiKey: "k" }, purpose: "section quiz", schema, system: "s", content: "c", tier: "quality" });
    const [row] = usage(userId);
    expect(row.model).toBe("claude-opus-5-6");
    // Informational (known limitation): same as sonnet pricing
    expect(row.cost_usd).toBeCloseTo((1000 * 2 + 200 * 0.2 + 100 * 2.5 + 500 * 10) / 1e6, 10);
    vi.resetModules();
  });
});
