/**
 * Dev proxy that sits in front of `next dev` and adds WebSocket upgrade routing.
 *
 * Next.js rewrites handle HTTP requests fine, but they do NOT proxy WebSocket
 * upgrade requests.  Socket.IO survives because it falls back to HTTP long-
 * polling, but PeerJS requires WebSocket signaling and has no fallback.
 *
 * Architecture:
 *   Browser → :3001 (this proxy)
 *     ├─ HTTP *         → :NEXT_PORT (next dev)
 *     ├─ WS /socket.io  → :3000 (Express backend)
 *     ├─ WS /peerjs     → :3000 (Express backend)
 *     └─ WS /_next/*    → :NEXT_PORT (HMR)
 *
 * Zero new runtime dependencies — uses raw Node.js TCP pipes.
 */
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";

const PROXY_PORT = parseInt(process.env.PORT || "3001", 10);
const NEXT_PORT = PROXY_PORT + 100; // e.g. 3101
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = parseInt(
  new URL(process.env.OPENZIGS_INTERNAL_API || "http://localhost:3000").port || "3000",
  10,
);

// ── 1. Start `next dev` on the internal port ──
const nextProc = spawn("npx", ["next", "dev", "--port", String(NEXT_PORT)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, PORT: String(NEXT_PORT) },
});
nextProc.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => { nextProc.kill("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { nextProc.kill("SIGTERM"); process.exit(0); });

// Wait for Next.js to be ready
await new Promise((resolve) => {
  const check = () => {
    const req = httpRequest({ hostname: "127.0.0.1", port: NEXT_PORT, path: "/", method: "HEAD", timeout: 1000 }, () => resolve(undefined));
    req.on("error", () => setTimeout(check, 500));
    req.end();
  };
  setTimeout(check, 2000);
});

// ── 2. Reverse proxy server ──
const proxy = createServer((req, res) => {
  const pathname = (req.url ?? "").split("?")[0];

  // Route /api/*, /socket.io/, and /peerjs/ directly to the Express backend,
  // bypassing Next.js rewrites.  This avoids two problems:
  //  1. Next.js's internal http-proxy has a ~2-minute default timeout which
  //     kills long-running endpoints like /api/admin/director/produce.
  //  2. When the backend is down, Next.js's rewrite proxy logs noisy
  //     ECONNREFUSED stack traces for every Socket.IO poll.  Routing here
  //     instead returns a clean 502.
  const isBackendRoute =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/socket.io") ||
    pathname.startsWith("/peerjs");
  const targetPort = isBackendRoute ? BACKEND_PORT : NEXT_PORT;
  const targetHost = isBackendRoute ? BACKEND_HOST : "127.0.0.1";

  const proxyReq = httpRequest(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
      // Disable timeout for backend routes — endpoints like /produce run for 10+ min
      timeout: isBackendRoute ? 0 : 120_000,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  // Also disable socket timeout on the client side for long backend requests
  if (isBackendRoute) {
    req.socket.setTimeout(0);
    res.setTimeout(0);
  }
  proxyReq.on("error", (err) => {
    // Only log non-ECONNREFUSED errors — backend being down during dev is
    // normal (e.g. restarting) and Socket.IO polls retry automatically.
    if (err.code !== "ECONNREFUSED") {
      console.error(`Proxy error for ${String(req.url)}: ${err.message}`);
    }
    if (!res.headersSent) res.writeHead(502).end("Bad Gateway");
  });
  req.pipe(proxyReq);
});

/**
 * Pipe a WebSocket upgrade via raw TCP to the given target.
 */
function pipeUpgrade(req, socket, head, targetHost, targetPort) {
  const backend = connect(targetPort, targetHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    backend.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length > 0) backend.write(head);
    socket.pipe(backend);
    backend.pipe(socket);
  });
  backend.on("error", () => socket.destroy());
  socket.on("error", () => backend.destroy());
}

proxy.on("upgrade", (req, socket, head) => {
  const pathname = (req.url ?? "").split("?")[0];

  if (pathname.startsWith("/socket.io") || pathname.startsWith("/peerjs")) {
    // Route to Express backend
    pipeUpgrade(req, socket, head, BACKEND_HOST, BACKEND_PORT);
  } else {
    // Route to Next.js (HMR at /_next/webpack-hmr, etc.)
    pipeUpgrade(req, socket, head, "127.0.0.1", NEXT_PORT);
  }
});

proxy.listen(PROXY_PORT, () => {
  console.log(
    `> Proxy listening on http://localhost:${PROXY_PORT}` +
    `  (Next.js :${NEXT_PORT}, Express :${BACKEND_PORT})`,
  );
});
