import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, gateOk, SESSION_COOKIE, sessionUserId } from "@/lib/auth";

// Pages reachable with only the site passcode (before having an account).
const ACCOUNT_PATHS = ["/account", "/api/account/signin", "/api/account/signup", "/help/api-keys"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const deny = (to: string) =>
    isApi ? NextResponse.json({ error: "Please sign in again." }, { status: 401 }) : NextResponse.redirect(new URL(to, request.url));

  if (!gateOk(request.cookies.get(GATE_COOKIE)?.value)) return deny("/login");
  if (ACCOUNT_PATHS.includes(pathname)) return NextResponse.next();
  if (!sessionUserId(request.cookies.get(SESSION_COOKIE)?.value)) return deny("/account");
  return NextResponse.next();
}

export const config = {
  // api/ics is the calendar feed: Google/Apple fetch it with a secret token instead of cookies.
  // The app icons and manifest are public so the browser tab and home-screen icon work before signing in.
  matcher: ["/((?!login|api/login|api/ics|_next/static|_next/image|favicon.ico|icon.svg|apple-icon|manifest.webmanifest).*)"],
};
