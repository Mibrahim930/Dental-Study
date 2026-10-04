import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, passcodeToken } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  const passcode = process.env.APP_PASSCODE;
  if (!passcode) return NextResponse.next(); // no passcode set: open access (local use)
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (token && token === (await passcodeToken(passcode))) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!login|api/login|_next/static|_next/image|favicon.ico).*)"],
};
