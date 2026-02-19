import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const INVITE_SECRET = process.env.PRESENTER_INVITE_SECRET ?? "";

/** Paths that guests ARE allowed to access. */
const GUEST_ALLOWED_PREFIXES = [
  "/room/",
  "/invite/",
  "/invite-expired",
  "/403",
  "/api/presentations/",
  "/api/invite/",
  "/socket.io",
  "/_next/",
  "/favicon.ico",
];

export async function middleware(request: NextRequest) {
  const guestToken = request.cookies.get("guest_token")?.value;

  // No guest cookie → admin flow (Bearer header); allow through
  if (!guestToken) {
    return NextResponse.next();
  }

  // Guest cookie present → validate JWT
  if (!INVITE_SECRET) {
    // No secret configured → cannot validate; clear cookie and redirect
    const response = NextResponse.redirect(new URL("/invite-expired", request.url));
    response.cookies.delete("guest_token");
    response.cookies.delete("is_guest");
    return response;
  }

  try {
    const secretKey = new TextEncoder().encode(INVITE_SECRET);
    await jwtVerify(guestToken, secretKey, { algorithms: ["HS256"] });
  } catch {
    // Invalid or expired token → clear cookies and redirect
    const response = NextResponse.redirect(new URL("/invite-expired", request.url));
    response.cookies.delete("guest_token");
    response.cookies.delete("is_guest");
    return response;
  }

  // Token is valid — enforce path restrictions
  const pathname = request.nextUrl.pathname;

  for (const prefix of GUEST_ALLOWED_PREFIXES) {
    if (pathname.startsWith(prefix) || pathname === prefix.replace(/\/$/, "")) {
      return NextResponse.next();
    }
  }

  // Deny access to all other routes
  return NextResponse.rewrite(new URL("/403", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
