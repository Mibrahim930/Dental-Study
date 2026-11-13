import { NextResponse } from "next/server";
import { cookieOptions, GATE_COOKIE, gateToken, passcodeMatches } from "@/lib/auth";
import { readJson } from "@/lib/http";
import { limited } from "@/lib/rateLimit";

// Step 1: the site passcode.
export async function POST(request: Request) {
  return limited("passcode", request, async () => {
    const { passcode } = await readJson(request);
    if (!passcodeMatches(passcode)) return NextResponse.json({ error: "Wrong passcode" }, { status: 401 });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(GATE_COOKIE, gateToken(), cookieOptions());
    return res;
  });
}
