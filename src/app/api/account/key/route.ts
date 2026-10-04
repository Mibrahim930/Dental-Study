import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/auth";
import { currentUser, unauthorized, type Provider } from "@/lib/user";
import { verifyKey } from "@/lib/ai";
import { resumeUnfinished } from "@/lib/processing";

// Save (or replace) the user's own API key after checking that it works.
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { provider, apiKey } = (await request.json()) as { provider?: Provider; apiKey?: string };
  const key = apiKey?.trim() ?? "";
  if (provider !== "anthropic" && provider !== "openai") return NextResponse.json({ error: "Choose Claude or ChatGPT." }, { status: 400 });
  if (key.length < 20) return NextResponse.json({ error: "That doesn't look like a full API key." }, { status: 400 });
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    return NextResponse.json({ error: "Claude keys start with sk-ant-. Did you mean to pick ChatGPT?" }, { status: 400 });
  }
  if (provider === "openai" && key.startsWith("sk-ant-")) {
    return NextResponse.json({ error: "That's a Claude key. Pick Claude above, or paste your OpenAI key." }, { status: 400 });
  }
  const problem = await verifyKey(provider, key);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  db.prepare("UPDATE users SET provider = ?, api_key_enc = ?, api_key_last4 = ? WHERE id = ?").run(provider, encryptSecret(key), key.slice(-4), user.id);
  resumeUnfinished(user.id); // lectures waiting on a key (or that failed) start processing now
  return NextResponse.json({ ok: true });
}
