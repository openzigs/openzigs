// ─────────────────────────────────────────────────────────────────────────────
// DEV ONLY — DO NOT RUN ON SHARED NETWORKS
// ─────────────────────────────────────────────────────────────────────────────
// Tiny HTTP proxy that logs request paths/bodies and forwards them to a local
// Ollama instance. Useful for inspecting what the agent sends to the model.
//
// Hardening (sub-issue #906):
//  • Binds to 127.0.0.1 only — never reachable from another host.
//  • Requires a bearer token via the OPENZIGS_DEBUG_PROXY_TOKEN env var.
//    Requests without a matching `Authorization: Bearer <token>` header are
//    rejected with 401 before the body is read or logged.
//  • Logs are written next to the script under `proxy-requests.log` and are
//    `.gitignore`d.
//
// Usage:
//   $env:OPENZIGS_DEBUG_PROXY_TOKEN = "some-long-random-string"
//   node scripts/dev/debug-proxy.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OLLAMA_HOST = process.env.OPENZIGS_DEBUG_PROXY_TARGET_HOST ?? "127.0.0.1";
const OLLAMA_PORT = Number(process.env.OPENZIGS_DEBUG_PROXY_TARGET_PORT ?? 11434);
const PROXY_PORT = Number(process.env.OPENZIGS_DEBUG_PROXY_PORT ?? 11435);
const PROXY_BIND = "127.0.0.1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, "proxy-requests.log");

const expectedToken = process.env.OPENZIGS_DEBUG_PROXY_TOKEN ?? "";
if (!expectedToken) {
  console.error(
    "OPENZIGS_DEBUG_PROXY_TOKEN is required. Set a long random string before " +
      "starting the proxy. Example:\n" +
      '  $env:OPENZIGS_DEBUG_PROXY_TOKEN = "..."\n' +
      "  node scripts/dev/debug-proxy.mjs",
  );
  process.exit(1);
}

// Clear log file
fs.writeFileSync(LOG_FILE, "");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

function isAuthorized(req) {
  const header = req.headers["authorization"] ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    log(`!!! Unauthorized ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  log(`>>> ${req.method} ${req.url}`);

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (body) {
      // Log just the first 200 chars of body to keep log small
      log(`    Body (${body.length} bytes): ${body.substring(0, 200)}`);
    }

    const upstreamHeaders = { ...req.headers, host: `${OLLAMA_HOST}:${OLLAMA_PORT}` };
    // Strip the debug-proxy auth header before forwarding so Ollama doesn't
    // see (or log) our local credential.
    delete upstreamHeaders["authorization"];

    const proxyReq = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders,
      },
      (proxyRes) => {
        log(`<<< ${proxyRes.statusCode} ${req.method} ${req.url}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      log(`!!! Proxy error: ${err.message}`);
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PROXY_PORT, PROXY_BIND, () => {
  log(
    `Proxy listening on ${PROXY_BIND}:${PROXY_PORT}, ` +
      `forwarding to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}`,
  );
});
