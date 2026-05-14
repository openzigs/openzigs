/**
 * Issue #1092 — Admin API for Remote Media Worker Nodes (Cloudflare Tunnel).
 *
 * Single source of truth for `/api/admin/remote-nodes/*` routes used by the
 * UI Remote Nodes panel. Decoupled from the giant admin.ts router so this
 * domain has its own tests + clear surface area.
 *
 * Endpoints (mounted at /api/admin/remote-nodes):
 *   GET  /                  — list every supported node + status
 *   GET  /:nodeType         — single node config (token masked)
 *   PUT  /:nodeType         — save url/token/allowLan (validated via SSRF guard)
 *   POST /:nodeType/test    — probe /health + /capabilities
 *   DELETE /:nodeType       — clear the remote URL (reset to local)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RESOLVABLE_NODE_TYPES,
  NODE_SPEC,
  type ResolvableNodeType,
} from "../queue/node-config-resolver.js";
import {
  validateNodeUrl,
  SsrfBlockedError,
  LanNotAllowedError,
} from "../queue/url-validator.js";
import { logger } from "../logging/logger.js";

const TOKEN_MASK = "••••••••";

const MAX_TOKEN_LENGTH = 4096;
const MAX_URL_LENGTH = 4096;
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedProbeResponse(
  response: globalThis.Response,
  maxBytes = MAX_PROBE_RESPONSE_BYTES,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`response too large (>${maxBytes} bytes)`);
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    const value = chunk.value;
    if (done || !value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response too large (>${maxBytes} bytes)`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export function defaultConfigPath(): string {
  return (
    process.env.OPENZIGS_CONFIG_PATH ??
    path.join(os.homedir(), ".openzigs", "config.json")
  );
}

export async function readUserConfig(
  configPath: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return {};
    }
    throw e;
  }
}

export async function writeUserConfig(
  configPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function isResolvableNodeType(s: string): s is ResolvableNodeType {
  return (RESOLVABLE_NODE_TYPES as readonly string[]).includes(s);
}

interface NodeView {
  nodeType: ResolvableNodeType;
  configKey: string;
  defaultPort: number;
  url: string;
  hasToken: boolean;
  tokenMask: string;
  allowLan: boolean;
}

export function buildNodeView(
  nodeType: ResolvableNodeType,
  userConfig: Record<string, unknown>,
): NodeView {
  const spec = NODE_SPEC[nodeType];
  const ns = (userConfig[spec.configKey] ?? {}) as Record<string, unknown>;
  const url = typeof ns.networkNodeUrl === "string" ? ns.networkNodeUrl : "";
  const token =
    typeof ns.networkNodeToken === "string" ? ns.networkNodeToken : "";
  const allowLan = ns.allowLan === true;
  return {
    nodeType,
    configKey: spec.configKey,
    defaultPort: spec.defaultPort,
    url,
    hasToken: token.length > 0,
    tokenMask: token ? TOKEN_MASK : "",
    allowLan,
  };
}

export interface RemoteNodesRouterOptions {
  configPath?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Optional DNS resolver injected for tests (avoids real DNS during
   * SSRF validation). Must mimic `dns.promises.lookup(host, {all:true})`.
   */
  dnsResolver?: (
    host: string,
  ) => Promise<{ address: string; family: number }[]>;
}

