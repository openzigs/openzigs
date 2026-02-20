import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE || "http://localhost:3000";

/**
 * Proxy invite-redeem to the Express backend which holds the signing secret,
 * then set cookies on the Next.js origin so middleware can read them.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token parameter" }, { status: 400 });
  }

  try {
    // Forward to Express backend for JWT verification
    const backendRes = await fetch(
      `${API_BASE}/api/invite/redeem?token=${encodeURIComponent(token)}`,
    );

    if (!backendRes.ok) {
      const body = await backendRes.json().catch(() => ({ error: "Invalid invite link" }));
      return NextResponse.json(body, { status: backendRes.status });
    }

    const { presentationId } = (await backendRes.json()) as { presentationId: string };

    // Decode JWT payload (no crypto needed — backend already verified)
    const payloadB64 = token.split(".")[1] ?? "";
    let maxAge = 86400; // fallback 24h
    try {
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as { exp?: number };
      if (payload.exp) maxAge = Math.max(payload.exp - Math.floor(Date.now() / 1000), 0);
    } catch { /* use fallback */ }

    const isSecure = request.nextUrl.protocol === "https:";
    const response = NextResponse.json({ presentationId });

    // Set cookies on the Next.js origin so middleware can read them
    response.cookies.set("guest_token", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge,
      secure: isSecure,
    });
    response.cookies.set("is_guest", "true", {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge,
      secure: isSecure,
    });

    return response;
  } catch {
    return NextResponse.json({ error: "Invalid or expired invite link" }, { status: 401 });
  }
}
