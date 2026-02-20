// Server-side rewrite target: always the local backend, even when
// NEXT_PUBLIC_OPENZIGS_API_BASE is empty (same-origin mode for remote guests).
const internalApi = process.env.OPENZIGS_INTERNAL_API
  || process.env.NEXT_PUBLIC_OPENZIGS_API_BASE
  || "http://localhost:3000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${internalApi}/api/:path*`
      },
      {
        source: "/socket.io/:path*",
        destination: `${internalApi}/socket.io/:path*`
      }
    ];
  }
};

export default nextConfig;
