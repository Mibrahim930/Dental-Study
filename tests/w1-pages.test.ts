// Wave 1, pages: the pure helpers behind the pages' wording (R5 stored errors, U7 model names).
import { describe, expect, it } from "vitest";
import { friendlyError, needsKeyFix } from "@/components/friendlyError";
import { modelName } from "@/components/modelName";

const FALLBACK = "Something went wrong. Try again.";

describe("friendlyError: stored error texts become plain sentences", () => {
  it("uses the fallback when nothing is stored", () => {
    expect(friendlyError(null, FALLBACK)).toBe(FALLBACK);
    expect(friendlyError(undefined, FALLBACK)).toBe(FALLBACK);
    expect(friendlyError("   ", FALLBACK)).toBe(FALLBACK);
  });

  it("keeps a sentence the server wrote for her", () => {
    const own = "This practice exam had no questions left from this exam. Please start a new one.";
    expect(friendlyError(own, FALLBACK)).toBe(own);
    const retry = '3 slide(s) could not be processed. Use "Retry" to try them again.';
    expect(friendlyError(retry, FALLBACK)).toBe(retry);
  });

  it("never shows thrown-error text, stack lines, SQLite or JSON", () => {
    for (const raw of [
      "Error: Cannot read properties of undefined (reading 'map')",
      "TypeError: fetch failed",
      "SqliteError: SQLITE_BUSY: database is locked",
      "Error: something\n    at /app/src/lib/practice.ts:120:7",
      'Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      "connect ECONNRESET 1.2.3.4:443",
      "Unexpected token < in JSON at position 0",
      "x".repeat(300),
    ]) {
      expect(friendlyError(raw, FALLBACK)).toBe(FALLBACK);
    }
  });

  it("names key and billing problems in plain words", () => {
    expect(friendlyError('Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', FALLBACK)).toMatch(/AI key was refused/);
    expect(friendlyError("Error: 400 Your credit balance is too low to access the Anthropic API.", FALLBACK)).toMatch(/out of credit/);
    expect(friendlyError("Error: 403 permission_error", FALLBACK)).toMatch(/isn't allowed/);
    expect(friendlyError("Error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit", FALLBACK)).toMatch(/usage limit/);
    expect(friendlyError('Error: 529 {"type":"overloaded_error"}', FALLBACK)).toMatch(/busy right now/);
  });

  it("does not take a file-permission error for a key problem", () => {
    const raw = "Error: EACCES: permission denied, open '/data/x.png'";
    expect(needsKeyFix(raw)).toBe(false);
    expect(friendlyError(raw, FALLBACK)).toBe(FALLBACK);
  });

  it("drops the PDF library's words from a PDF read failure", () => {
    expect(friendlyError("Could not read this PDF: InvalidPDFException: Invalid PDF structure.", FALLBACK)).toMatch(/^This PDF couldn't be read\./);
  });

  it("needsKeyFix decides between 'Update key' and 'Back to exam'", () => {
    expect(needsKeyFix("Error: 401 invalid x-api-key")).toBe(true);
    expect(needsKeyFix("Your credit balance is too low")).toBe(true);
    expect(needsKeyFix("Error: 529 overloaded")).toBe(false);
    expect(needsKeyFix(null)).toBe(false);
    // The old screen matched any "key" (e.g. "monkey", "key_facts") and sent her to Settings for nothing.
    expect(needsKeyFix("TypeError: key_facts.map is not a function")).toBe(false);
  });
});

describe("modelName: Settings shows the names people know", () => {
  it("names Claude and GPT models", () => {
    expect(modelName("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelName("claude-opus-4-1-20250805")).toBe("Claude Opus 4.1");
    expect(modelName("claude-haiku-4")).toBe("Claude Haiku 4");
    expect(modelName("claude-3-5-haiku-20241022")).toBe("Claude Haiku 3.5");
    expect(modelName("claude-3-7-sonnet-latest")).toBe("Claude Sonnet 3.7");
    expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelName("gpt-4o-mini")).toBe("GPT-4o Mini");
    expect(modelName("gpt-5")).toBe("GPT-5");
  });

  it("leaves an id it doesn't recognise as it is", () => {
    expect(modelName("o3")).toBe("o3");
    expect(modelName("my-custom-model")).toBe("my-custom-model");
  });
});
