const apiBase = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`
      },
      {
        source: "/socket.io/:path*",
        destination: `${apiBase}/socket.io/:path*`
      }
    ];
  }
};

export default nextConfig;
