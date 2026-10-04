// A user's AI provider + decrypted key. No Next.js imports, so background jobs and scripts can use it.
import { db, type User } from "./db";
import { decryptSecret } from "./auth";

export type Provider = "anthropic" | "openai";
export type Credentials = { userId: number; provider: Provider; apiKey: string };

/** The user's own AI provider and key. Every AI call is billed to this key. */
export function credentials(userId: number): Credentials {
  const u = db.prepare("SELECT provider, api_key_enc FROM users WHERE id = ?").get(userId) as
    | Pick<User, "provider" | "api_key_enc">
    | undefined;
  if (!u?.provider || !u.api_key_enc) throw new Error("No API key set up. Add one in Settings.");
  return { userId, provider: u.provider, apiKey: decryptSecret(u.api_key_enc) };
}

/** Data uploaded before accounts existed (user_id NULL) goes to the first account created. */
export function claimLegacyData(userId: number) {
  const tx = db.transaction(() => {
    db.prepare("UPDATE exams SET user_id = ? WHERE user_id IS NULL").run(userId);
    db.prepare("UPDATE concepts SET user_id = ? WHERE user_id IS NULL").run(userId);
    db.prepare("UPDATE glossary SET user_id = ? WHERE user_id IS NULL").run(userId);
  });
  tx();
}
