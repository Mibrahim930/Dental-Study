import { NextResponse } from "next/server";

/**
 * A GET that writes a lesson or quiz spends the student's AI money, so a link or picture on another site must not be
 * able to start one. Browsers say where a request came from in Sec-Fetch-Site: only her own pages ("same-origin") and
 * typing the address ("none") are let through. A request without the header (an old browser, a test) passes.
 */
export function refuseCrossSite(request: Request): NextResponse | null {
  const site = request.headers.get("sec-fetch-site");
  if (site == null || site === "same-origin" || site === "none") return null;
  return NextResponse.json({ error: "This page can only be opened from the study site itself." }, { status: 403 });
}
