import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRemoteNodesRouter,
  buildNodeView,
  readUserConfig,
  writeUserConfig,
} from "./admin-remote-nodes.js";

let configPath: string;
let app: express.Express;

async function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => srv.close() });
    });
  });
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "admin-rn-"));
  configPath = path.join(dir, "config.json");
});

afterEach(async () => {
  try {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

// Fake DNS resolver: returns a public IP for example.com hosts and the
// literal RFC1918 address for 192.168.* hosts. Avoids real DNS in sandbox.
const fakeResolver = async (host: string) => {
  if (host.includes("192.168")) return [{ address: host, family: 4 }];
  return [{ address: "203.0.113.10", family: 4 }];
};

function buildApp(opts: { fetchImpl?: typeof fetch } = {}) {
  app = express();
  app.use(express.json());
  app.use(
    "/remote-nodes",
    createRemoteNodesRouter({
      configPath,
      fetchImpl: opts.fetchImpl,
      dnsResolver: fakeResolver,
    }),
  );
}

describe("buildNodeView", () => {
  it("returns empty url + masked token=false when nothing saved", () => {
    const v = buildNodeView("image-gen", {});
    expect(v).toEqual({
      nodeType: "image-gen",
      configKey: "imageGen",
      defaultPort: 5005,
      url: "",
      hasToken: false,
      tokenMask: "",
      allowLan: false,
    });
  });

  it("masks tokens and surfaces allowLan", () => {
    const v = buildNodeView("video-gen", {
      videoGen: {
        networkNodeUrl: "https://video.example.com",
        networkNodeToken: "supersecret",
        allowLan: true,
      },
    });
    expect(v.url).toBe("https://video.example.com");
    expect(v.hasToken).toBe(true);
    expect(v.tokenMask).toBe("••••••••");
    expect(v.allowLan).toBe(true);
  });
});

describe("createRemoteNodesRouter", () => {
  it("GET / lists every supported node", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/`);
    const body = (await r.json()) as { nodes: Array<{ nodeType: string }> };
    close();
    expect(body.nodes.map((n) => n.nodeType).sort()).toEqual(
      [
        "audio",
        "image-gen",
        "lip-sync",
        "music-gen",
        "rvc",
        "sad-talker",
        "video-gen",
      ].sort(),
    );
  });

  it("GET /:nodeType returns 404 for unknown type", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/bogus`);
    close();
    expect(r.status).toBe(404);
  });

  it("PUT /:nodeType saves a public URL with a token", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://images.example.com",
        token: "tok-123",
        allowLan: false,
      }),
    });
    const body = (await r.json()) as Record<string, unknown>;
    close();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    const cfg = await readUserConfig(configPath);
    const ig = cfg.imageGen as Record<string, unknown>;
    expect(ig.networkNodeUrl).toBe("https://images.example.com");
    expect(ig.networkNodeToken).toBe("tok-123");
    expect(ig.allowLan).toBe(false);
  });

  it("PUT /:nodeType rejects loopback URL with ssrf_blocked", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:5005" }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("ssrf_blocked");
  });

  it("PUT /:nodeType rejects RFC1918 URL when allowLan=false", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://192.168.68.60:5005",
        allowLan: false,
      }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("lan_not_allowed");
  });

  it("PUT /:nodeType accepts RFC1918 URL when allowLan=true", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://192.168.68.60:5005",
        allowLan: true,
      }),
    });
    close();
    expect(r.status).toBe(200);
    const cfg = await readUserConfig(configPath);
    expect((cfg.imageGen as Record<string, unknown>).allowLan).toBe(true);
  });

  it("PUT /:nodeType rejects non-http URL with 400", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://example.com" }),
    });
    close();
    expect(r.status).toBe(400);
  });

  it("PUT /:nodeType rejects oversized token with 400 token_too_long", async () => {
    buildApp();
    const { port, close } = await listen();
    const oversized = "a".repeat(4097);
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://images.example.com",
        token: oversized,
      }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("token_too_long");
    const cfg = await readUserConfig(configPath);
    expect(cfg.imageGen).toBeUndefined();
  });

  it("PUT /:nodeType rejects oversized URL with 400 url_too_long", async () => {
    buildApp();
    const { port, close } = await listen();
    const oversizedUrl = `https://images.example.com/${"a".repeat(4097)}`;
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: oversizedUrl }),
    });
    const body = (await r.json()) as { error: string };
    close();
    expect(r.status).toBe(400);
    expect(body.error).toBe("url_too_long");
    const cfg = await readUserConfig(configPath);
    expect(cfg.imageGen).toBeUndefined();
  });

  it("DELETE /:nodeType clears saved fields", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://x.example.com",
        networkNodeToken: "t",
        allowLan: true,
      },
    });
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(`http://127.0.0.1:${port}/remote-nodes/image-gen`, {
      method: "DELETE",
    });
    close();
    expect(r.status).toBe(200);
    const cfg = await readUserConfig(configPath);
    const ig = cfg.imageGen as Record<string, unknown>;
    expect(ig.networkNodeUrl).toBeUndefined();
    expect(ig.networkNodeToken).toBeUndefined();
    expect(ig.allowLan).toBeUndefined();
  });

  it("POST /:nodeType/test probes /health and /capabilities", async () => {
    await writeUserConfig(configPath, {
      imageGen: {
        networkNodeUrl: "https://probe.example.com",
        networkNodeToken: "tok",
        allowLan: false,
      },
    });
    const calls: string[] = [];
    const initOptions: RequestInit[] = [];
    const fakeFetch: typeof fetch = (async (
      input: unknown,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push(url);
      initOptions.push(init ?? {});
      const body = url.endsWith("/health")
        ? { status: "ok" }
        : { models: ["flux-dev"] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = (await r.json()) as {
      health: { ok: boolean };
      capabilities: { ok: boolean };
    };
    close();
    expect(r.status).toBe(200);
    expect(body.health.ok).toBe(true);
    expect(body.capabilities.ok).toBe(true);
    expect(calls).toEqual([
      "https://probe.example.com/health",
      "https://probe.example.com/capabilities",
    ]);
    expect(initOptions.map((init) => init.redirect)).toEqual([
      "manual",
      "manual",
    ]);
  });

  it("POST /:nodeType/test caps oversized probe responses", async () => {
    await writeUserConfig(configPath, {
      imageGen: { networkNodeUrl: "https://large.example.com" },
    });
    const fakeFetch: typeof fetch = (async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      })) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = (await r.json()) as {
      health: { ok: boolean; error?: string };
      capabilities: { ok: boolean; error?: string };
    };
    close();
    expect(body.health.ok).toBe(false);
    expect(body.health.error).toContain("response too large");
    expect(body.capabilities.ok).toBe(false);
    expect(body.capabilities.error).toContain("response too large");
  });

  it("POST /:nodeType/test returns 400 when no URL configured", async () => {
    buildApp();
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    close();
    expect(r.status).toBe(400);
  });

  it("POST /:nodeType/test reports per-endpoint error when fetch fails", async () => {
    await writeUserConfig(configPath, {
      imageGen: { networkNodeUrl: "https://broken.example.com" },
    });
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    buildApp({ fetchImpl: fakeFetch });
    const { port, close } = await listen();
    const r = await fetch(
      `http://127.0.0.1:${port}/remote-nodes/image-gen/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = (await r.json()) as {
      health: { ok: boolean; error?: string };
      capabilities: { ok: boolean; error?: string };
    };
    close();
    expect(body.health.ok).toBe(false);
    expect(body.health.error).toContain("ECONNREFUSED");
    expect(body.capabilities.ok).toBe(false);
  });
});
