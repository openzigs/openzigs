// Tiny HTTP proxy that logs request paths to a file, then proxies to Ollama
import http from 'http';
import fs from 'fs';

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;
const PROXY_PORT = 11435;
const LOG_FILE = 'C:/Users/mgbre/Development/openzigs/proxy-requests.log';

// Clear log file
fs.writeFileSync(LOG_FILE, '');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

const server = http.createServer((req, res) => {
  log(`>>> ${req.method} ${req.url}`);

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    if (body) {
      // Log just the first 200 chars of body to keep log small
      log(`    Body (${body.length} bytes): ${body.substring(0, 200)}`);
    }

    // Proxy to Ollama
    const proxyReq = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${OLLAMA_HOST}:${OLLAMA_PORT}` },
    }, proxyRes => {
      log(`<<< ${proxyRes.statusCode} ${req.method} ${req.url}`);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      log(`!!! Proxy error: ${err.message}`);
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PROXY_PORT, () => {
  log(`Proxy listening on ${PROXY_PORT}, forwarding to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}`);
});