export function createRemoteNodesRouter(
  options: RemoteNodesRouterOptions = {},
): Router {
  const router = Router();
  const cfgPath = options.configPath ?? defaultConfigPath();
  const f = options.fetchImpl ?? fetch;
  const resolver = options.dnsResolver;

  router.get("/", async (_req: Request, res: Response) => {
    try {
      const cfg = await readUserConfig(cfgPath);
      const nodes = RESOLVABLE_NODE_TYPES.map((n) => buildNodeView(n, cfg));
      return res.json({ nodes });
    } catch (e) {
      logger.error("[remote-nodes] list failed", e);
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/:nodeType", async (req: Request, res: Response) => {
    const nodeType = req.params.nodeType;
    if (!isResolvableNodeType(nodeType)) {
      return res.status(404).json({ error: "unknown_node_type" });
    }
    try {
      const cfg = await readUserConfig(cfgPath);
      return res.json(buildNodeView(nodeType, cfg));
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/:nodeType", async (req: Request, res: Response) => {
    const nodeType = req.params.nodeType;
    if (!isResolvableNodeType(nodeType)) {
      return res.status(404).json({ error: "unknown_node_type" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.trim() : undefined;
    const token =
      typeof body.token === "string" ? body.token.trim() : undefined;
    const allowLan = body.allowLan === true;

    if (
      typeof body.token === "string" &&
      body.token.length > MAX_TOKEN_LENGTH
    ) {
      return res.status(400).json({
        error: "token_too_long",
        message: `token must be <= ${MAX_TOKEN_LENGTH} characters`,
      });
    }
    if (typeof body.url === "string" && body.url.length > MAX_URL_LENGTH) {
      return res.status(400).json({
        error: "url_too_long",
        message: `url must be <= ${MAX_URL_LENGTH} characters`,
      });
    }

    if (url !== undefined && url.length > 0) {
      if (!/^https?:\/\/.+/.test(url)) {
        return res
          .status(400)
          .json({ error: "url must be a valid HTTP(S) URL" });
      }
      try {
        await validateNodeUrl(url, { allowLan, resolver });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          return res.status(400).json({
            error: "ssrf_blocked",
            message: err.message,
          });
        }
        if (err instanceof LanNotAllowedError) {
          return res.status(400).json({
            error: "lan_not_allowed",
            message:
              "URL points to a private network. Enable 'Allow LAN' to use it.",
          });
        }
        throw err;
      }
    }

    try {
      const cfg = await readUserConfig(cfgPath);
      const spec = NODE_SPEC[nodeType];
      const existing = (cfg[spec.configKey] ?? {}) as Record<string, unknown>;
      const updated: Record<string, unknown> = { ...existing };
      if (url !== undefined) updated.networkNodeUrl = url;
      if (token !== undefined && token.length > 0) {
        updated.networkNodeToken = token;
      }
      updated.allowLan = allowLan;
      cfg[spec.configKey] = updated;
      await writeUserConfig(cfgPath, cfg);
      logger.info(
        `[remote-nodes] updated ${nodeType} url=${url ? "(set)" : "(unchanged)"} allowLan=${allowLan}`,
      );
      return res.json({ ok: true, ...buildNodeView(nodeType, cfg) });
    } catch (e) {
      logger.error(`[remote-nodes] save ${nodeType} failed`, e);
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/:nodeType", async (req: Request, res: Response) => {
    const nodeType = req.params.nodeType;
    if (!isResolvableNodeType(nodeType)) {
      return res.status(404).json({ error: "unknown_node_type" });
    }
    try {
      const cfg = await readUserConfig(cfgPath);
      const spec = NODE_SPEC[nodeType];
      const existing = (cfg[spec.configKey] ?? {}) as Record<string, unknown>;
      delete existing.networkNodeUrl;
      delete existing.networkNodeToken;
      delete existing.allowLan;
      cfg[spec.configKey] = existing;
      await writeUserConfig(cfgPath, cfg);
      logger.info(`[remote-nodes] cleared ${nodeType}`);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/:nodeType/test", async (req: Request, res: Response) => {
    const nodeType = req.params.nodeType;
    if (!isResolvableNodeType(nodeType)) {
      return res.status(404).json({ error: "unknown_node_type" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.token === "string" &&
      body.token.length > MAX_TOKEN_LENGTH
    ) {
      return res.status(400).json({
        error: "token_too_long",
        message: `token must be <= ${MAX_TOKEN_LENGTH} characters`,
      });
    }
    if (typeof body.url === "string" && body.url.length > MAX_URL_LENGTH) {
      return res.status(400).json({
        error: "url_too_long",
        message: `url must be <= ${MAX_URL_LENGTH} characters`,
      });
    }
    const cfg = await readUserConfig(cfgPath);
    const view = buildNodeView(nodeType, cfg);
    const url =
      (typeof body.url === "string" && body.url.trim()) || view.url || "";
    const token =
      (typeof body.token === "string" && body.token.trim()) ||
      ((cfg[NODE_SPEC[nodeType].configKey] ?? {}) as Record<string, unknown>)
        .networkNodeToken;
    const allowLan =
      typeof body.allowLan === "boolean" ? body.allowLan : view.allowLan;

    if (!url) {
      return res.status(400).json({ error: "no_url_configured" });
    }

    try {
      await validateNodeUrl(url, { allowLan, resolver });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return res
          .status(400)
          .json({ error: "ssrf_blocked", message: err.message });
      }
      if (err instanceof LanNotAllowedError) {
        return res
          .status(400)
          .json({ error: "lan_not_allowed", message: err.message });
      }
      throw err;
    }

    const headers: Record<string, string> = {};
    if (typeof token === "string" && token.length > 0) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const base = url.replace(/\/$/, "");

    const out: {
      health: { ok: boolean; status?: number; data?: unknown; error?: string };
      capabilities: {
        ok: boolean;
        status?: number;
        data?: unknown;
        error?: string;
      };
    } = {
      health: { ok: false },
      capabilities: { ok: false },
    };

    try {
      const r = await f(`${base}/health`, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      out.health.status = r.status;
      out.health.data = await readBoundedProbeResponse(r);
      out.health.ok = r.ok;
    } catch (e) {
      out.health.error = (e as Error).message;
    }

    try {
      const r = await f(`${base}/capabilities`, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      out.capabilities.status = r.status;
      out.capabilities.data = await readBoundedProbeResponse(r);
      out.capabilities.ok = r.ok;
    } catch (e) {
      out.capabilities.error = (e as Error).message;
    }

    return res.json({ url: base, ...out });
  });

  return router;
}
