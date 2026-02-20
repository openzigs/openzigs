// Server-side rewrite target: always the local backend.
// Uses OPENZIGS_INTERNAL_API if set, otherwise defaults to localhost:3000.
// Intentionally does NOT read NEXT_PUBLIC_OPENZIGS_API_BASE to keep the
// server-side proxy independent of the client-side env var.
const internalApi = process.env.OPENZIGS_INTERNAL_API || "http://localhost:3000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prevent Next.js from stripping trailing slashes via 308 redirect.
  // Socket.IO requires /socket.io/ (with trailing slash); without this flag
  // the 308 redirect breaks Socket.IO polling through the rewrite proxy
  // (e.g. when guests connect via Cloudflare tunnel → Next.js → Express).
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${internalApi}/api/:path*`
      },
      // Socket.IO requires the trailing slash — the :path* rewrite strips it,
      // so add an explicit rule that preserves it for the root path.
      {
        source: "/socket.io/",
        destination: `${internalApi}/socket.io/`
      },
      {
        source: "/socket.io/:path*",
        destination: `${internalApi}/socket.io/:path*`
      },
      {
        source: "/peerjs/:path*",
        destination: `${internalApi}/peerjs/:path*`
      }
    ];
  }
};

export default nextConfig;
