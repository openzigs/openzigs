import { jwtVerify } from "jose";
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
  "/peerjs",
  "/_next/",
  "/favicon.ico",
];

/** Paths that guests may access but scoped to their specific presentation. */
const GUEST_SCOPED_PREFIXES = [
  "/api/presentations/",
  "/api/files/",
];

/**
 * Verify a guest JWT using the shared PRESENTER_INVITE_SECRET.
 * Returns the decoded payload on success, or null if the token is invalid or expired.
 */
async function verifyGuestToken(
  token: string,
): Promise<{ presentationId?: string; exp?: number } | null> {
  const secret = process.env.PRESENTER_INVITE_SECRET;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { algorithms: ["HS256"] },
    );
    return payload as { presentationId?: string; exp?: number };
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const guestToken = request.cookies.get("guest_token")?.value;

  // Helper: inject the Authorization header for API requests proxied via
  // rewrites. Browser-native elements (<img>, <video>) can't add custom
  // headers, so the middleware injects the token server-side before the
  // rewrite forwards to Express.
  const authToken = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN;

  // Helper: return NextResponse.next() with Authorization header injected
  // for API requests that don't already have one.
  function nextWithAuth(): NextResponse {
    if (authToken && pathname.startsWith("/api/") && !request.headers.get("authorization")) {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${authToken}`);
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }

  // No guest cookie → admin/normal flow; allow through
  if (!guestToken) {
    return nextWithAuth();
  }

  const payload = await verifyGuestToken(guestToken);
  if (!payload) {
    const response = NextResponse.redirect(new URL("/invite-expired", request.url));
    response.cookies.delete("guest_token");
    response.cookies.delete("is_guest");
    return response;
  }

  // Check non-scoped allowed paths
  for (const prefix of GUEST_ALLOWED_PREFIXES) {
    if (pathname.startsWith(prefix) || pathname === prefix.replace(/\/$/, "")) {
      return nextWithAuth();
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
            return nextWithAuth();
          }
        }
        // For /api/files/serve, allow (video file serving is path-based, not id-based)
        if (prefix === "/api/files/") {
          return nextWithAuth();
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
