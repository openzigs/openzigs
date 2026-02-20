import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Paths that guests ARE allowed to access (without presentation scoping). */
const GUEST_ALLOWED_PREFIXES = [
  "/room/",
  "/presenter/",
  "/invite/",
  "/invite-expired",
  "/403",
  "/api/invite/",
  "/socket.io",
  "/_next/",
  "/favicon.ico",
];

/** Paths that guests may access but scoped to their specific presentation. */
const GUEST_SCOPED_PREFIXES = [
  "/api/presentations/",
  "/api/files/",
];

/**
 * Decode JWT payload (base64url) and return claims.
 * No cryptographic verification — the token was verified at redeem time
 * and cookies expire on the same schedule.
 */
function decodeGuestToken(token: string): { presentationId?: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      presentationId?: string;
      exp?: number;
    };
  } catch {
    return null;
  }
}

function isTokenExpired(payload: { exp?: number }): boolean {
  if (!payload.exp) return false;
  return payload.exp < Math.floor(Date.now() / 1000);
}

export async function middleware(request: NextRequest) {
  const guestToken = request.cookies.get("guest_token")?.value;

  // No guest cookie → admin/normal flow; allow through
  if (!guestToken) {
    return NextResponse.next();
  }

  const payload = decodeGuestToken(guestToken);
  if (!payload) {
    const response = NextResponse.redirect(new URL("/invite-expired", request.url));
    response.cookies.delete("guest_token");
    response.cookies.delete("is_guest");
    return response;
  }

  // Guest cookie present → check expiry
  if (isTokenExpired(payload)) {
    const response = NextResponse.redirect(new URL("/invite-expired", request.url));
    response.cookies.delete("guest_token");
    response.cookies.delete("is_guest");
    return response;
  }

  const pathname = request.nextUrl.pathname;

  // Check non-scoped allowed paths
  for (const prefix of GUEST_ALLOWED_PREFIXES) {
    if (pathname.startsWith(prefix) || pathname === prefix.replace(/\/$/, "")) {
      return NextResponse.next();
    }
  }

  // Check scoped paths — guest can only access their specific presentation
  const guestPresentationId = payload.presentationId;
  if (guestPresentationId) {
    for (const prefix of GUEST_SCOPED_PREFIXES) {
      if (pathname.startsWith(prefix)) {
        // For /api/presentations/{id}... the id is the next path segment
        if (prefix === "/api/presentations/") {
          const afterPrefix = pathname.slice(prefix.length);
          const requestedId = afterPrefix.split("/")[0];
          if (requestedId === guestPresentationId) {
            return NextResponse.next();
          }
        }
        // For /api/files/serve, allow (video file serving is path-based, not id-based)
        if (prefix === "/api/files/") {
          return NextResponse.next();
        }
      }
    }
  }

  // Deny access to all other routes
  return NextResponse.rewrite(new URL("/403", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
