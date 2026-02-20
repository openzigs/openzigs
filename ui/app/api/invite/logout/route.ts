import { NextResponse } from "next/server";

/** Clear guest cookies — used by the host to remove stale guest tokens. */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("guest_token");
  response.cookies.delete("is_guest");
  return response;
}
