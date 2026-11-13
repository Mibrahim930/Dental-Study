import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, gateOk, gateToken, hashPassword, sessionToken, sessionUserId, verifyPassword } from "@/lib/auth";

describe("auth", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse");
    expect(h).not.toContain("correct horse");
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await hashPassword("same")).not.toBe(await hashPassword("same")); // salted
  });

  it("session cookies can't be forged or tampered with", () => {
    const t = sessionToken(42);
    expect(sessionUserId(t)).toBe(42);
    const [, ts, sig] = t.split(".");
    expect(sessionUserId(`43.${ts}.${sig}`)).toBeNull();
    expect(sessionUserId(`42.${ts}.AAAA`)).toBeNull();
    expect(sessionUserId("garbage")).toBeNull();
    expect(sessionUserId(undefined)).toBeNull();
  });

  it("passcode gate only accepts the current passcode's token", () => {
    expect(gateOk(gateToken())).toBe(true);
    expect(gateOk("nope")).toBe(false);
    expect(gateOk(undefined)).toBe(false);
  });

  it("API keys are encrypted at rest and decrypt back exactly", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const enc = encryptSecret(key);
    expect(enc).not.toContain("sk-ant");
    expect(encryptSecret(key)).not.toBe(enc); // random IV
    expect(decryptSecret(enc)).toBe(key);
    const [iv, tag, data] = enc.split(".");
    expect(() => decryptSecret(`${iv}.${tag}.${Buffer.from("tampered").toString("base64")}`)).toThrow();
    expect(data.length).toBeGreaterThan(0);
  });
});
